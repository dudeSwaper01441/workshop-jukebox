// Lyrics lookup for a Thai-first jukebox. Free community catalogs, no keys:
//   LRCLIB  - cleanest timing, small Thai catalog
//   KuGou   - KTV-grade LRC, large Thai catalog (search host is http-only:
//             its https certificate does not match the hostname)
//   QQ Music- same upstream LRC as KuGou, different search index
//   NetEase - fills gaps, but its Thai search is fuzzy
//   lyrics.ovh - plain text only, Western tracks; last resort
// Every candidate is validated against the Spotify metadata (title, artist,
// duration) before use: these search APIs cheerfully return a different song,
// and wrong lyrics on the TV are worse than none.
import { Buffer } from 'node:buffer'

const APP_UA = 'workshop-jukebox/1.0'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
const REQ_MS = 8000

// ---------- matching ----------
// Thai has no spaces between words, so character bigrams compare titles better
// than word tokens. Bracket contents ("(OST ...)", "(Remastered)") are noise.
function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring|remaster(ed)?|version|single|ost)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}
function bigrams(s) {
  const g = new Set()
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2))
  return g
}
function titleScore(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 4
  const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length)
  if ((x.includes(y) || y.includes(x)) && ratio >= 0.5) return 2.5
  // short Thai titles ("ฝน", "เธอ") are substrings of countless songs, and
  // their bigrams overlap almost anything: no fuzzy score below 4 characters
  if (Math.min(x.length, y.length) < 4) return 0
  const A = bigrams(x)
  const B = bigrams(y)
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  const overlap = hit / Math.max(1, Math.min(A.size, B.size))
  return overlap >= 0.6 ? Math.min(overlap * 2.5, 2.5) : 0
}
function artistScore(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 3
  if (x.includes(y) || y.includes(x)) return 1.5
  return 0
}
// A candidate must look like the same recording: a strong title match, plus the
// artist or a near-identical duration (covers transliterated artist names).
function scoreCandidate(cand, meta) {
  const dt = Math.abs(cand.durationSec - meta.durationSec)
  const t = titleScore(cand.title, meta.title)
  const a = artistScore(cand.artist, meta.artist)
  const d = dt <= 2 ? 3 : dt <= 5 ? 1.5 : dt <= 10 ? 0 : -2
  const total = t + a + d
  const shortTitle = norm(meta.title).length <= 3
  const ok = t >= 2.5 && total >= 4 && (a > 0 || (!shortTitle && dt <= 3))
  return { total, t, a, dt, ok }
}
function pickBest(cands, meta) {
  let best = null
  for (const c of cands) {
    const s = scoreCandidate(c, meta)
    if (!s.ok) continue
    if (!best || s.total > best.score) best = { ...c, score: s.total }
  }
  return best
}

// ---------- LRC ----------
function splitLyricParts(s) {
  const [head, ...rest] = String(s).split('^')
  const text = head.trim()
  const sub = rest
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' / ')
  return sub ? { text, sub } : { text }
}
function parseLrc(lrc) {
  const lines = []
  let offset = 0
  for (const raw of String(lrc ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const meta = line.match(/^\[(ti|ar|al|au|length|by|offset|re|ve):(.*)\]$/i)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = Number(meta[2]) || 0
      continue
    }
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const text = line
      .replace(/\[[^\]]*\]/g, '')
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    const parts = splitLyricParts(text)
    if (!parts.text) continue
    for (const [, mm, ss, frac] of stamps) {
      let ms = Number(mm) * 60000 + Number(ss) * 1000
      if (frac) ms += Number((frac + '000').slice(0, 3))
      lines.push({ ms: ms + offset, ...parts })
    }
  }
  lines.sort((a, b) => a.ms - b.ms)
  return lines.filter((l) => l.ms >= 0)
}

// Chinese/KTV files carry credit lines on the first timestamp; they would sit
// on the TV as lyrics. Header lines ("Song - Artist" at 0:00) go too.
const CREDIT_CJK =
  /^(作词|作曲|编曲|制作人|监制|混音|母带|录音|和声|吉他|贝斯|鼓|键盘|弦乐|出品|发行|统筹|企划|词|曲|OP|SP)\s*[:：]/
