import express from 'express'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { fetchLyrics } from './lyrics.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = process.env

// ---------- config ----------
const PORT = Number(env.PORT ?? 3000)
const CLIENT_ID = env.SPOTIFY_CLIENT_ID
const ADMIN_PIN = env.ADMIN_PIN
const DEVICE_NAME = env.DEVICE_NAME
// admin can pick a device in /admin, which overrides DEVICE_NAME until restart
let deviceIdOverride = null
const MAX_PENDING = Number(env.MAX_PENDING ?? 2) // songs one person can have waiting
const COOLDOWN_MS = Number(env.COOLDOWN_SEC ?? 20) * 1000
const MAX_TRACK_MIN = Number(env.MAX_TRACK_MIN ?? 7)
const MAX_TRACK_MS = MAX_TRACK_MIN * 60_000
let blockExplicit = (env.BLOCK_EXPLICIT ?? '1') === '1' // admin can toggle at runtime
const RECENT_LIMIT = 25 // block songs among the last N played
const FEED_MS = 20_000 // send the next request to Spotify this long before the current song ends
const TOKEN_FILE = path.join(__dirname, 'tokens.json')
const QUEUE_FILE = path.join(__dirname, 'queue.json')

// ---------- logging ----------
let VERBOSE = Number(env.VERBOSE ?? 0)
const ts = () => new Date().toLocaleTimeString('en-GB')
const vlog = (level, ...args) => VERBOSE >= level && console.log(ts(), ...args)

if (!CLIENT_ID || !ADMIN_PIN) {
  console.error('Set SPOTIFY_CLIENT_ID and ADMIN_PIN in .env')
  process.exit(1)
}
if (!fs.existsSync(TOKEN_FILE)) {
  console.error('No tokens.json yet. Run: bun run auth')
  process.exit(1)
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------- Spotify auth + API ----------
let tokens
try {
  tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_at) throw new Error('bad shape')
} catch {
  console.error('tokens.json is missing or corrupt. Run: bun run auth')
  process.exit(1)
}
let refreshing = null

async function accessToken() {
  if (tokens.access_token && Date.now() < tokens.expires_at - 60_000) return tokens.access_token
  refreshing ??= (async () => {
    try {
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        }),
      })
      if (!res.ok) throw new Error('Token refresh failed: ' + (await res.text()))
      const d = await res.json()
      tokens = {
        access_token: d.access_token,
        refresh_token: d.refresh_token ?? tokens.refresh_token,
        expires_at: Date.now() + d.expires_in * 1000,
      }
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens))
      return tokens.access_token
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

let blockedUntil = 0

async function spotify(method, endpoint, body) {
  if (Date.now() < blockedUntil) throw new HttpError(503, 'Spotify is busy, try again in a moment')
  const t0 = Date.now()
  let res
  try {
    res = await fetch('https://api.spotify.com/v1' + endpoint, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    if (e.status) throw e // already an HttpError (e.g. token refresh failed)
    // TimeoutError/AbortError, or undici's TypeError on DNS/refused/reset:
    // the laptop can't reach Spotify's API at all. Say so plainly instead of
    // timing out into a 500 with a raw DOMException dump, or masquerading as
    // "no device" (which sends the host reopening the app for a network fault).
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError) {
      throw new HttpError(502, "Can't reach Spotify. Check the laptop's internet connection.")
    }
    throw e
  }
  vlog(2, `SPOTIFY ${method} ${endpoint.split('?')[0]} -> ${res.status} ${Date.now() - t0}ms`)
  if (res.status === 429) {
    blockedUntil = Date.now() + (Number(res.headers.get('retry-after')) || 5) * 1000
    throw new HttpError(503, 'Spotify is busy, try again in a moment')
  }
  if (res.status === 204) return null
  const text = await res.text()
  if (!res.ok) {
    console.error(`Spotify ${method} ${endpoint.split('?')[0]} -> ${res.status} ${text}`)
    if (res.status === 404 && endpoint.startsWith('/me/player'))
      throw new HttpError(409, 'No active Spotify device. Open Spotify on the laptop.')
    if (res.status === 403 && text.includes('Restriction violated'))
      throw new HttpError(409, "Spotify can't do that right now (already paused, or nothing to skip to)")
    throw new HttpError(502, `Spotify error (${res.status})`)
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null // some player commands reply with plain text
  }
}

const trackCache = new Map()
const MAX_TRACK_CACHE = 500
const MAX_SEARCH_CACHE = 200
function boundedSet(map, key, value, max) {
  // Map keeps insertion order, so delete + set refreshes LRU position
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
}
function slim(t) {
  const s = {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    image: t.album?.images?.[0]?.url ?? null, // largest first (640px): crisp hero/TV art for one URL string
    durationMs: t.duration_ms,
    explicit: !!t.explicit,
  }
  boundedSet(trackCache, s.uri, s, MAX_TRACK_CACHE)
  return s
}

