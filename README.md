# 🎵 Workshop Jukebox

Guests open a link on their phones, search Spotify, and request songs. The laptop plays them on its speaker, first-come first-served. No logins, no app installs for guests.

## Event day (host)

1. On the laptop, open Spotify and press Play on anything once (this wakes the player).
2. Double-click `start-jukebox.bat`. A public link + QR code appears in the terminal.
3. Show the QR / link to the room. Open `/display` on the projector for a big Now Playing screen.
4. Open the `/admin` link on your own phone or laptop tab (PIN in `server/.env`, or tap "Host? Open admin" at the bottom of the guest page). From there you can Skip, Pause, Warm up the player, set Volume, pick the playback Device, toggle Explicit songs, and Clear the queue.
5. The link changes every restart — reshare the QR if you restart.

## For guests

- Open the link, search a song or artist, tap Request.
- You can have 2 songs waiting at a time, with a short cooldown between requests.
- Tap ✕ next to your own song to cancel it.

## First-time setup

- Install Bun (`powershell -c "irm bun.sh/install.ps1|iex"`), Node is no longer needed, plus `cloudflared` (`winget install --id Cloudflare.cloudflared`).
- Copy Spotify credentials: in `server/.env` set `SPOTIFY_CLIENT_ID` and `ADMIN_PIN`.
- In your Spotify developer app, add redirect URI `http://127.0.0.1:8888/callback`.
- Run once in `server/`: `bun install`, then `bun run auth` (one-time Spotify login).
- Run once in root: `bun install`. Build the site: `bun run build`.

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
| Web shows songs nobody requested ("Next up" recommendations) | Turn off Autoplay in the Spotify desktop app (queue panel toggle, or Settings → Playback). The API can't tell manual queues from autoplay apart, so the mirror needs it off to show only "Next in queue". |

## Good to know

- Fair queue: requests play in order; ETA shows under each of your songs.
- Explicit songs and over-long tracks can be blocked (`BLOCK_EXPLICIT`, `MAX_TRACK_MIN` in `server/.env`).
- Limits are per phone browser, so one person can't flood the queue from two tabs — but clearing site data resets them.
- Developers: see `AGENTS.md`.
