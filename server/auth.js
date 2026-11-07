import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing'

if (!CLIENT_ID) {
  console.error('Set SPOTIFY_CLIENT_ID in .env')
  process.exit(1)
}

const verifier = crypto.randomBytes(48).toString('base64url')
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

const url =
  'https://accounts.spotify.com/authorize?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })

console.log('\nOpen this link in your browser and approve:\n\n' + url + '\n')

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1:8888')
    if (u.pathname !== '/callback') {
      res.statusCode = 404
      return res.end()
    }
    const code = u.searchParams.get('code')
    if (!code) return res.end('No code received: ' + (u.searchParams.get('error') ?? 'try again'))

    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    })
    const d = await r.json()
    if (!r.ok) return res.end('Failed: ' + JSON.stringify(d))

    fs.writeFileSync(
      path.join(__dirname, 'tokens.json'),
      JSON.stringify({
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: Date.now() + d.expires_in * 1000,
      }),
    )
    res.end('Done! You can close this tab.')
    console.log('Saved tokens.json')
    setTimeout(() => process.exit(0), 500)
  })
  .listen(8888, '127.0.0.1')