// ---------- jukebox state ----------
let queue = [] // pending requests, in play order
let inFlight = null // request already sent to Spotify, waiting to start
let now = null // last playback state from Spotify
let nowClient = null // who requested the song that's playing
let paused = false // paused by admin
let lastUri = null
let lastError = null
let startFailMsg = null // silent start (Spotify 204 but still not playing)
const recent = []
const BOOT_AT = Date.now() // session clock: uptime + played list reset on restart
const played = [] // this run's played songs, oldest first: { uri, name, artists, durationMs, at }
const PLAYED_LIMIT = 100
let playedMs = 0 // real wall-time the player spent playing (skips/pauses excluded)
let lastPollAt = 0
// songs queued directly in the Spotify app (host adds via desktop/phone).
// Best-effort mirror so the web Up Next lists stay truthful. Refreshed every
// few seconds, never inside the playback lock. NOTE: the API queue mixes the
// app's "Next in queue" (manual) with autoplay "Next up" and marks neither,
// so the laptop must have Autoplay off (Spotify app: queue panel or
// Settings → Playback) for this to mirror only "Next in queue".
let spotifyQueue = [] // slimmed tracks, upcoming only
let lastSpotifyQueueAt = 0
async function refreshSpotifyQueue() {
  if (Date.now() - lastSpotifyQueueAt < 5000) return
  lastSpotifyQueueAt = Date.now()
  try {
    const data = await spotify('GET', '/me/player/queue')
    const items = Array.isArray(data?.queue) ? data.queue : []
    spotifyQueue = items
      .filter((t) => t && typeof t.uri === 'string' && t.uri.startsWith('spotify:track:'))
      .slice(0, 10)
      .map(slim)
  } catch (e) {
    // no active device: nothing is queued anywhere, drop the mirror instead
    // of showing stale songs. Transient faults keep the last good list.
    if (e?.status === 409) spotifyQueue = []
    else vlog(2, 'spotify queue:', e.message)
  }
}
function externalUpcoming() {
  // hide what we already show elsewhere: now playing + our own pending list
  // (an item we fed to Spotify appears in both until it starts)
  return spotifyQueue.filter((t) => t.uri !== now?.uri && !queue.some((i) => i.uri === t.uri))
}

function saveQueue() {
  try {
    // queue only: `recent` is session-scoped (a song played last run must be
    // requestable again, so it is never written here)
    // Write to .tmp then rename so a crash mid-write can't corrupt queue.json.
    const tmp = QUEUE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ queue }))
    fs.renameSync(tmp, QUEUE_FILE)
  } catch (e) {
    console.log('save queue failed:', e.message)
  }
}
try {
  const saved = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
  if (Array.isArray(saved.queue)) {
    queue = saved.queue.filter((i) => i && i.id && i.uri && i.clientId)
    // drop send-state from a previous run: inFlight never survives a restart,
    // so a stale kind/sentAt would lie about an item already being in Spotify
    for (const i of queue) {
      i.fails = 0
      delete i.kind
      delete i.sentAt
    }
  }
  // note: files written before the session-scoped change still carry a
  // `recent` key; it is simply never read.
  if (queue.length) console.log(`Restored ${queue.length} queued song(s) from last run.`)
} catch {
  // first run or corrupt file: start empty
}

// run Spotify-changing actions one at a time
let chain = Promise.resolve()
function locked(fn) {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

async function sendToSpotify(item, kind, call) {
  inFlight = item
  item.sentAt = Date.now()
  item.kind = kind // 'play' = start now, 'queue' = added to Spotify's queue
  try {
    await call()
  } catch (e) {
    inFlight = null
    throw e
  }
}

// Local CLI bundled with the Store Spotify app. It drives the laptop's player
// directly, which succeeds from an empty player where the Web API stays silent.
let spotifyCli = undefined // null once discovery fails, so we don't retry every song
const CLI_PATH_FILE = path.join(__dirname, '.cli-path')
function findSpotifyCli() {
  // cached path, re-validated: Spotify auto-updates change the versioned folder mid-run
  if (typeof spotifyCli === 'string') {
    if (fs.existsSync(spotifyCli)) return spotifyCli
    spotifyCli = undefined // stale after an app update, rediscover below
  }
  if (spotifyCli !== undefined) return spotifyCli
  spotifyCli = null
  try {
    // explicit opt-in on any OS: must speak `play <uri> [--device <name>]`
    // (the CLI bundled with Spotify; e.g. SPOTIFY_CLI=/usr/local/bin/spotify_cli)
    if (process.env.SPOTIFY_CLI && fs.existsSync(process.env.SPOTIFY_CLI)) {
      spotifyCli = process.env.SPOTIFY_CLI
      return spotifyCli
    }
    if (process.platform !== 'win32') return spotifyCli // Web API fallback on mac/Linux
    // last good path: WindowsApps listing is EPERM for some processes, so reuse it
    try {
      const cached = fs.readFileSync(CLI_PATH_FILE, 'utf8').trim()
      if (cached && fs.existsSync(cached)) {
        spotifyCli = cached
        return spotifyCli
      }
    } catch {
      // no cache yet
    }
    // Get-AppxPackage needs no WindowsApps listing rights
    try {
      const out = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-AppxPackage -Name SpotifyAB.SpotifyMusic).InstallLocation'], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      const loc = (out.stdout ?? '').trim().split('\n')[0]?.trim()
      if (loc) {
        const exe = path.join(loc, 'spotify_cli.exe')
        if (fs.existsSync(exe)) spotifyCli = exe
      }
    } catch {
      // fall through to folder scan
    }
    if (!spotifyCli) {
      const apps = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps')
      let bestTime = 0
      for (const dir of fs.readdirSync(apps).filter((d) => d.startsWith('SpotifyAB.SpotifyMusic_'))) {
        const exe = path.join(apps, dir, 'spotify_cli.exe')
        try {
          const t = fs.statSync(exe).mtimeMs
          if (t > bestTime) {
            bestTime = t
            spotifyCli = exe
          }
        } catch {
          // folder without a CLI, skip
        }
      }
    }
  } catch (e) {
    console.log('find CLI failed:', e.message)
  }
  if (spotifyCli) {
    console.log('CLI:', spotifyCli)
    try {
      fs.writeFileSync(CLI_PATH_FILE, spotifyCli)
    } catch {
      // cache is optional
    }
  }
  return spotifyCli
}