const CREDIT_EN = /^(lyrics?|music|composed|written|produced|arranged|mixed|mastered)\s*(by|:)/i
const CREDIT_TH = /^(เพลง|ศิลปิน|นักร้อง|เนื้อร้อง|คำร้อง|ทำนอง|เรียบเรียง|โปรดิวซ์|สังกัด|อัลบั้ม)\s*[:：]/
const INSTRUMENTAL = /纯音乐|没有填词的纯音乐/i

function cleanLines(lines, meta) {
  const t = norm(meta.title)
  // Spotify titles often carry a suffix ("Song - เพลงจากละคร ..."); headers in
  // the file use the bare name, so match against both forms
  const tb = norm(String(meta.title).split(/\s[-–—]\s/)[0]) || t
  const a = norm(meta.artist)
  const out = []
  let instrumental = false
  let first = true
  for (const l of lines) {
    if (INSTRUMENTAL.test(l.text)) {
      instrumental = true
      continue
    }
    if (!/[\p{L}\p{N}]/u.test(l.text)) continue // "♪", "..." and other fillers
    if (CREDIT_CJK.test(l.text) || CREDIT_EN.test(l.text) || CREDIT_TH.test(l.text)) continue
    if (first && l.ms < 3000) {
      const n = norm(l.text)
      const raw = l.text.trim()
      // "Song - Artist", "Song (OST ...) - Artist", or just the title at 0:00
      const header =
        (t && n === t) ||
        (t && a && n.includes(t) && n.includes(a)) ||
        (tb && a && n.includes(tb) && n.includes(a)) ||
        (tb && n.startsWith(tb) && /\s[-–—]\s/.test(raw))
      if (header) {
        first = false
        continue
      }
    }
    first = false
    out.push(l)
  }
  return { lines: instrumental ? [] : out, instrumental }
}

