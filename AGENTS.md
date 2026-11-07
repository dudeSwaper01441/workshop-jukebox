# AGENTS.md

## What this is

Public song-request site for a school workshop with one speaker. Guests open a link (no login), search Spotify, and request songs. A Node server holding the owner's Spotify login keeps a fair first-come queue and plays it on the Spotify desktop app on the host laptop. A Cloudflare Quick Tunnel makes it reachable from phones.

Flow: phone → Cloudflare tunnel → Express (`server/server.js`) → Spotify Web API + local `spotify_cli` (Windows cold start) → Spotify desktop app (a Spotify Connect device).

## Layout

```
package.json, start.js, start-jukebox.bat   launcher: server + cloudflared, prints link and QR
server/server.js    Express API + queue logic (ESM, no build step)
server/auth.js      one-time Spotify login (PKCE), writes server/tokens.json
server/queue.json   persisted queue (written on every mutation, never commit)
server/.cli-path    cached spotify_cli path (auto-discovered, never commit)
server/.env         secrets and tuning (never commit)
web/                React + TypeScript (Vite react-ts template)
web/src/main.tsx    /admin -> Admin.tsx, /display -> Display.tsx, else Guest.tsx
web/src/api.tsx     types, api() fetch helper, useJukebox() polling hook, useTicker(), formatters
web/src/Display.tsx projector mode: big Now Playing + top-5 Up Next, no controls
web/src/index.css   all styles
```

## Commands

Root (run from `workshop-jukebox/`):

- `bun install` once (adds qrcode-terminal for the launcher)
- `bun run build` builds the web app into `web/dist`
- `bun start` starts the server and the tunnel, then prints the public link

Server (`server/`):

- `bun install` once
- `bun run auth` one-time Spotify login. Needs `http://127.0.0.1:8888/callback` in the Spotify app's redirect URIs
- `bun start` server only, on `http://localhost:3000` (admin at `/admin`, display at `/display`)
- `bun run dev` server only with auto-restart on file changes (`bun --watch`)

Web (`web/`):

- `bun run dev` Vite dev server; `/api` is proxied to `127.0.0.1:3000`, so the server must be running
- `bun run build` runs `tsc -b && vite build`. TypeScript errors fail the build
- `bun run --cwd web lint` runs `oxlint` (warnings only, 0 errors required)

For local dev, `bun run dev` (server, from `server/`) and `bun start.js --watch` (server + tunnel, from root) auto-restart the server via `bun --watch` — safe because the queue restores from `queue.json`. Production (`bun start`, `start-jukebox.bat`) has no watcher. After editing web code, run `bun run build`, because Express serves `web/dist` (or use `bun run dev` in `web/` for Vite HMR against a running server). `start-jukebox.bat` uses Bun with an npm fallback.

## Environment (`server/.env`)

`SPOTIFY_CLIENT_ID`, `ADMIN_PIN` (required). Optional: `PORT` (3000), `MAX_PENDING` (2), `COOLDOWN_SEC` (20), `MAX_TRACK_MIN` (7), `BLOCK_EXPLICIT` (1, startup default — admin can toggle at runtime via `POST /api/admin/explicit`), `DEVICE_NAME`, `SPOTIFY_CLI` (explicit CLI path, any OS), `VERBOSE` (0-3).

Bun 1.4+ is required (installed 1.4.2; lockfiles are `bun.lockb`). The dev machine is Windows.

## How playback works (do not break)