function cliPlay(uri, device) {
  const exe = findSpotifyCli()
  if (!exe) throw new Error('no CLI')
  return new Promise((resolve, reject) => {
    const args = ['play', uri]
    if (device) args.push('--device', device)
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const kill = setTimeout(() => {
      child.kill()
      reject(new Error('CLI timed out'))
    }, 15_000)
    child.stderr?.on('data', (b) => (err += b.toString()))
    child.on('error', (e) => {
      clearTimeout(kill)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      if (code === 0) resolve()
      else reject(new Error('CLI play failed' + (err.trim() ? `: ${err.trim().split('\n').slice(0, 3).join(' | ')}` : '')))
    })
  })
}

// The app can appear in the device list before it's ready to accept a
// transfer (fresh launch). Retry, including playing on the local client
// itself with no transfer step, which skips the failing part entirely.
async function cliPlayWithRetry(uri, deviceName, justLaunched) {
  const rounds = justLaunched ? 2 : 1
  let lastErr = null
  for (let r = 0; r < rounds; r++) {
    if (r > 0) await new Promise((res) => setTimeout(res, 3000))
    for (const dev of [deviceName, null]) {
      try {
        await cliPlay(uri, dev)
        return
      } catch (e) {
        lastErr = e
        if (e.message === 'no CLI') throw e // retrying won't conjure the binary; fall back now
        console.log(`CLI play${dev ? ` on ${dev}` : ' on self'} failed:`, e.message)
      }
    }
  }
  throw lastErr
}

// best effort: open the Spotify desktop app on this computer so a device appears.
// The app can take several seconds to show up, callers should poll after this.
function launchSpotifyApp() {
  try {
    const opts = { detached: true, stdio: 'ignore' }
    if (process.platform === 'win32') {
      const exe = path.join(process.env.APPDATA ?? '', 'Spotify', 'Spotify.exe')
      if (exe && fs.existsSync(exe)) {
        spawn(exe, [], opts).unref()
        return true
      }
      // fallback to the protocol handler registered by the installer
      spawn('cmd', ['/c', 'start', '', 'spotify:'], opts).unref()
      return true
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Spotify'], opts).unref()
      return true
    }
    spawn('spotify', [], opts).unref()
    return true
  } catch (e) {
    console.log('launch Spotify failed:', e.message)
    return false
  }
}

async function listDevices() {
  return (await spotify('GET', '/me/player/devices'))?.devices ?? []
}

async function waitForDevices(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const devices = await listDevices()
      if (devices.length) return devices
    } catch (e) {
      if (e.status === 502) return [] // API itself unreachable: no device can appear, don't burn the window
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return []
}

function logDevices(devices) {
  console.log(
    'DEVICES:',
    devices.map((d) => `${d.name} (${d.type}${d.is_active ? ', active' : ''})`).join(' | ') || 'none',
  )
}

async function issueStart(item) {
  // Fast path, runs inside the lock: transfer + play command only (~1s).
  // Verification polls outside the lock so state polls and admin actions stay responsive.
  let device = ''
  let devices = await listDevices()
  logDevices(devices)
  const justLaunched = !devices.length
  if (justLaunched) {
    // app closed: open it and wait for the device to appear
    console.log('No Spotify device, opening the Spotify app...')
    launchSpotifyApp()
    devices = await waitForDevices()
    logDevices(devices)
    // listed != ready: a fresh app needs a moment before it accepts a transfer
    await new Promise((r) => setTimeout(r, 3000))
  }
  const pick =
    (deviceIdOverride && devices.find((d) => d.id === deviceIdOverride)) ??
    devices.find((d) => (DEVICE_NAME ? d.name === DEVICE_NAME : d.type === 'Computer')) ??
    devices[0]
  if (!pick) throw new HttpError(409, 'No Spotify device found. Open Spotify on the laptop.')
  // Local CLI first: it transfers + plays on the laptop directly and works
  // from an empty player where the Web API returns 204 but stays silent.
  // Falls back to the Web API when the CLI is missing or fails.
  try {
    console.log('PLAY:', item.name, `via CLI on ${pick.name}`)
    await sendToSpotify(item, 'play', () => cliPlayWithRetry(item.uri, pick.name, justLaunched))
    return `?device_id=${pick.id}`
  } catch (e) {
    console.log('CLI play failed, Web API fallback:', e.message)
  }
  // wake the device up first, otherwise Spotify can accept the command but not play
  await spotify('PUT', '/me/player', { device_ids: [pick.id], play: false }).catch((e) =>
    console.log('transfer:', e.message),
  )
  await new Promise((r) => setTimeout(r, 800))
  device = `?device_id=${pick.id}`
  console.log('PLAY:', item.name, device)
  await sendToSpotify(item, 'play', () => spotify('PUT', '/me/player/play' + device, { uris: [item.uri] }))
  return device
}

