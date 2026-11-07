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