- Spotify's queue cannot be reordered or cleared through the API. The server keeps its own `queue` and sends the next request to Spotify about 20 seconds before the current song ends (`FEED_MS`). A request already sent (`inFlight`, `kind: 'queue'`) can only be skipped, not removed.
- Cold start (empty player) is the flaky path: `PUT /me/player/play` with `uris` is accepted (204) but often stays silent. On Windows the server plays via the Store app's bundled `spotify_cli` first (`issueStart` → `play <uri> [--device]`, transfer skipped via self-play fallback), falling back to the Web API. `findSpotifyCli()` discovers it via `SPOTIFY_CLI` env → cached `.cli-path` → `Get-AppxPackage` → folder scan. mac/Linux have no bundled CLI and use the Web API (`SPOTIFY_CLI` opts in).
- Play commands run inside `locked()` (fast, ~1s); verification polls outside it (`verifyStart`, 4x over ~8.5s, unmutes once if vol=0) so state polls and admin actions never stall. `inFlight` guards double-issuing; verify only clears `inFlight` if it still owns it. Silent failures set `startFailMsg` (attempt 1: "starting…", 2+: actionable) instead of a fake ETA; 3rd failure drops the song (`GAVE UP`).
- `POST /api/admin/warmup` resumes the last context on the target device so the next request uses the reliable queue+next path. For events, warm up once after launching the app.
- `POST /api/request` runs cheap checks (cooldown, pending limit, now/queue/recent duplicates) before the Spotify track fetch, so rejects skip ~300-500ms.
- `POST /api/admin/skip` settles (quick re-polls until the new track shows) before responding, so the UI doesn't lag a poll cycle; pause/resume do one refresh poll for the same reason.
- Guests can cancel their own pending request (`DELETE /api/queue/:id`, browser-id scoped, in-Spotify starts rejected). Admin delete stays PIN-gated.
- `403 Restriction violated` from Spotify is normal (pausing while paused, skipping with nothing next). It is mapped to a readable 409. Timeouts and network failures are mapped to 502 `Can't reach Spotify…` (never a raw DOMException dump, never masquerading as "no device"); `waitForDevices` bails fast on 502.
- Use `market=TH` for search and track lookups. Never use `market=from_token`; it needs the `user-read-private` scope.
- OAuth scopes: `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`. Adding a scope means rerunning `bun run auth`.
- Redirect URIs must use `127.0.0.1`, never `localhost`.
- Browsers never call Spotify. They poll `/api/state` (every 1s while music is playing/queued/waiting, 2.5s when fully idle, paused in hidden tabs) with `playerWaiting` / `playerError` / guest-safe `playerMessage`. The server polls Spotify every 1s. A Spotify 429 sets `blockedUntil` and returns 503 to guests.
- Live lyrics come from free community catalogs (`server/lyrics.js`), never Spotify — the public Web API has no lyrics endpoint. LRCLIB exact is tried first (best timing); on a miss, LRCLIB search + KuGou + QQ + NetEase + lyrics.ovh run in parallel and the best validated hit wins. Candidates are matched against Spotify metadata (Thai-safe title bigrams, artist, duration) because these APIs return wrong songs; Chinese/Thai credit lines and "Song - Artist" headers are stripped, `^` sub-lines and `<mm:ss>` tags still work. KuGou's search host is plain http (its https cert does not match the hostname). `GET /api/lyrics?uri=` caches hits/misses for 1h; provider outages are cached 10 min so a dead source gets retried. Metadata resolves from the session (now/queue/played), never client input.
- Cover color sampling loads through same-origin `GET /api/art?img=` (allowlisted to `i.scdn.co`, cached server-side) so the sampling canvas never taints, regardless of CDN CORS behavior.
- Songs queued directly in the Spotify app are mirrored via `GET /me/player/queue` (5s throttle, outside the playback lock) and exposed as `externalQueue` in `/api/state` (now-playing + internal uris filtered out). Request duplicates against it are rejected; a queued `inFlight` is kept across foreign songs so it isn't re-sent as a duplicate. Needs a server restart to activate. The laptop must have Autoplay off — the API mixes manual "Next in queue" with autoplay "Next up" and flags neither, so code cannot split them.

## Security and access rules