async function verifyStart(item, device) {
  // Slow path, runs outside the lock: Spotify can accept play and still stay silent,
  // especially from an empty player. Poll a few seconds before calling it a failure.
  let after = null
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 2500 : 2000))
    after = await spotify('GET', '/me/player').catch(() => null)
    if (after?.is_playing) break
    // muted laptop looks like "not playing" — try to unmute once, then re-check
    if (after?.device && after.device.volume_percent === 0 && i === 0) {
      const volDevice = device ? device.replace('?device_id=', '') : ''
      await spotify(
        'PUT',
        `/me/player/volume?volume_percent=50${volDevice ? `&device_id=${volDevice}` : ''}`,
      ).catch((e) => console.log('volume:', e.message))
    }
  }
  console.log(
    'AFTER:',
    after?.is_playing,
    after?.item?.name,
    after?.device ? `on ${after.device.name} vol=${after.device.volume_percent}` : '(no device)',
  )
  if (after?.is_playing) {
    item.fails = 0
    if (startFailMsg && queue.includes(item)) startFailMsg = null
    lastError = startFailMsg
  } else {
    item.fails = (item.fails ?? 0) + 1
    // don't clear a newer command that superseded this one (e.g. admin skip)
    if (inFlight === item) inFlight = null
    // surface silent failures instead of showing "Starting..." forever.
    // Empty-player starts are the flaky path; once a track is loaded, queue+next is reliable.
    startFailMsg =
      item.fails === 1
        ? `Starting "${item.name}"… Spotify sometimes ignores the first play from empty.`
        : `Spotify didn't start "${item.name}" (${item.fails}/3). Press Play once in the Spotify app, re-pick the device in /admin, check Premium + volume.`
    lastError = startFailMsg
    if (item.fails >= 3) {
      queue = queue.filter((i) => i !== item)
      saveQueue()
      console.log('GAVE UP on', item.name)
    }
  }
}

async function startPlaying(item) {
  // compat wrapper: issue inside lock is now done by tick, this keeps direct callers working
  const device = await issueStart(item)
  await verifyStart(item, device)
}

let ticking = false
async function tick() {
  if (ticking) return
  ticking = true
  try {
    let started = null
    await locked(async () => {
      // a "start now" command that never started playing: forget it so it retries
      if (inFlight?.kind === 'play' && Date.now() - inFlight.sentAt > 12_000) inFlight = null
      if (inFlight && Date.now() - inFlight.sentAt > 10 * 60_000) {
        queue = queue.filter((i) => i !== inFlight)
        inFlight = null
        saveQueue()
      }

      const t0 = Date.now()
      const st = await spotify('GET', '/me/player')
      const at = Math.round((t0 + Date.now()) / 2) // the moment Spotify's answer was accurate
      // real playing time: only wall-time actually spent playing counts,
      // so skipped songs and pauses don't inflate it. Capped per poll so an
      // event-loop stall can't credit minutes that never played.
      if (st?.is_playing && lastPollAt) playedMs += Math.min(t0 - lastPollAt, 10_000)
      lastPollAt = t0
      const item = st?.item?.type === 'track' ? st.item : null
      now = item
        ? { ...slim(item), progressMs: st.progress_ms ?? 0, isPlaying: st.is_playing, at }
        : null

      // a new song started
      if (item && item.uri !== lastUri) {
        lastUri = item.uri
        startFailMsg = null
        vlog(1, 'NOW PLAYING', item.name)
        paused = false
        recent.push(item.uri)
        if (recent.length > RECENT_LIMIT) recent.shift()
        played.push({ uri: now.uri, name: now.name, artists: now.artists, album: now.album, durationMs: now.durationMs, at })
        if (played.length > PLAYED_LIMIT) played.shift()
        if (inFlight && (inFlight.uri === item.uri || inFlight.kind === 'play')) {
          queue = queue.filter((i) => i !== inFlight)
          nowClient = inFlight.clientId
          inFlight = null
          saveQueue()
        } else {
          nowClient = null
          // keep a queued inFlight across foreign songs (host played/queued
          // something in the app): it is still sitting in Spotify's queue and
          // will play in turn. Clearing it here would re-send a duplicate.
        }
        broadcastState()
      }

      // feed the next request. The play command stays inside the lock (fast);
      // verification polls outside it so state polls and admin actions don't stall 8s.
      if (!inFlight && queue.length) {
        const next = queue[0]
        const progress = st?.progress_ms ?? 0
        if (item && st.is_playing && item.duration_ms - progress < FEED_MS) {
          await sendToSpotify(next, 'queue', () =>
            spotify('POST', `/me/player/queue?uri=${encodeURIComponent(next.uri)}`),
          )
        } else if (!item || (!paused && !st.is_playing && progress < 1000)) {
          // Cold start from an empty player: always use an explicit device_id.
          const device = await issueStart(next)
          started = { item: next, device }
        }
      }
    })
    lastError = startFailMsg
    // mirror the app's own queue outside the lock so play commands never wait on it
    await refreshSpotifyQueue().catch(() => {})
    // verify outside the lock; inFlight guards the next tick from double-issuing
    if (started) void verifyStart(started.item, started.device).catch((e) => console.log('verify:', e.message))
  } catch (e) {
    lastError = e.message
    console.error('tick:', e.message)
  } finally {
    ticking = false
  }
}

