import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { api } from './api'

type LrcLine = { ms: number; text: string; sub?: string }
type PlainLine = { text: string; sub?: string }
type LyricsData = { uri: string; instrumental: boolean; lines: LrcLine[]; plain: PlainLine[] }

const FOLLOW_RESUME_MS = 8000

// Karaoke view: highlights the active LRC line from the parent's live position
// and glides it to the center. A new song keeps the old lines up (dimmed, with
// a syncing note) until its own lyrics arrive — no blank flash. Manual scroll
// holds the follow for that song only; the hold is uri-scoped, so the next
// song auto-follows with no reset effect.
export default function LyricsView({
  uri,
  positionMs,
  onSync,
  fontClass = '',
  fluid = false,
}: {
  uri: string | null
  positionMs: number
  // reports whether the resolved song has synced lines, so a parent (ApMu)
  // can collapse the pane entirely when there is nothing to show
  onSync?: (uri: string | null, ok: boolean) => void
  // Thai font class applied to the lyrics container (e.g. 'lyrics-font-noto')
  fontClass?: string
  // Apple-Music look (big left-aligned lines, steep falloff) for /display + ApMu
  fluid?: boolean
}) {
  const [data, setData] = useState<LyricsData | null>(null)
  const [failedUri, setFailedUri] = useState<string | null>(null)
  const [held, setHeld] = useState(false)
  const [heldUri, setHeldUri] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const raf = useRef(0)
  const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!uri) return
    const ctl = new AbortController()
    api<LyricsData>(`/lyrics?uri=${encodeURIComponent(uri)}`, { signal: ctl.signal })
      .then((d) => {
        if (ctl.signal.aborted) return
        setData(d)
        onSync?.(uri, d.lines.length > 0)
      })
      .catch(() => {
        if (!ctl.signal.aborted) {
          setData(null)
          setFailedUri(uri)
          onSync?.(uri, false)
        }
      })
    return () => ctl.abort()
  }, [uri, onSync])

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      if (followTimer.current) clearTimeout(followTimer.current)
    },
    [],
  )

  const fresh = data && data.uri === uri ? data : null
  const stale = !!uri && !fresh
  const lines = (fresh ?? data)?.lines ?? []
  const follow = !(held && heldUri === uri)
  let active = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].ms <= positionMs) active = i

  // fluid opts /display + ApMu into the Apple-Music look; the karaoke view
  // keeps the original class. fontClass rides along either way.
  const lyricsClass = ['lyrics', fluid ? 'lyrics-fluid' : '', fontClass].filter(Boolean).join(' ')

  // eased glide toward the active line (re-targeted every line change),
  // instead of one jump per line. uri is a dep so a song change re-anchors
  // to the new scroll box instead of gliding toward a detached node.
  const glideToActive = useCallback(() => {
    if (!follow || active < 0) return
    const box = boxRef.current
    const el = box?.children[active] as HTMLElement | undefined
    if (!box || !el) return
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      box.scrollTop = target
      return
    }
    cancelAnimationFrame(raf.current)
    // Time-based ease (not per-frame lerp) so the glide finishes in the same
    // wall-clock time even on a slow projector/headless render loop. A fixed
    // per-frame factor crawls for seconds when the frame rate drops.
    const startAt = performance.now()
    const startTop = box.scrollTop
    const dist = target - startTop
    const duration = Math.min(620, 220 + Math.abs(dist) * 0.35)
    const step = () => {
      const b = boxRef.current
      if (!b) return
      const p = Math.min(1, (performance.now() - startAt) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      b.scrollTop = startTop + dist * eased
      if (p < 1) raf.current = requestAnimationFrame(step)
      else b.scrollTop = target
    }
    raf.current = requestAnimationFrame(step)
  }, [active, follow, uri])

  useEffect(() => {
    glideToActive()
    return () => cancelAnimationFrame(raf.current)
  }, [glideToActive])

  // re-anchor when the box geometry changes. Leaving ApMu narrows the column,
  // rewrapping every line and shifting their offsets — without this the same
  // scrollTop lands pages off (a flash of the song start) until the next line
  // change glides it back. Debounced so only the settled size glides.
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(glideToActive, 200)
    })
    ro.observe(box)
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [glideToActive])

  const pauseFollow = () => {
    setHeldUri(uri)
    setHeld(true)
    if (followTimer.current) clearTimeout(followTimer.current)
    followTimer.current = setTimeout(() => {
      setHeld(false)
      setHeldUri(null)
    }, FOLLOW_RESUME_MS)
  }

  if (!uri) return <p className="muted">Nothing playing.</p>
  if (!data) return <p className="muted">{failedUri === uri ? 'Couldn’t load lyrics.' : 'Loading lyrics…'}</p>
  if (fresh?.instrumental) return <p className="muted">Instrumental — no lyrics.</p>
  if (lines.length)
    return (
      <div className="lyrics-wrap">
        {stale && (
          <div className="sync-pill" aria-live="polite">
            Loading lyrics…
          </div>
        )}
        {/* key remounts the scroll box per song so it starts at the top */}
        <div
          key={uri}
          ref={boxRef}
          className={lyricsClass}
          onWheel={pauseFollow}
          onTouchMove={pauseFollow}
        >
          {lines.map((l, i) => {
            const dist = Math.abs(i - active)
            const o = stale
              ? 0.35
              : i === active
                ? 1
                : fluid
                  ? Math.max(0, 0.68 - dist * 0.26)
                  : Math.max(0.22, 0.62 - dist * 0.1)
            // Apple-Music-style depth: inactive lines soften with distance,
            // the active line stays razor sharp. Fluid drops neighbours off
            // faster so only a couple read at once.
            const blur =
              stale || i === active
                ? 0
                : fluid
                  ? Math.min(0.5 + dist * 1.15, 8)
                  : Math.min(0.4 + dist * 0.5, 2.5)
            return (
              <p
                key={i}
                className={i === active && !stale ? 'lyric active' : 'lyric'}
                style={{ '--o': o, ...(blur ? { filter: `blur(${blur}px)` } : {}) } as CSSProperties}
              >
                {l.text}
                {l.sub && <span className="lyric-sub">{l.sub}</span>}
              </p>
            )
          })}
        </div>
        {!follow && (
          <button className="follow-pill" onClick={() => setHeld(false)}>
            Resume follow
          </button>
        )}
      </div>
    )
  if (fresh && fresh.plain.length)
    return (
      <div key={uri} ref={boxRef} className={lyricsClass}>
        {fresh.plain.map((t, i) => (
          <p key={i} className="lyric" style={{ '--o': 0.75 } as CSSProperties}>
            {t.text}
            {t.sub && <span className="lyric-sub">{t.sub}</span>}
          </p>
        ))}
      </div>
    )
  if (fresh) return <p className="muted">No synced lyrics for this song.</p>
  return <p className="muted">Loading lyrics…</p>
}
