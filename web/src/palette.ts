import { useEffect, useState } from 'react'

export type Palette = [top: string, bottom: string] | null

// Spotify-style backdrop colors sampled from cover art: average of the top
// half and the bottom half, darkened so white text stays readable.
// Colors are returned only for the requested url: while new art loads (or
// there is none) this is null, so callers render their fallback background
// instead of a stale gradient from the previous song.
export function usePalette(url: string | null | undefined): Palette {
  const [cached, setCached] = useState<{ url: string; colors: [string, string] } | null>(null)

  useEffect(() => {
    if (!url) return
    let live = true
    const img = new Image()
    img.crossOrigin = 'anonymous' // same-origin /api/art proxy: always readable
    img.onerror = () => {
      if (live) console.warn('palette: sampling image failed to load')
    }
    img.onload = () => {
      try {
        const w = 24
        const h = 24
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const ctx = cv.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, w, h)
        const d = ctx.getImageData(0, 0, w, h).data
        const avg = (y0: number, y1: number) => {
          let r = 0
          let g = 0
          let b = 0
          let n = 0
          for (let y = y0; y < y1; y++)
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4
              if (d[i + 3] < 128) continue
              r += d[i]
              g += d[i + 1]
              b += d[i + 2]
              n++
            }
          if (!n) return 'rgb(20, 20, 20)'
          // darken + slightly desaturate toward a backdrop, not a copy of the art
          const k = 0.5
          const gray = ((r + g + b) / n / 3) * k
          const mix = (v: number) => Math.round((v / n) * k * 0.85 + gray * 0.15)
          return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
        }
        if (live) setCached({ url, colors: [avg(0, h / 2), avg(h / 2, h)] })
      } catch {
        if (live) console.warn('palette: canvas unreadable for', url)
      }
    }
    img.src = url
    return () => {
      live = false
    }
  }, [url])

  return cached && cached.url === url ? cached.colors : null
}

// ---------- mesh palette ----------
// The backdrop wants four vivid blobs plus a near-black base. The old
// top/bottom pair above is kept for the Spotify-style gradient callers, but
// the mesh uses a quantized palette so a cover with one dominant hue still
// produces a few distinct blobs.

export const DEFAULT_PALETTE = [
  '#1b3a8f',
  '#0e7c86',
  '#5b3fbf',
  '#b23a8f',
  '#05060a',
] as const

export type MeshPalette = string[]

const PALETTE_CACHE = new Map<string, MeshPalette>()
const PALETTE_INFLIGHT = new Map<string, Promise<MeshPalette>>()

type Candidate = { r: number; g: number; b: number; n: number; h: number; s: number; l: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0)
  else if (max === gg) h = (bb - rr) / d + 2
  else h = (rr - gg) / d + 4
  return [h / 6, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  let r: number
  let g: number
  let b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  const hex = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function colorDistance(a: Candidate, b: Candidate) {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function quantize(data: Uint8ClampedArray): MeshPalette {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.n++
    } else {
      buckets.set(key, { r, g, b, n: 1 })
    }
  }
  if (!buckets.size) return [...DEFAULT_PALETTE]

  const candidates: Candidate[] = [...buckets.values()]
    .map((bucket) => {
      const r = bucket.r / bucket.n
      const g = bucket.g / bucket.n
      const b = bucket.b / bucket.n
      const [h, s, l] = rgbToHsl(r, g, b)
      return { r, g, b, n: bucket.n, h, s, l }
    })
    .sort((a, b) => b.n - a.n)

  const vivid = candidates.filter((c) => c.s > 0.16 && c.l > 0.1 && c.l < 0.84)
  const chosen: Candidate[] = []
  for (const c of vivid) {
    if (chosen.every((o) => colorDistance(c, o) > 52)) chosen.push(c)
    if (chosen.length === 4) break
  }
  for (const c of candidates) {
    if (chosen.length === 4) break
    if (chosen.every((o) => colorDistance(c, o) > 40)) chosen.push(c)
  }

  const liftSat = (c: Candidate) => Math.min(0.9, Math.max(0.35, c.s * 1.2 + 0.08))
  const liftLum = (c: Candidate) => Math.min(0.62, Math.max(0.28, c.l))
  const blobs = chosen.map((c) => hslToHex(c.h, liftSat(c), liftLum(c)))

  // A cover with fewer than four distinct hues (a solid red sleeve, a mostly
  // black cover) must not borrow the unrelated default blob colours: the
  // shader adds the blobs, so blue+teal+magenta over a solid cover sum to a
  // grey/purple wash. Instead tilt the hue of the colour we did find, so vivid
  // art stays vivid (red stays red) and a muted/dark cover stays moody.
  const seed = chosen[0]
  if (seed) {
    const offsets = [0.045, -0.05, 0.1]
    const muted = seed.s <= 0.16 || seed.l < 0.16
    const s = muted ? Math.min(0.32, seed.s + 0.08) : liftSat(seed)
    const l = muted ? Math.max(0.12, Math.min(0.2, seed.l + 0.06)) : liftLum(seed)
    for (let i = 0; blobs.length < 4; i++) {
      const h = (seed.h + offsets[i % offsets.length] + 1) % 1
      blobs.push(hslToHex(h, s, l))
    }
  }
  while (blobs.length < 4) blobs.push(DEFAULT_PALETTE[blobs.length])

  const darkest = candidates.reduce((best, c) => (c.l < best.l ? c : best), candidates[0])
  const base = hslToHex(darkest.h, Math.min(0.5, darkest.s), 0.035)
  return [...blobs.slice(0, 4), base]
}

function artProxyUrl(url: string) {
  // Same-origin proxy so the sampling canvas stays readable regardless of
  // the CDN's CORS behavior on the host machine.
  return /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(url)
    ? `/api/art?img=${encodeURIComponent(url)}`
    : url
}

function samplePalette(url: string): Promise<MeshPalette> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onerror = () => resolve([...DEFAULT_PALETTE])
    img.onload = () => {
      try {
        const size = 48
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve([...DEFAULT_PALETTE])
        ctx.drawImage(img, 0, 0, size, size)
        resolve(quantize(ctx.getImageData(0, 0, size, size).data))
      } catch {
        resolve([...DEFAULT_PALETTE])
      }
    }
    img.src = artProxyUrl(url)
  })
}

export async function extractPalette(url: string): Promise<MeshPalette> {
  const cached = PALETTE_CACHE.get(url)
  if (cached) return cached
  const pending = PALETTE_INFLIGHT.get(url)
  if (pending) return pending
  const promise = samplePalette(url)
    .catch(() => [...DEFAULT_PALETTE] as MeshPalette)
    .then((palette) => {
      PALETTE_INFLIGHT.delete(url)
      PALETTE_CACHE.set(url, palette)
      if (PALETTE_CACHE.size > 24) {
        const oldest = PALETTE_CACHE.keys().next().value
        if (oldest) PALETTE_CACHE.delete(oldest)
      }
      return palette
    })
  PALETTE_INFLIGHT.set(url, promise)
  return promise
}

export function useArtPalette(url: string | null | undefined): MeshPalette {
  const [palette, setPalette] = useState<MeshPalette>(() => [...DEFAULT_PALETTE])
  useEffect(() => {
    let live = true
    if (!url) {
      setPalette([...DEFAULT_PALETTE])
      return () => {
        live = false
      }
    }
    void extractPalette(url).then((next) => {
      if (live) setPalette(next)
    })
    return () => {
      live = false
    }
  }, [url])
  return palette
}