async function loop() {
  await tick()
  // 1s keeps Now Playing + session stats feeling live; one small GET per
  // second is well within Spotify's rate limits (429s back off via blockedUntil)
  setTimeout(loop, 1000)
}
loop()

// ---------- web server ----------
const app = express()
app.use(express.json({ limit: '2kb' }))

// request logger (only prints when VERBOSE >= 1)
app.use('/api', (req, res, next) => {
  if (VERBOSE < 1 || (req.path === '/state' && VERBOSE < 3)) return next()
  const start = Date.now()
  const who = String(req.headers['x-client-id'] ?? '-').slice(0, 8)
  res.on('finish', () => {
    let line = `API ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} ${Date.now() - start}ms [${who}]`
    if (VERBOSE >= 2) {
      if (Object.keys(req.query).length) line += ' query=' + JSON.stringify(req.query)
      if (req.body && Object.keys(req.body).length) line += ' body=' + JSON.stringify(req.body)
    }
    console.log(ts(), line)
  })
  next()
})

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

function clientId(req) {
  const id = req.headers['x-client-id']
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id))
    throw new HttpError(400, 'Missing client id. Reload the page.')
  return id
}

function pinOk(req) {
  const given = Buffer.from(String(req.headers['x-admin-pin'] ?? ''))
  const real = Buffer.from(ADMIN_PIN)
  return given.length === real.length && crypto.timingSafeEqual(given, real)
}
const admin = async (req, res, next) => {
  if (pinOk(req)) return next()
  await new Promise((r) => setTimeout(r, 800)) // slow down guessing
  res.status(401).json({ error: 'Wrong PIN' })
}

const buckets = new Map()
const MAX_BUCKETS = 2000
function rateLimited(key, max, windowMs) {
  const t = Date.now()
  const arr = (buckets.get(key) ?? []).filter((x) => t - x < windowMs)
  const limited = arr.length >= max
  if (!limited) arr.push(t)
  // refresh LRU position so idle keys age out first
  buckets.delete(key)
  buckets.set(key, arr)
  if (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value)
  return limited
}

app.get('/api/health', (req, res) => res.json({ ok: true }))

app.get('/api/state', (req, res) => {
  const me = req.headers['x-client-id']
  const local = isLocalReq(req)
  const at = Date.now()
  const est = now
    ? Math.min(now.durationMs, now.progressMs + (now.isPlaying ? at - now.at : 0))
    : 0
  res.json({
    now: now && {
      name: now.name,
      artists: now.artists,
      image: now.image,
      uri: now.uri,
      durationMs: now.durationMs,
      isPlaying: now.isPlaying,
      explicit: !!now.explicit,
      progressMs: est,
      remainingMs: now.durationMs - est,
      at,
      mine: !!me && nowClient === me,
    },
    paused,
    local,
    // guests can't fix the player, but they shouldn't stare at a fake ETA either.
    // playerMessage is safe to show (no secrets), problem stays admin-only.
    playerWaiting: !now && queue.length > 0,
    playerError: !now && queue.length > 0 && !!lastError,
    playerMessage: !now && queue.length > 0 ? startFailMsg : null,
    cooldownMs: cooldownLeft(req, me),
    queue: queue.map((i) => ({
      id: i.id,
      name: i.name,
      artists: i.artists,
      image: i.image,
      durationMs: i.durationMs,
      mine: !!me && i.clientId === me,
    })),
    // songs queued directly in the Spotify app (host side). No requester, no
    // cancel button: they can only be skipped over from the app or /admin.
    externalQueue: externalUpcoming().map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      image: t.image,
      durationMs: t.durationMs,
      explicit: !!t.explicit,
    })),
    limits: { maxPending: MAX_PENDING, maxTrackMin: MAX_TRACK_MIN, cooldownSec: COOLDOWN_MS / 1000 },
    explicitBlocked: blockExplicit,
    session: { startedAt: BOOT_AT, playedMs, played: played.map((p) => ({ ...p })) },
    problem: pinOk(req) ? lastError : null,
    verbose: pinOk(req) ? VERBOSE : undefined,
  })
})

const searchCache = new Map()
app.get('/api/search', h(async (req, res) => {
  const id = clientId(req)
  const q = String(req.query.q ?? '').trim().slice(0, 100)
  if (q.length < 2) return res.json([])
  if (rateLimited('s:' + id, 30, 60_000)) throw new HttpError(429, 'Searching too fast. Slow down a little.')

  const key = q.toLowerCase()
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return res.json(hit.results)
  if (hit) searchCache.delete(key)

  const data = await spotify('GET', `/search?type=track&limit=8&market=TH&q=${encodeURIComponent(q)}`)
  const results = (data?.tracks?.items ?? []).filter((t) => t && t.is_playable !== false).map(slim)
  boundedSet(searchCache, key, { at: Date.now(), results }, MAX_SEARCH_CACHE)
  res.json(results)
}))

