# 🎵 Workshop Jukebox

Guests open a link on their phones, search Spotify, and request songs. The laptop plays them on its speaker, first-come first-served. No logins, no app installs for guests.

## Event day (host)

1. On the laptop, open Spotify and press Play on anything once (this wakes the player).
2. Double-click `start-jukebox.bat`. A public link + QR code appears in the terminal. (Docker setup instead: `docker compose up --build`, then `docker compose logs tunnel` for the link.)
3. Show the QR / link to the room. Open `/display` on the projector for a big Now Playing screen — cover and live lyrics over a slowly moving color backdrop, with Lyrics / ApMu, Glow, and a Beat Listener in the nav.
4. Open the `/admin` link on your own phone or laptop tab (PIN in `server/.env`, or tap "Host? Open admin" at the bottom of the guest page). From there you can Skip, Pause, Warm up the player, set Volume, pick the playback Device, toggle Explicit songs, and Clear the queue.
5. The link changes every restart — reshare the QR if you restart.

## For guests

- Open the link, search a song or artist, tap Request.
- You can have 2 songs waiting at a time, with a short cooldown between requests.
- Tap ✕ next to your own song to cancel it.

## First-time setup (native)

- Install Bun (`powershell -c "irm bun.sh/install.ps1|iex"`), Node is no longer needed, plus `cloudflared` (`winget install --id Cloudflare.cloudflared`).
- Copy Spotify credentials: in `server/.env` set `SPOTIFY_CLIENT_ID` and `ADMIN_PIN`.
- In your Spotify developer app, add redirect URI `http://127.0.0.1:8888/callback`.
- Run once in `server/`: `bun install`, then `bun run auth` (one-time Spotify login).
- Run once in root: `bun install`. Build the site: `bun run build`.

## First-time setup (Docker)

Run the whole thing in containers — no Bun or `cloudflared` install needed for the event itself. The image builds the web app and runs the server; a Cloudflare Quick Tunnel sidecar publishes the public link. Only the one-time Spotify login below needs Bun on the host.

1. Do the one-time Spotify login **on the host** first — the OAuth callback is `127.0.0.1`, so it can't run inside the container. This step needs Bun: `cd server && bun install && bun run auth` → writes `server/tokens.json`. (Already ran it for the native setup? Reuse the same file and skip this.)
2. Set `SPOTIFY_CLIENT_ID` and `ADMIN_PIN` in `server/.env` (the compose file reads it), and make sure `http://127.0.0.1:8888/callback` is a redirect URI in your Spotify app if you re-run the login.
3. Make sure an empty `server/queue.json` exists (Docker would otherwise create a folder there, because it bind-mounts the file). If it's missing, create it first with `New-Item server/queue.json` — don't use `-Force`, which would empty an existing queue. Then start the stack:
   ```sh
   docker compose up --build
   ```
4. Copy the public link from the tunnel logs:
   ```sh
   docker compose logs tunnel   # https://<...>.trycloudflare.com
   ```
5. Stop it with `docker compose down`.

Notes:

- Needs Docker Compose v2.24+ (the compose file uses the newer `env_file` form).
- The container is Linux, so playback uses the Spotify **Web API** (the bundled Windows `spotify_cli` cold-start shortcut isn't available; set `SPOTIFY_CLI` if you have a CLI). Cold starts can be flaky this way — press Play in Spotify once and use Admin → Warm up.
- `server/tokens.json` is mounted read-only and `server/queue.json` is mounted so the queue survives restarts. All other settings (`DEVICE_NAME`, `MAX_PENDING`, `VERBOSE`, …) come from `server/.env`.
- Want the server only (your own tunnel)? Run `docker compose up jukebox`. Or build and run just the image (paste as one line):
  ```sh
  docker build -t workshop-jukebox .
  docker run -p 3000:3000 --env-file server/.env -v "$PWD/server/tokens.json:/app/server/tokens.json:ro" -v "$PWD/server/queue.json:/app/server/queue.json" workshop-jukebox
  ```

## Troubleshooting

| Symptom | Fix |
|---|---|
| First song won't start | Press Play once in the Spotify desktop app, then Admin → Warm up. The account must be Premium and match the one used for `bun run auth`. |
| "No Spotify device" | Open Spotify on the laptop; in Admin, Refresh devices and pick the laptop. |
| "Can't reach Spotify" (or devices empty even with the app open) | The laptop's internet path to Spotify is down — not the app, so reopening it won't help. Check Wi-Fi / hotspot, then wait for ticks to recover on their own. |
| No sound but progress moves | Check laptop volume and Admin → Volume slider. |
| "Searching too fast" | Wait a few seconds and search again. |
| Public link doesn't load / tunnel `Unauthorized: Tunnel not found` | The old tunnel ID was rejected — kill `cloudflared` and start a fresh one (the link changes, reshare the QR). Supervised runs (`bun start` / `bun dev`) now restart it automatically after 5 straight registration failures. |
| Page half-loads (unstyled / spinner) with tunnel `timeout: no recent network activity` | The tunnel's UDP (QUIC) transport is being throttled by the local network. The launcher now forces HTTP/2 and restarts a dead-but-alive tunnel automatically (the link changes, reshare the QR). If you run `cloudflared` by hand, add `--protocol http2`. |
| Queue disappeared after restart | The queue is restored automatically — check the terminal for restore errors. |
| Docker: container exits straight away | Almost always a missing `server/.env` or `server/tokens.json`. Run `bun run auth` on the host first, then read `docker compose logs jukebox`. |
| Docker: `server/queue.json` became a folder | Docker creates a directory when the file is missing at mount time. Delete the folder, create the file (`New-Item server/queue.json`), and start again. |
| Web shows songs nobody requested ("Next up" recommendations) | Turn off Autoplay in the Spotify desktop app (queue panel toggle, or Settings → Playback). The API can't tell manual queues from autoplay apart, so the mirror needs it off to show only "Next in queue". |

## Good to know

- Fair queue: requests play in order; ETA shows under each of your songs.
- Explicit songs and over-long tracks can be blocked (`BLOCK_EXPLICIT`, `MAX_TRACK_MIN` in `server/.env`).
- Limits are per phone browser, so one person can't flood the queue from two tabs — but clearing site data resets them.
- Two projector views: `/display` (open it directly, big artwork + fluid lyrics) and the TV signage (tap **Fullscreen** on the guest page's Now playing card, or open `/?tv=apmu`). Both share the backdrop, fluid lyrics, Glow, and Beat Listener; `/display` has an **ApMu** button that jumps straight to the TV ApMu layout.
- Developers: see `AGENTS.md`.
