import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.join(root, 'server')

// optional QR code (works only after `bun install`)
const qrcode = await import('qrcode-terminal').then((m) => m.default).catch(() => null)

function readPort() {
  try {
    const m = fs.readFileSync(path.join(serverDir, '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m)
    return m ? Number(m[1]) : 3000
  } catch {
    return 3000
  }
}
const PORT = readPort()

// QUIC/UDP is often throttled on event/school Wi-Fi and hotspots, which kills
// the tunnel with "timeout: no recent network activity" while the process stays
// up. HTTP/2 over TCP survives those networks. Override with TUNNEL_PROTO=quic.
const TUNNEL_PROTO = process.env.TUNNEL_PROTO ?? 'http2'

let stopping = false
let url = null
let tunnel = null

function banner() {
  if (!url) return console.log('\n[jukebox] Link not ready yet...\n')
  console.log('\n' + '='.repeat(60))
  console.log('  Guests : ' + url)
  console.log('  Admin  : ' + url + '/admin')
  console.log('  (press Enter to show this again, Ctrl+C to stop)')
  console.log('='.repeat(60))
  if (qrcode) qrcode.generate(url, { small: true })
  console.log()
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
  tunnel?.kill()
  server.kill()
  setTimeout(() => process.exit(code), 300)
}

// ---- server ----
const WATCH = process.argv.includes('--watch')
const serverArgs = [...(WATCH ? ['--watch'] : []), '--env-file=.env', 'server.js']
if (WATCH) console.log('[jukebox] watch mode: server restarts on file changes')
const server = spawn(process.execPath, serverArgs, {
  cwd: serverDir,
  stdio: ['ignore', 'inherit', 'inherit'],
})
server.on('exit', (code) => {
  if (stopping) return
  console.log(`\n[jukebox] Server stopped (code ${code}). Shutting down.`)
  stop(code ?? 1)
})

// ---- tunnel ----
let regFails = 0
const REG_FAIL_LIMIT = 5 // consecutive registration failures before forcing a fresh tunnel
let degradedAt = [] // timestamps of transport-death errors (rolling window below)
const DEGRADED_LIMIT = 8 // that many inside the window = dead link, restart it
const DEGRADED_WINDOW_MS = 60_000
function startTunnel() {
  url = null
  regFails = 0
  degradedAt = []
  console.log(`[jukebox] Starting tunnel (protocol ${TUNNEL_PROTO})...`)
  const proc = spawn('cloudflared', ['tunnel', '--protocol', TUNNEL_PROTO, '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  tunnel = proc

  const onData = (buf) => {
    if (tunnel !== proc) return // late output from a tunnel we already replaced
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue
      const m = line.match(/https:\/\/(?!api\.)[a-z0-9-]+\.(trycloudflare\.com|cfargotunnel\.com)/i)
      if (m && !url) {
        url = m[0]
        regFails = 0
        banner()
      } else if (/registered tunnel connection/i.test(line)) {
        regFails = 0 // healthy heartbeat, reset the failure streak
      } else if (/register tunnel error|tunnel not found/i.test(line)) {
        console.log('[tunnel]', line.trim())
        // cloudflared retries internally, but a rejected tunnel ID never
        // recovers: restart it ourselves so the event isn't stuck linkless
        if (++regFails >= REG_FAIL_LIMIT) {
          console.log('[jukebox] Tunnel registration keeps failing. Restarting it — the link will change!')
          regFails = 0
          proc.kill()
          return
        }
      } else if (/no recent network activity|failed to accept QUIC stream|accept stream listener error|failed to dial .*quic|unreachable network/i.test(line)) {
        console.log('[tunnel]', line.trim())
        // the process stays alive but nothing flows through it: restart it
        // ourselves or guests stare at a dead link (it changes, reshare it)
        const t = Date.now()
        degradedAt = degradedAt.filter((x) => t - x < DEGRADED_WINDOW_MS)
        degradedAt.push(t)
        if (degradedAt.length >= DEGRADED_LIMIT) {
          console.log('[jukebox] Tunnel transport is dead. Restarting it — the link will change!')
          degradedAt = []
          proc.kill()
          return
        }
      } else if (/\bERR\b/.test(line)) {
        console.log('[tunnel]', line.trim())
      }
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)

  proc.on('error', (e) => {
    if (e.code === 'ENOENT') {
      console.error(
        '\n[jukebox] cloudflared not found. Install it with:\n  winget install --id Cloudflare.cloudflared\nThen reopen this terminal.',
      )
      stop(1)
    } else {
      console.error('[tunnel]', e.message)
    }
  })

  proc.on('exit', (code) => {
    if (stopping) return
    console.log(`\n[jukebox] Tunnel dropped (code ${code}). Restarting in 3s. The link will change!`)
    setTimeout(() => !stopping && startTunnel(), 3000)
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
process.stdin.on('data', banner) // press Enter to reprint the link

// Never publish the link before the server answers: guests opening it during
// boot would hit a dead tunnel. Restarts below reuse startTunnel() directly
// because the server is already up by then.
async function waitForServer(timeoutMs = 30_000, intervalMs = 300) {
  console.log('[jukebox] Waiting for the server...')
  const t0 = Date.now()
  for (;;) {
    if (stopping) return false
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        console.log('[jukebox] Server is up.')
        return true
      }
    } catch {
      // not listening yet (or still booting): keep waiting
    }
    if (Date.now() - t0 > timeoutMs) {
      console.error(
        `[jukebox] Server did not answer on port ${PORT} within ${timeoutMs / 1000}s. Check server/.env and tokens.json, then try again.`,
      )
      stop(1)
      return false
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

if (await waitForServer()) startTunnel()