// Same-origin cover proxy for canvas color sampling: the sampling <img> loads
// from here, so the canvas stays readable no matter the CDN's CORS behavior
// on a given machine. Source-allowlisted to Spotify images; cached server-side.
const artCache = new Map()
const MAX_ART_CACHE = 20
app.get(
  '/api/art',
  h(async (req, res) => {
    if (rateLimited('art:global', 120, 60_000)) throw new HttpError(429, 'Slow down a little.')
    const src = String(req.query.img ?? '')
    if (!/^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(src)) throw new HttpError(400, 'Invalid art')
    const hit = artCache.get(src)
    if (hit && Date.now() - hit.at < 3600_000) {
      res.set('Content-Type', hit.type)
      res.set('Cache-Control', 'public, max-age=3600')
      return res.send(hit.buf)
    }
    const up = await fetch(src, { signal: AbortSignal.timeout(15_000) })
    if (!up.ok) throw new HttpError(502, 'Art fetch failed')
    const buf = Buffer.from(await up.arrayBuffer())
    const type = up.headers.get('content-type') ?? 'image/jpeg'
    boundedSet(artCache, src, { at: Date.now(), buf, type }, MAX_ART_CACHE)
    res.set('Content-Type', type)
    res.set('Cache-Control', 'public, max-age=3600')
    res.send(buf)
  }),
)

// Live lyrics come from free community catalogs (see lyrics.js), never Spotify:
// the public Web API has no lyrics endpoint (Spotify's own app uses Musixmatch
// over a private internal API). Fetched server-side and cached, so browsers
// and the providers' rate limits stay untouched.
const lyricsCache = new Map()
const MAX_LYRICS_CACHE = 200
app.get('/api/lyrics', h(async (req, res) => {
  const id = clientId(req)
  if (rateLimited('l:' + id, 20, 60_000)) throw new HttpError(429, 'Lyrics: slow down a little.')
  const uri = String(req.query.uri ?? '')
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) throw new HttpError(400, 'Invalid track')
  const hit = lyricsCache.get(uri)
  // provider outages are retried soon (10 min); a real "no lyrics" answer is
  // cached for the usual hour so a missing song is not re-queried all night
  if (hit && Date.now() - hit.at < (hit.transient ? 600_000 : 3600_000)) return res.json(hit.data)
  // resolve metadata from this session so clients can't inject arbitrary queries
  const meta =
    (now?.uri === uri ? now : null) ??
    queue.find((i) => i.uri === uri) ??
    spotifyQueue.find((t) => t.uri === uri) ??
    played.find((p) => p.uri === uri)
  if (!meta) throw new HttpError(404, 'Not in this session')
  const found = await fetchLyrics({
    title: meta.name,
    artist: meta.artists.split(',')[0].trim(), // primary artist matches best
    durationSec: Math.round(meta.durationMs / 1000),
  })
  const data = { uri, instrumental: found.instrumental, lines: found.lines, plain: found.plain }
  vlog(2, 'LYRICS:', found.source, `${found.lines.length} lines`, `for ${meta.name}`)
  boundedSet(lyricsCache, uri, { at: Date.now(), data, transient: found.transient }, MAX_LYRICS_CACHE)
  res.json(data)
}))

const lastRequest = new Map()
const MAX_CLIENTS = 2000

// true only when someone uses the laptop directly (http://localhost:3000).
// Tunnel visitors also arrive from 127.0.0.1, but Cloudflare adds these headers.
function isLocalReq(req) {
  const proxied = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host'].some(
    (k) => req.headers[k],
  )
  if (proxied) return false
  const addr = req.socket.remoteAddress ?? ''
  if (addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1') return true
  // fallback when Node reports the loopback differently: trust Host when nothing proxied it
  const host = String(req.headers.host ?? '').toLowerCase()
  return host.startsWith('localhost') || host.startsWith('127.0.0.1')
}