- Tunnel traffic arrives from `127.0.0.1`. Never treat an IP check alone as "local". `isLocalReq()` requires a loopback address and none of `cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `x-forwarded-host`.
- Localhost skips only the request cooldown and the pending-songs limit. Duplicate, length, and explicit checks still apply.
- Limits are per browser (random id in localStorage, sent as `x-client-id`), not per IP, because a tunnel makes everyone one IP.
- Admin routes need the `x-admin-pin` header (`pinOk`, timing-safe). Do not log the PIN or tokens, and do not show the admin QR to guests. The guest footer has a discreet "Host? Open admin" text link (PIN still required). Guest cancel is scoped by `x-client-id` and returns 404 for others' songs.
- The Spotify token stays on the server. Never send it to the browser or put keys in `web/`. This also rules out the Web Playback SDK: it needs the access token inside the page (plus the `streaming` scope), so browser playback would hand anyone with the tunnel link a working Spotify credential.
- Cloudflare Quick Tunnels do not support SSE, so use polling. The public URL changes on every restart. Tunnel port 3000, never the Vite dev server. `start.js` forces `--protocol http2` (QUIC/UDP gets throttled on event Wi-Fi → `no recent network activity`) and restarts a degraded-but-alive tunnel after 8 transport errors in 60s; benign client cancels never count.

## Conventions

- JavaScript on the server: ESM, 2 spaces, single quotes, no semicolons, async/await. Comments explain why, not what.
- Use `vlog(level, ...)` for optional logging. Keep the `PLAY:`, `AFTER:` (with device + volume), `DEVICES:`, `CLI:` logs.
- Error messages shown to guests must be short and friendly (`HttpError(status, message)`).
- Web: `verbatimModuleSyntax` is on, so use `import type` for types. Unused imports and locals fail `tsc`.
- UI stability: reserve space for status messages (`.slot`), keep banners out of the page flow (`.offline` is fixed), and keep countdowns anchored to a client clock (`useTicker` in `api.tsx`: 500ms while playing, 1s for cooldown-only). Do not resync them on every poll.
- TV layout sizing: `.signage-swap` and `.apmu-grid` use `minmax(0, …)` tracks with `min-width: 0` items, and long titles/lyrics get `overflow-wrap: anywhere`. An `auto` track sizes to max-content, so one long Thai lyric line widens the whole grid past the screen and clips the artwork. Lyrics keep scrolling but hide their scrollbar on TV.
- Fonts: system stack with Thai support (`Noto Sans Thai`, `Leelawadee UI`), no webfont downloads. Thai font selector for lyrics (`Auto` / `Noto Sans Thai` / `Leelawadee UI` / `Thonburi` / `Sarabun`) persists per browser in `localStorage` (`jb_thai_font`) and is toggled via a `font` button in TV signage controls + `/display` header.
- Do not add dependencies without a clear reason. The server has only `express`.

## Testing (manual, no automated tests)

1. Request 3+ songs from `http://localhost:3000`. There should be no cooldown and no 2-song limit.
2. Open the tunnel link on a phone using mobile data. The cooldown countdown and the 2-song limit must apply.
3. Let a song end on its own and confirm the next request starts without pressing anything.
4. In `/admin`, check Skip, Pause/Resume, Warm up, volume slider, device picker, Explicit toggle, Clear queue, and the Logs level.
5. Restart with Spotify idle to check the cold-start path (`PLAY: ... via CLI`, then `AFTER: true`).
6. Cancel your own song from the guest Up Next list; others' songs show no button.
7. Open `/display` for the projector check.
8. Restart the server with songs queued and confirm they are restored from `queue.json`.

## Known limits

Queue persists in `server/queue.json`; `recent` (the replay block), cooldown timestamps, `inFlight`, the device override, and the session stats (uptime, played list, real playing time) reset on restart. One Spotify account (Premium required). Per-browser limits can be bypassed by clearing site data. The bundled CLI path is Windows Store-only; mac/Linux use the Web API unless `SPOTIFY_CLI` is set.