// ---------- transport ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
async function req(url, { method = 'GET', headers = {}, body, signal, timeout = REQ_MS } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  const onAbort = () => ctl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const r = await fetch(url, { method, headers, body, signal: ctl.signal })
    return { status: r.status, text: await r.text() }
  } catch {
    return { status: 0, text: '' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function result(source, lines, plain, score, instrumental = false) {
  return { source, lines, plain, score, instrumental, error: false }
}

// ---------- providers ----------
async function fromLrclib(meta, signal) {
  const q = new URLSearchParams({
    track_name: meta.title,
    artist_name: meta.artist,
    duration: String(meta.durationSec),
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await req('https://lrclib.net/api/get?' + q, { headers: { 'User-Agent': APP_UA }, signal })
    if (r.status === 429 || r.status === 503) {
      await sleep(600)
      continue
    }
    if (r.status === 404) return null
    if (r.status !== 200) return { error: true } // a 500 is an outage, not "no lyrics"
    const d = parseJson(r.text)
    if (!d) return { error: true }
    const { lines, instrumental } = cleanLines(parseLrc(d.syncedLyrics), meta)
    if (instrumental) return result('lrclib', [], [], 10, true)
    if (lines.length) return result('lrclib', lines, [], 10)
    const plain = String(d.plainLyrics ?? '')
      .split('\n')
      .map((s) => splitLyricParts(s.trim()))
      .filter((l) => l.text)
    return plain.length ? result('lrclib', [], plain, 10) : null
  }
  return { error: true }
}

async function fromLrclibSearch(meta, signal) {
  const q = new URLSearchParams({ track_name: meta.title, artist_name: meta.artist })
  const r = await req('https://lrclib.net/api/search?' + q, { headers: { 'User-Agent': APP_UA }, signal })
  if (r.status !== 200) return r.status === 404 ? null : { error: true }
  const arr = parseJson(r.text)
  if (!Array.isArray(arr)) return { error: true }
  const best = pickBest(
    arr.map((x) => ({
      title: x.trackName ?? x.name,
      artist: x.artistName,
      durationSec: Math.round(x.duration ?? 0),
      lrc: x.syncedLyrics,
      plain: x.plainLyrics,
      instrumental: x.instrumental,
    })),
    meta,
  )
  if (!best) return null
  if (best.instrumental) return result('lrclib-search', [], [], best.score, true)
  const { lines, instrumental } = cleanLines(parseLrc(best.lrc), meta)
  if (instrumental) return result('lrclib-search', [], [], best.score, true)
  if (lines.length) return result('lrclib-search', lines, [], best.score)
  const plain = String(best.plain ?? '')
    .split('\n')
    .map((s) => splitLyricParts(s.trim()))
    .filter((l) => l.text)
  return plain.length ? result('lrclib-search', [], plain, best.score) : null
}

async function fromKugou(meta, signal) {
  // search host only serves a matching cert over plain http
  const q = new URLSearchParams({
    format: 'json',
    keyword: `${meta.title} ${meta.artist}`,
    page: '1',
    pagesize: '8',
    showtype: '1',
  })
  const r = await req('http://mobilecdn.kugou.com/api/v3/search/song?' + q, {
    headers: { 'User-Agent': BROWSER_UA },
    signal,
  })
  if (r.status !== 200) return { error: true }
  const d = parseJson(r.text)
  if (!d) return { error: true }
  const best = pickBest(
    (d?.data?.info ?? []).map((x) => ({
      hash: x.hash,
      title: x.songname,
      artist: x.singername,
      durationSec: Number(x.duration ?? 0),
    })),
    meta,
  )
  if (!best) return null
  const kr = await req(
    'https://krcs.kugou.com/search?' +
      new URLSearchParams({
        ver: '1',
        man: 'yes',
        client: 'mobi',
        keyword: '',
        duration: String(best.durationSec),
        hash: best.hash,
      }),
    { headers: { 'User-Agent': BROWSER_UA }, signal },
  )
  if (kr.status !== 200) return { error: true }
  const kd = parseJson(kr.text)
  const cand = kd?.candidates?.[0]
  if (!cand) return null
  const dl = await req(
    'https://lyrics.kugou.com/download?' +
      new URLSearchParams({
        ver: '1',
        client: 'pc',
        id: cand.id,
        accesskey: cand.accesskey,
        fmt: 'lrc',
        charset: 'utf8',
      }),
    { headers: { 'User-Agent': BROWSER_UA }, signal },
  )
  if (dl.status !== 200) return { error: true }
  const dd = parseJson(dl.text)
  if (!dd?.content) return null
  const lrc = Buffer.from(dd.content, 'base64').toString('utf8')
  const { lines, instrumental } = cleanLines(parseLrc(lrc), meta)
  if (instrumental) return result('kugou', [], [], best.score, true)
  return lines.length ? result('kugou', lines, [], best.score) : null
}

async function fromQq(meta, signal) {
  const r = await req(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' +
      new URLSearchParams({ w: `${meta.title} ${meta.artist}`, format: 'json', n: '8', p: '1', cr: '1', t: '0' }),
    { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://y.qq.com/' }, signal },
  )
  if (r.status !== 200) return { error: true }
  const d = parseJson(r.text)
  if (!d) return { error: true }
  const best = pickBest(
    (d?.data?.song?.list ?? []).map((x) => ({
      mid: x.songmid,
      title: x.songname,
      artist: (x.singer ?? []).map((a) => a.name).join(','),
      durationSec: Number(x.interval ?? 0),
    })),
    meta,
  )
  if (!best) return null
  const l = await req(
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' +
      new URLSearchParams({ songmid: best.mid, format: 'json', nobase64: '1', g_tk: '5381' }),
    { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://y.qq.com/portal/player.html' }, signal },
  )
  if (l.status !== 200) return { error: true }
  // jsonp wrapper only when the response actually starts with a callback name
  const body = l.text.replace(/^[\w$.]+\s*\(/, '').replace(/\)\s*;?\s*$/, '')
  const ld = parseJson(body)
  if (!ld) return { error: true }
  const lrc = String(ld.lyric ?? '')
    .replace(/&#58;/g, ':')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
  if (!lrc.trim()) return null
  const { lines, instrumental } = cleanLines(parseLrc(lrc), meta)
  if (instrumental) return result('qq', [], [], best.score, true)
  if (lines.length) return result('qq', lines, [], best.score)
  // some QQ entries are plain text with no timestamps
  const plain = lrc
    .split('\n')
    .map((s) => splitLyricParts(s.replace(/\[[^\]]*\]/g, '').trim()))
    .filter((x) => x.text)
  return plain.length ? result('qq', [], plain, best.score) : null
}

async function fromNetease(meta, signal) {
  const s = await req(
    'https://music.163.com/api/search/get?' +
      new URLSearchParams({ s: `${meta.title} ${meta.artist}`, type: '1', limit: '8', offset: '0' }),
    { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://music.163.com/' }, signal },
  )
  if (s.status !== 200) return { error: true }
  const d = parseJson(s.text)
  if (!d) return { error: true }
  const best = pickBest(
    (d?.result?.songs ?? []).map((x) => ({
      id: x.id,
      title: x.name,
      artist: (x.artists ?? []).map((a) => a.name).join(','),
      durationSec: Math.round((x.duration ?? 0) / 1000),
    })),
    meta,
  )
  if (!best) return null
  const l = await req(`https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`, {
    headers: { 'User-Agent': BROWSER_UA, Referer: 'https://music.163.com/' },
    signal,
  })
  if (l.status !== 200) return { error: true }
  const ld = parseJson(l.text)
  if (!ld) return { error: true }
  const lrc = String(ld?.lrc?.lyric ?? '')
  if (!lrc.trim()) return null
  const { lines, instrumental } = cleanLines(parseLrc(lrc), meta)
  if (instrumental) return result('netease', [], [], best.score, true)
  return lines.length ? result('netease', lines, [], best.score) : null
}

async function fromLyricsOvh(meta, signal) {
  const r = await req(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(meta.artist)}/${encodeURIComponent(meta.title)}`,
    { headers: { 'User-Agent': APP_UA }, signal, timeout: 5000 },
  )
  if (r.status === 404) return null
  if (r.status !== 200) return { error: true }
  const d = parseJson(r.text)
  if (!d?.lyrics) return null
  const plain = String(d.lyrics)
    .split('\n')
    .map((s) => splitLyricParts(s.trim()))
    .filter((x) => x.text)
  // unvalidated text: only usable when nothing else matched, so score low
  return plain.length ? result('lyrics.ovh', [], plain, 0) : null
}

// ---------- entry ----------
// meta: { title, artist, durationSec }
export async function fetchLyrics(meta) {
  // LRCLIB exact is the best-timed source and usually answers in ~300ms, so it
  // gets the first shot alone: one request per song on the common path
  const exact = await fromLrclib(meta).catch(() => ({ error: true }))
  if (exact && !exact.error && (exact.lines.length || exact.instrumental)) return finish(exact)
  // miss or outage: ask the timed catalogs at once (each bounded by its own
  // timeout, so the slowest one sets the wait)
  const settled = await Promise.allSettled([
    fromLrclibSearch(meta),
    fromKugou(meta),
    fromQq(meta),
    fromNetease(meta),
  ])
  const all = [exact, ...settled.map((s) => (s.status === 'fulfilled' ? s.value : { error: true }))]
  const found = all.filter((r) => r && !r.error && (r.lines?.length || r.plain?.length || r.instrumental))
  // plain-text last resort: only worth its timeout when nothing else matched,
  // and never allowed to outrank a synced file
  if (!found.length) {
    const ovh = await fromLyricsOvh(meta).catch(() => ({ error: true }))
    all.push(ovh)
    if (ovh && !ovh.error && ovh.plain?.length) found.push(ovh)
  }
  if (!found.length) {
    // network failures must not be cached as "this song has no lyrics"
    return { instrumental: false, lines: [], plain: [], source: 'none', transient: all.some((r) => r?.error) }
  }
  found.sort(
    (a, b) =>
      (b.lines.length ? 1 : 0) - (a.lines.length ? 1 : 0) ||
      b.score - a.score ||
      b.lines.length - a.lines.length ||
      b.plain.length - a.plain.length,
  )
  return finish(found[0])
}

function finish(r) {
  return {
    instrumental: !!r.instrumental,
    lines: r.lines ?? [],
    plain: r.plain ?? [],
    source: r.source,
    transient: false,
  }
}