function cooldownLeft(req, id) {
  if (!id || isLocalReq(req)) return 0
  return Math.max(0, COOLDOWN_MS - (Date.now() - (lastRequest.get(id) ?? 0)))
}
app.post('/api/request', h(async (req, res) => {
  const id = clientId(req)
  const uri = String(req.body?.uri ?? '')
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) throw new HttpError(400, 'Invalid track')

  // cheap checks first so rejected requests skip the Spotify track fetch (~300-500ms)
  const local = isLocalReq(req)
  const wait = cooldownLeft(req, id)
  if (wait > 0) throw new HttpError(429, `Please wait ${Math.ceil(wait / 1000)}s before requesting again`)
  // localhost skips cooldown + pending limit, but length/explicit/duplicate checks still apply
  if (!local && queue.filter((i) => i.clientId === id).length >= MAX_PENDING)
    throw new HttpError(429, `You already have ${MAX_PENDING} songs waiting. Wait for one to play.`)
  if (now?.uri === uri) throw new HttpError(409, 'That song is playing right now')
  if (queue.some((i) => i.uri === uri)) throw new HttpError(409, 'That song is already in the queue')
  if (spotifyQueue.some((t) => t.uri === uri)) throw new HttpError(409, 'That song is already queued in Spotify')
  if (recent.includes(uri)) throw new HttpError(409, 'That song played recently. Pick another.')

  const track = trackCache.get(uri) ?? slim(await spotify('GET', `/tracks/${uri.split(':')[2]}?market=TH`))
  if (track.durationMs > MAX_TRACK_MS) throw new HttpError(422, `Too long (max ${MAX_TRACK_MIN} min)`)
  if (blockExplicit && track.explicit) throw new HttpError(422, "Explicit songs aren't allowed right now")

  queue.push({ id: crypto.randomUUID(), ...track, clientId: id })
  saveQueue()
  broadcastState()
  lastRequest.delete(id)
  lastRequest.set(id, Date.now())
  if (lastRequest.size > MAX_CLIENTS) lastRequest.delete(lastRequest.keys().next().value)
  vlog(1, 'QUEUED', track.name, 'by', id.slice(0, 8))
  res.json({ ok: true, position: queue.length })
  // nothing playing: don't wait for the next poll, start it now (tick is re-entrancy guarded)
  if (!now && !inFlight) void tick().catch(() => { broadcastState() })
}))

// ---------- admin ----------
app.post('/api/admin/check', admin, (req, res) => res.json({ ok: true }))

app.get('/api/admin/devices', admin, h(async (req, res) => {
  const devices = await listDevices()
  res.json(
    devices.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: !!d.is_active,
      volumePercent: d.volume_percent ?? null,
    })),
  )
}))

app.post('/api/admin/volume', admin, h(async (req, res) => {
  const percent = Math.max(0, Math.min(100, Number(req.body?.percent ?? NaN)))
  if (!Number.isFinite(percent)) throw new HttpError(400, 'Missing volume percent')
  const q = deviceIdOverride ? `&device_id=${deviceIdOverride}` : ''
  await locked(() => spotify('PUT', `/me/player/volume?volume_percent=${Math.round(percent)}${q}`))
  res.json({ ok: true })
  broadcastState()
}))

app.post('/api/admin/warmup', admin, h(async (req, res) => {
  // Resume whatever Spotify last had loaded on the target device.
  // Warms the player so the next request uses the reliable queue+next path.
  const devices = await listDevices()
  const pick =
    (deviceIdOverride && devices.find((d) => d.id === deviceIdOverride)) ??
    devices.find((d) => (DEVICE_NAME ? d.name === DEVICE_NAME : d.type === 'Computer')) ??
    devices.find((d) => d.is_active) ??
    devices[0]
  if (!pick) throw new HttpError(409, 'No Spotify device found. Open Spotify on the laptop.')
  deviceIdOverride = pick.id
  await locked(async () => {
    await spotify('PUT', '/me/player', { device_ids: [pick.id], play: false }).catch((e) =>
      console.log('transfer:', e.message),
    )
    try {
      await spotify('PUT', `/me/player/play?device_id=${pick.id}`)
    } catch (e) {
      throw new HttpError(409, 'Nothing to resume. Press Play once in the Spotify app, then try again.')
    }
  })
  console.log('WARMUP on', pick.name)
  res.json({ ok: true, name: pick.name })
  broadcastState()
}))

app.post('/api/admin/device', admin, h(async (req, res) => {
  const id = String(req.body?.id ?? '')
  if (!id) throw new HttpError(400, 'Missing device id')
  const devices = await listDevices()
  const pick = devices.find((d) => d.id === id)
  if (!pick) throw new HttpError(404, 'Device not found. Refresh the list.')
  deviceIdOverride = id
  // move playback to the chosen device without starting anything new
  await locked(() => spotify('PUT', '/me/player', { device_ids: [id], play: false })).catch((e) =>
    console.log('transfer:', e.message),
  )
  console.log('DEVICE: now using', pick.name)
  res.json({ ok: true, name: pick.name })
  broadcastState()
}))

app.post('/api/admin/launch', admin, h(async (req, res) => {
  launchSpotifyApp()
  const devices = await waitForDevices()
  logDevices(devices)
  broadcastState()
  res.json({
    ok: devices.length > 0,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: !!d.is_active,
      volumePercent: d.volume_percent ?? null,
    })),
  })
}))

app.post('/api/admin/verbose', admin, (req, res) => {
  VERBOSE = (VERBOSE + 1) % 4
  console.log(ts(), 'Verbosity set to', VERBOSE)
  res.json({ level: VERBOSE })
  broadcastState()
})

app.post('/api/admin/explicit', admin, (req, res) => {
  if (typeof req.body?.blocked === 'boolean') blockExplicit = req.body.blocked
  else blockExplicit = !blockExplicit
  console.log(ts(), 'Explicit songs', blockExplicit ? 'blocked' : 'allowed')
  res.json({ ok: true, blocked: blockExplicit })
  broadcastState()
})

// After a skip Spotify needs a beat before /me/player shows the new track.
// Settle first (quick re-polls via the normal tick, so bookkeeping stays in
// one place) so the admin's refresh and the next guest poll already carry the
// new song instead of leaving the web UI a full cycle behind.
async function settleAfterSkip(prevUri) {
  let nulls = 0
  for (let i = 0; i < 6; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350))
    await tick().catch(() => {})
    if (now?.uri && now.uri !== prevUri) break // new track is visible
    if (!now?.uri && ++nulls >= 2) break // idle (or played out), settled
  }
}

app.post('/api/admin/skip', admin, h(async (req, res) => {
  let started = null
  const prevUri = now?.uri ?? null
  await locked(async () => {
    if (inFlight?.kind === 'play') inFlight = null // stuck start, retry it
    const nextItem = queue[0]
    if (nextItem && !inFlight) {
      if (now) {
        // something is loaded: add the request to Spotify's queue, then skip to it
        await sendToSpotify(nextItem, 'queue', () =>
          spotify('POST', `/me/player/queue?uri=${encodeURIComponent(nextItem.uri)}`),
        )
        await spotify('POST', '/me/player/next')
      } else {
        started = { item: nextItem, device: await issueStart(nextItem) }
      }
    } else {
      await spotify('POST', '/me/player/next')
    }
  })
  if (started) void verifyStart(started.item, started.device).catch((e) => console.log('verify:', e.message))
  paused = false
  await settleAfterSkip(prevUri)
  res.json({ ok: true })
  broadcastState()
}))

app.post('/api/admin/pause', admin, h(async (req, res) => {
  paused = true
  await locked(() => spotify('PUT', '/me/player/pause')).catch(() => {})
  await tick().catch(() => {}) // flip the pill on the next refresh, not a cycle later
  res.json({ ok: true })
  broadcastState()
}))

app.post('/api/admin/resume', admin, h(async (req, res) => {
  paused = false
  await locked(() => spotify('PUT', '/me/player/play')).catch(() => {})
  await tick().catch(() => {}) // same: don't leave the UI a cycle behind
  res.json({ ok: true })
  broadcastState()
}))

app.post('/api/admin/clear', admin, (req, res) => {
  if (inFlight?.kind === 'play') inFlight = null // start command never took effect, safe to drop
  queue = queue.filter((i) => i === inFlight) // songs already in Spotify's queue can't be removed
  saveQueue()
  broadcastState()
  res.json({ ok: true })
})

// end of event: quit the Spotify desktop app on this laptop (music stops)
app.post('/api/admin/quit-app', admin, h(async (req, res) => {
  // best-effort pause first so the music stops cleanly even if the kill misses
  await locked(() => spotify('PUT', '/me/player/pause')).catch(() => {})
  paused = true
  if (process.platform === 'win32') spawnSync('taskkill', ['/IM', 'Spotify.exe', '/F'], { timeout: 10_000 })
  else if (process.platform === 'darwin') spawnSync('pkill', ['-x', 'Spotify'], { timeout: 10_000 })
  else spawnSync('pkill', ['-x', 'spotify'], { timeout: 10_000 })
  console.log('Spotify app quit by admin')
  broadcastState()
  res.json({ ok: true })
}))

// end of event: stop this server (the launcher tears the tunnel down too;
// the page stays offline until someone restarts it on the laptop)
app.post('/api/admin/shutdown', admin, (req, res) => {
  console.log('Server shutdown requested by admin')
  broadcastState()
  res.json({ ok: true })
  setTimeout(() => process.exit(0), 300) // answer first, then exit
})

app.delete('/api/admin/queue/:id', admin, (req, res) => {
  const item = queue.find((i) => i.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  if (item === inFlight) {
    if (item.kind !== 'play')
      return res.status(409).json({ error: "Already in Spotify's queue. Use Skip once it starts." })
    inFlight = null
  }
  queue = queue.filter((i) => i !== item)
  saveQueue()
  res.json({ ok: true })
})

// guests can cancel their own pending request (same browser id that made it)
app.delete('/api/queue/:id', h(async (req, res) => {
  const id = clientId(req)
  const item = queue.find((i) => i.id === req.params.id)
  if (!item || item.clientId !== id) return res.status(404).json({ error: 'Not found' })
  if (item === inFlight) {
    if (item.kind !== 'play')
      return res.status(409).json({ error: 'Your song is starting now. Ask the host to skip it.' })
    inFlight = null
  }
  queue = queue.filter((i) => i !== item)
  saveQueue()
  broadcastState()
  res.json({ ok: true })
}))

// ---------- frontend + errors ----------
const dist = path.join(__dirname, '..', 'web', 'dist')
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))
app.use(express.static(dist))
app.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(500).send('Run "bun run build" from the repo root first.')
  })
})
app.use((err, req, res, next) => {
  const status = err.status ?? 500
  vlog(1, 'ERR', req.method, req.originalUrl.split('?')[0], status, err.message)
  if (status === 500) console.error(err)
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message })
})

// ---------- websocket for real-time state push ----------
const httpServer = http.createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' })
const wsClients = new Set()

function broadcastState() {
  const payload = JSON.stringify({ type: 'state-update', ts: Date.now() })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  }
}

wss.on('connection', (client) => {
  wsClients.add(client)
  client.on('close', () => wsClients.delete(client))
  client.on('error', () => wsClients.delete(client))
})

httpServer.listen(PORT, '0.0.0.0', () => console.log(`Jukebox running: http://localhost:${PORT}  (admin: /admin)`))