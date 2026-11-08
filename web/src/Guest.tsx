import { useCallback, useEffect, useRef, useState } from 'react'
import { api, eta, fmt, useJukebox, useTicker } from './api'
import LyricsView from './LyricsView'
import MeshBackdrop from './MeshBackdrop'
import Stats from './Stats'
import Status from './Status'
import {
  IconClock,
  IconClose,
  IconColumns,
  IconExpand,
  IconFont,
  IconMic,
  IconNote,
  IconPlus,
  IconRefresh,
  IconWifiOff,
} from './icons'
import type { Now, Track } from './api'
import type { BeatSignal, MeshLevels } from './useMeshAudio'

const SEARCH_DELAY = 250
const CELEBRATION_MS = 5000
const LEAD_OUT_MS = 5000 // TV lyrics view exits this long before the song ends
const INTRO_MS = 5000 // ...and waits this long into the new song before returning

// The TV signage (song view, lyrics view, and ApMu) uses the same mesh
// backdrop as /display, but this page captures no audio of its own, so the
// backdrop runs in idle mode (slow drift, no reaction). A module-scope
// sampler keeps `sample` referentially stable, so MeshBackdrop is not torn
// down and re-created on every render.
const IDLE_MESH: MeshLevels = {
  beat: false,
  beatAt: 0,
  beatSeq: 0,
  strength: 0,
  bass: 0,
  energy: 0,
  rawBass: 0,
  mid: 0,
  treble: 0,
  shimmer: 0,
  threshold: 0,
  flux: 0,
  rms: 0,
  latencyMs: 0,
  pulsesPer10s: 0,
  intervals: [],
  mode: 'idle',
}
const sampleIdleMesh = () => IDLE_MESH

export default function Guest() {
  const { state, offline, refresh } = useJukebox()
  const cooldownMs = state?.cooldownMs ?? 0
  const isLocal = state?.local ?? false
  // anchor the countdown to a client clock so polls don't resync it
  const [cooldownEnd, setCooldownEnd] = useState(0)
  useEffect(() => {
    if (cooldownMs <= 0) return
    setCooldownEnd((prev) => {
      const next = Date.now() + cooldownMs
      return next > prev + 500 ? next : prev
    })
  }, [cooldownMs])
  useEffect(() => {
    if (cooldownMs <= 0) setCooldownEnd(0)
  }, [cooldownMs])

  const liveNow = state?.now ?? null
  const cooling = cooldownEnd > 0
  // smooth 500ms for progress, 1s is enough when only the cooldown is running
  const clock = useTicker(cooling || !!liveNow?.isPlaying, liveNow?.isPlaying ? 500 : 1000)
  const cool = isLocal ? 0 : Math.max(0, Math.ceil((cooldownEnd - clock) / 1000))

  const elapsed = liveNow
    ? Math.min(liveNow.durationMs, liveNow.progressMs + (liveNow.isPlaying ? clock - liveNow.at : 0))
    : 0
  const showCelebration = !!liveNow?.mine && elapsed < CELEBRATION_MS
  const progressPct = liveNow ? Math.min(100, (elapsed / liveNow.durationMs) * 100) : 0

  const status: 'live' | 'paused' | 'starting' | 'idle' = liveNow
    ? liveNow.isPlaying
      ? 'live'
      : 'paused'
    : state?.playerWaiting
      ? 'starting'
      : 'idle'
  const statusTone = offline ? 'offline' : status

  const [q, setQ] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState('')
  const [removing, setRemoving] = useState('')
  const [signage, setSignage] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const searchCtl = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // leaving fullscreen (Esc, gesture) also leaves signage mode
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) {
        setSignage(false)
        setLyricsMode(false) // match exitSignage: next entry starts on the song view
        setApmuView(false)
      }
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // exit button + cursor only show shortly after mouse/touch activity
  const [showExit, setShowExit] = useState(true)
  const [showProgress, setShowProgress] = useState(true)
  const [lyricsMode, setLyricsMode] = useState(false)
  // ApMu is a TV layout (art + progress left, lyrics right), not a route
  const [apmuView, setApmuView] = useState(false)
  // Thai font for lyrics: system fonts only, no webfont downloads. Persisted per browser.
  const THAI_FONTS = [
    { id: 'auto', label: 'Auto' },
    { id: 'noto', label: 'Noto Sans Thai' },
    { id: 'leelawadee', label: 'Leelawadee UI' },
    { id: 'thonburi', label: 'Thonburi' },
    { id: 'sarabun', label: 'Sarabun' },
  ] as const
  const THAI_FONT_KEY = 'jb_thai_font'
  const savedFont = (() => {
    try {
      const v = localStorage.getItem(THAI_FONT_KEY)
      return v && THAI_FONTS.some((f) => f.id === v) ? (v as typeof THAI_FONTS[number]['id']) : 'auto'
    } catch {
      return 'auto'
    }
  })()
  const [lyricsFont, setLyricsFont] = useState<typeof THAI_FONTS[number]['id']>(savedFont)
  const lyricsFontClass = lyricsFont === 'auto' ? '' : `lyrics-font-${lyricsFont}`
  useEffect(() => {
    try {
      localStorage.setItem(THAI_FONT_KEY, lyricsFont)
    } catch {
      // private mode: font still applies for this tab
    }
  }, [lyricsFont])
  const cycleThaiFont = () => {
    const idx = THAI_FONTS.findIndex((f) => f.id === lyricsFont)
    setLyricsFont(THAI_FONTS[(idx + 1) % THAI_FONTS.length].id)
  }

  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!signage) return
    const poke = () => {
      setShowExit(true)
      if (exitTimer.current) clearTimeout(exitTimer.current)
      exitTimer.current = setTimeout(() => setShowExit(false), 2500)
    }
    poke() // visible on entry, then starts the countdown
    window.addEventListener('mousemove', poke)
    window.addEventListener('touchstart', poke, { passive: true })
    return () => {
      window.removeEventListener('mousemove', poke)
      window.removeEventListener('touchstart', poke)
      if (exitTimer.current) clearTimeout(exitTimer.current)
    }
  }, [signage])

  const enterSignage = (apmu = false) => {
    setApmuView(apmu)
    setSignage(true)
    // guarded: older browsers lack the Fullscreen API (signage still works inline)
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }
  // deep link (e.g. from /display): /?tv=apmu opens TV straight into ApMu
  const enteredDeep = useRef(false)
  useEffect(() => {
    if (enteredDeep.current) return
    enteredDeep.current = true
    if (new URLSearchParams(window.location.search).get('tv') === 'apmu') enterSignage(true)
    // enterSignage is stable-by-construction here (setState + guarded fullscreen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const exitSignage = () => {
    // Exit fullscreen BEFORE unmounting the fixed TV layer: tearing both down
    // in the same frame can leave a ghost dim/blur frame on some browsers.
    if (!document.fullscreenElement) {
      setSignage(false)
      setLyricsMode(false)
      setApmuView(false)
      return
    }
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      document.removeEventListener('fullscreenchange', done)
      setSignage(false)
      setLyricsMode(false)
      setApmuView(false)
    }
    document.addEventListener('fullscreenchange', done)
    setTimeout(done, 400) // fallback if the event never arrives
    try {
      document.exitFullscreen().catch(done)
    } catch {
      done()
    }
  }
  // slow song-change dissolve: fade the old song out, swap, rise into the new one.
  // Time/progress below always read the live values; only art/identity dissolves.
  // The swap waits for the new cover (past the 750ms fade, capped at 2.5s) so it
  // never lands on a blank frame while the CDN responds.
  const [shown, setShown] = useState<Now | null>(() => liveNow)
  const shownUri = useRef<string | null>(liveNow?.uri ?? null)
  const [songFading, setSongFading] = useState(false)
  // wall-clock moment the TV first saw the current song: the intro hold runs
  // from detection, not from Spotify's progress (poll lag means progress
  // already reads seconds in by the time we notice the change)
  const [songEnteredAt, setSongEnteredAt] = useState(0)
  const uri = liveNow?.uri ?? null
  useEffect(() => {
    if (shownUri.current === uri) return
    shownUri.current = uri
    setSongFading(true)
    setSongEnteredAt(Date.now())
    let cancelled = false
    const swap = () => {
      if (cancelled) return
      setShown(liveNow)
      setSongFading(false)
    }
    if (!liveNow?.image) {
      const t = setTimeout(swap, 750)
      return () => {
        cancelled = true
        clearTimeout(t)
      }
    }
    const pre = new Image()
    let settled = false
    const cap = setTimeout(() => {
      if (!settled) {
        settled = true
        swap()
      }
    }, 2500)
    const ready = () => {
      if (settled) return
      settled = true
      clearTimeout(cap)
      setTimeout(swap, 750) // swap() is cancelled-guarded, no cleanup needed
    }
    pre.onload = ready
    pre.onerror = ready
    pre.src = liveNow.image
    return () => {
      cancelled = true
      clearTimeout(cap)
    }
    // liveNow is captured intentionally: the song as it first appeared
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri])
  const songForArt = shown ?? liveNow
  // time/progress are the live audio clock (only art/identity dissolves),
  // so they never snap to 0:00 mid-transition
  const tvElapsed = elapsed
  const tvPct = progressPct
  // Duration always reads the live song (not the dissolving artwork) so the
  // time display never shows "new elapsed / old duration" mid-transition.
  const tvDuration = liveNow?.durationMs ?? 0
  // lead-out: leave the lyrics view shortly before the song ends (and stay
  // out while the art dissolves) so the swap always plays on the song view,
  // then wait out the new song's intro before gliding back into its lyrics.
  // lyricsMode is the sticky user intent; showLyrics is what's on screen.
  const endingSoon =
    !!liveNow && liveNow.isPlaying && liveNow.durationMs - tvElapsed < LEAD_OUT_MS
  const introHold = Date.now() - songEnteredAt < INTRO_MS
  const showLyrics = lyricsMode && !endingSoon && !songFading && !introHold
  // ApMu inter-song dissolve: start fading 2s before the song ends and stay
  // out through the art swap, so the new song rises in instead of popping.
  // Identity reads songForArt (the dissolving song); time stays live.
  const apmuLeaving =
    !!liveNow && liveNow.isPlaying && liveNow.durationMs - tvElapsed < 2000
  const apmuFading = apmuLeaving || songFading
  // ApMu hides the lyrics pane when the song has no synced lines (artwork +
  // song info center instead). Unknown counts as shown, matching LyricsView's
  // stale-while-revalidate display; the pane collapses once absence confirms.
  const [apmuSync, setApmuSync] = useState<{ uri: string | null; ok: boolean }>({ uri: null, ok: false })
  const reportApmuSync = useCallback((u: string | null, ok: boolean) => {
    setApmuSync({ uri: u, ok })
  }, [])
  const apmuShowLyrics = !!uri && (apmuSync.uri !== uri || apmuSync.ok)
  const apmuGridClass = 'apmu-grid' + (apmuShowLyrics ? '' : ' solo') + (apmuFading ? ' leaving' : '')
  // Shared beat bus for MeshBackdrop; idle mode never publishes a beat, so the
  // ring-less TV page just needs a stable ref to satisfy the backdrop contract.
  const meshBeatBus = useRef<BeatSignal>({
    seq: 0,
    detSeq: -1,
    at: 0,
    strength: 0,
    source: 'audio',
    listenerUntil: 0,
  })

  // success toast auto-dismisses; errors stay until the next keystroke
  useEffect(() => {
    if (!msg?.ok) return
    const t = setTimeout(() => setMsg(null), 4000)
    return () => clearTimeout(t)
  }, [msg])

  const runSearch = async (term: string) => {
    searchCtl.current?.abort()
    const ctl = new AbortController()
    searchCtl.current = ctl
    setSearching(true)
    try {
      const r = await api<Track[]>(`/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
      if (!ctl.signal.aborted) setResults(r)
    } catch (e) {
      if (ctl.signal.aborted) return
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      if (searchCtl.current === ctl) setSearching(false)
    }
  }

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      if (timer.current) clearTimeout(timer.current)
      searchCtl.current?.abort()
      setResults([])
      setSearching(false)
      return
    }
    // keep old results visible while the new query loads
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => runSearch(term), SEARCH_DELAY)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const searchNow = () => {
    const term = q.trim()
    if (term.length < 2) return
    if (timer.current) clearTimeout(timer.current)
    void runSearch(term)
  }

  const request = async (t: Track) => {
    if (cool > 0) return
    setBusy(t.uri)
    setMsg(null)
    try {
      await api('/request', { method: 'POST', body: { uri: t.uri } })
      setMsg({ ok: true, text: `Added “${t.name}” to the queue!` })
      setQ('')
      setResults([])
    } catch (e) {
      const text = (e as Error).message
      // the live countdown already shows how long to wait
      if (!text.startsWith('Please wait')) setMsg({ ok: false, text })
    } finally {
      setBusy('')
      refresh() // picks up the new queue and the cooldown
    }
  }

  const waitFor = (i: number) =>
    (state?.now?.remainingMs ?? 0) +
    ((state?.externalQueue ?? []).reduce((s, x) => s + x.durationMs, 0) ?? 0) +
    (state?.queue.slice(0, i).reduce((s, x) => s + x.durationMs, 0) ?? 0)

  const etaFor = (i: number) =>
    !state?.now
      ? state?.playerError
        ? 'waiting for the player'
        : 'starting soon'
      : `starts in ${eta(waitFor(i))}`

  const showResults = q.trim().length >= 2
  const myCount = state?.queue.filter((t) => t.mine).length ?? 0
  const maxPending = state?.limits.maxPending ?? 2

  const cancel = async (id: string) => {
    setRemoving(id)
    try {
      await api(`/queue/${id}`, { method: 'DELETE' })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setRemoving('')
      refresh()
    }
  }

  // TV signage: only Now Playing, big. Polling + ticker keep running underneath.
  if (signage) {
    return (
      <main className="signage" style={{ cursor: showExit ? undefined : 'none' }}>
        <MeshBackdrop
          enabled
          artUrl={songForArt?.image ?? null}
          sample={sampleIdleMesh}
          beatBus={meshBeatBus}
        />
        <div className="signage-shade" aria-hidden="true" />
        <div className={showExit ? 'signage-controls' : 'signage-controls hidden'}>
          <button
            className="gray signage-btn"
            onClick={() => setLyricsMode((v) => !v)}
            tabIndex={showExit ? 0 : -1}
            aria-pressed={lyricsMode}
          >
            <IconMic size={14} />
            Lyrics
          </button>
          <button
            className="gray signage-btn"
            onClick={() => setApmuView((v) => !v)}
            tabIndex={showExit ? 0 : -1}
            aria-pressed={apmuView}
            title="ApMu: artwork and lyrics side by side"
          >
            <IconColumns size={14} />
            ApMu
          </button>
          <button
            className="gray signage-btn"
            onClick={cycleThaiFont}
            tabIndex={showExit ? 0 : -1}
            aria-pressed={lyricsFont !== 'auto'}
            title={`Lyrics font: ${THAI_FONTS.find((f) => f.id === lyricsFont)?.label}`}
          >
            <IconFont size={14} />
            font
          </button>
          <button
            className="gray signage-btn"
            onClick={() => setShowProgress((v) => !v)}
            tabIndex={showExit ? 0 : -1}
            aria-pressed={showProgress}
          >
            <IconClock size={14} />
            {showProgress ? 'Hide time' : 'Show time'}
          </button>
          <button className="gray signage-btn" onClick={exitSignage} tabIndex={showExit ? 0 : -1}>
            <IconClose size={14} />
            Exit
          </button>
        </div>
        <div className={apmuView ? 'signage-content wide' : 'signage-content'} aria-live="polite">
          <div className="signage-swap">
            <div
              className={!showLyrics && !apmuView ? 'signage-view' : 'signage-view hidden-view'}
              aria-hidden={showLyrics || apmuView}
            >
              <div className={songFading ? 'signage-song fading' : 'signage-song'}>
            {songForArt ? (
              <>
                {songForArt.image ? (
                  <img className="signage-art" src={songForArt.image} alt="" />
                ) : (
                  <div className="signage-art placeholder"><IconNote size={96} /></div>
                )}
                <div className="signage-title">
                  {songForArt.name}
                  {songForArt.explicit && <span className="tag">E</span>}
                </div>
                <div className="signage-artist">{songForArt.artists}</div>
                <div
                  className={showProgress ? 'signage-timewrap' : 'signage-timewrap collapsed'}
                  aria-hidden={!showProgress}
                >
                  <div className="signage-time">
                    {fmt(tvElapsed)} / {fmt(tvDuration)}
                  </div>
                  <div
                    key={uri ?? 'idle'}
                    className="progress signage-progress"
                    role="progressbar"
                    aria-valuenow={Math.round(tvPct)}
                  >
                    <i style={{ width: `${tvPct}%` }} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="signage-art placeholder"><IconNote size={96} /></div>
                <div className="signage-title">Nothing playing yet</div>
                <div className="signage-artist">Scan the QR code and request a song!</div>
              </>
            )}
              </div>
            </div>
            <div
              className={showLyrics && !apmuView ? 'signage-view' : 'signage-view hidden-view'}
              aria-hidden={!showLyrics || apmuView}
            >
              <div className="signage-lyrics">
                {liveNow && (
                  <div className="lyrics-song">
                    {liveNow.name} — {liveNow.artists}
                  </div>
                )}
                {/* LyricsView keeps the old lines up (dimmed) until the new song's
                    own lyrics arrive — no blank flash on change */}
                <LyricsView uri={liveNow?.uri ?? null} positionMs={tvElapsed} fontClass={lyricsFontClass} />
              </div>
            </div>
            <div
              className={apmuView ? 'signage-view' : 'signage-view hidden-view'}
              aria-hidden={!apmuView}
            >
              <div className={apmuGridClass}>
                <section className="apmu-left">
                  {songForArt?.image ? (
                    <img className="apmu-art" src={songForArt.image} alt="" />
                  ) : (
                    <div className="apmu-art placeholder"><IconNote size={80} /></div>
                  )}
                  <div className="apmu-title">
                    {songForArt?.name ?? 'Nothing playing yet'}
                    {songForArt?.explicit && <span className="tag">E</span>}
                  </div>
                  <div className="apmu-artist">
                    {songForArt?.artists ?? 'Scan the QR code and request a song!'}
                  </div>
                  {liveNow && showProgress && (
                    <>
                      <div
                        key={uri ?? 'idle'}
                        className="progress apmu-progress"
                        role="progressbar"
                        aria-valuenow={Math.round(tvPct)}
                      >
                        <i style={{ width: `${tvPct}%` }} />
                      </div>
                      <div className="apmu-times">
                        <span>{fmt(tvElapsed)}</span>
                        <span>-{fmt(tvDuration - tvElapsed)}</span>
                      </div>
                    </>
                  )}
                </section>
                {apmuShowLyrics && (
                  <section className="apmu-right" aria-label="Lyrics">
                    <LyricsView uri={liveNow?.uri ?? null} positionMs={tvElapsed} onSync={reportApmuSync} fontClass={lyricsFontClass} fluid />
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={offline ? 'wrap offline' : 'wrap'}>
      <header className="top">
        <div className="brand">
          <IconNote size={18} />
          <span className="brand-name">Jukebox</span>
          <span className="brand-sub">workshop</span>
        </div>
        <Status tone={statusTone} />
      </header>

      {/* offline is a banner, not a takeover: the last known queue and song are
          still worth reading while a dropped phone reconnects */}
      {offline && (
        <div className="banner" role="status">
          <IconWifiOff size={17} />
          <span className="banner-text">Can’t reach the server. Retrying…</span>
          <button className="sm" onClick={() => refresh()} aria-label="Retry connecting">
            <IconRefresh size={14} />
            Retry
          </button>
        </div>
      )}

      <section className="card" aria-live="polite">
        <div className="section-head">
          <h2>Now playing</h2>
          <div className="head-right">
            {liveNow && (
              <span className="meta">
                {fmt(elapsed)} / {fmt(liveNow.durationMs)}
              </span>
            )}
            <button
              className="ghost head-btn"
              onClick={() => enterSignage(false)}
              title="Fullscreen for a projector or TV"
            >
              <IconExpand size={14} />
              Fullscreen
            </button>
          </div>
        </div>
        {liveNow ? (
          <div className="hero">
            {liveNow.image ? (
              <img className="art" src={liveNow.image} alt="" />
            ) : (
              <div className="art placeholder"><IconNote size={30} /></div>
            )}
            <div className="hero-meta">
              <div className="title">
                {liveNow.name}
                {liveNow.explicit && <span className="tag">E</span>}
                {liveNow.mine && <span className="badge">yours</span>}
              </div>
              <div className="subtitle">{liveNow.artists}</div>
              {showCelebration ? (
                <div className="celebrate">Your request is playing</div>
              ) : (
                <div className="status-line">
                  {liveNow.isPlaying ? (
                    <>
                      <span className="eq" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      Playing
                    </>
                  ) : (
                    'Paused'
                  )}
                </div>
              )}
              <div
                key={uri ?? 'idle'}
                className="progress"
                role="progressbar"
                aria-valuenow={Math.round(progressPct)}
              >
                <i style={{ width: `${progressPct}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="hero">
              <div className="art placeholder"><IconNote size={30} /></div>
              <div className="hero-meta">
                <div className="title">Nothing playing yet</div>
                <div className="subtitle">Your request will start the music.</div>
                {state?.playerWaiting &&
                  (state.playerError ? (
                    <div className="toast toast-err" style={{ marginTop: 8 }}>
                      {state.playerMessage ??
                        'Can’t reach the Spotify player. Ask the host to open Spotify on the laptop.'}
                    </div>
                  ) : (
                    <div className="status-line">
                      <span className="eq" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      Starting the music…
                    </div>
                  ))}
              </div>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Request a song</h2>
          <span className="meta">
            {isLocal ? 'No limit on this device' : `${myCount} of ${maxPending} in queue`}
          </span>
        </div>
        <div className="search-wrap">
          <input
            type="search"
            value={q}
            placeholder="Search for a song or artist"
            aria-label="Search for a song or artist"
            onChange={(e) => {
              setQ(e.target.value)
              setMsg(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') searchNow()
            }}
          />
          {q && (
            <button
              className="clear-btn"
              aria-label="Clear search"
              onClick={() => {
                setQ('')
                setResults([])
                setMsg(null)
              }}
            >
              ×
            </button>
          )}
        </div>
        <div className="slot" aria-live="polite">
          {!isLocal && cool > 0 && (
            <div className="cool-chip">
              <IconClock size={15} />
              Next request in {cool}s
              <span className="progress">
                <i
                  style={{
                    width: `${Math.min(100, (cool / (state?.limits.cooldownSec ?? 20)) * 100)}%`,
                  }}
                />
              </span>
            </div>
          )}
          {msg && <div className={msg.ok ? 'toast toast-ok' : 'toast toast-err'}>{msg.text}</div>}
        </div>
        {showResults && searching && results.length === 0 && (
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel-row" aria-hidden="true">
                <div className="skel" style={{ width: 52, height: 52 }} />
                <div style={{ flex: 1 }}>
                  <div className="skel" style={{ height: 14, width: '70%', marginBottom: 6 }} />
                  <div className="skel" style={{ height: 12, width: '45%' }} />
                </div>
              </div>
            ))}
            <p className="muted hint">Searching…</p>
          </>
        )}
        {showResults && searching && results.length > 0 && <p className="muted hint">Updating…</p>}
        {showResults && !searching && results.length === 0 && (
          <p className="muted">No matches. Try another song or artist.</p>
        )}
        <ul>
          {results.map((t) => {
            const disabled = busy === t.uri || cool > 0
            return (
              <li key={t.uri} className="row track">
                {t.image ? (
                  <img className="art sm" src={t.image} alt="" loading="lazy" />
                ) : (
                  <div className="art sm placeholder"><IconNote size={20} /></div>
                )}
                <div className="grow">
                  <div className="track-name">
                    <strong>{t.name}</strong>
                    {t.explicit && <span className="tag">E</span>}
                  </div>
                  <div className="muted">
                    {t.artists} · {fmt(t.durationMs)}
                  </div>
                </div>
                <button
                  className="add"
                  disabled={disabled}
                  title={cool > 0 ? `Wait ${cool}s` : undefined}
                  aria-label={`Request ${t.name}`}
                  onClick={() => request(t)}
                >
                  <IconPlus size={14} />
                  {busy === t.uri ? 'Adding…' : 'Request'}
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Up next</h2>
          <span className="meta">
            {(state?.queue.length ?? 0) + (state?.externalQueue?.length ?? 0)} waiting
          </span>
        </div>
        {state?.queue.length ? (
          <ol>
            {state.queue.map((t, i) => (
              <li key={t.id} className={t.mine ? 'row q-item mine' : 'row q-item'}>
                <span className="num">{i + 1}</span>
                <div className="grow">
                  <div className="q-name">
                    <strong>{t.name}</strong>
                    {t.mine && <span className="badge">yours</span>}
                  </div>
                  <div className="muted">
                    {t.artists}
                    {t.mine && ` · ${etaFor(i)}`}
                  </div>
                </div>
                {t.mine && (
                  <button
                    className="icon-btn"
                    aria-label={`Cancel ${t.name}`}
                    disabled={removing === t.id}
                    onClick={() => cancel(t.id)}
                  >
                    {removing === t.id ? '…' : <IconClose size={15} />}
                  </button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Nothing queued yet — search above to add the first song.</p>
        )}
        {!!state?.externalQueue?.length && (
          <div className="ext-queue">
            <div className="ext-head">Next in queue · Spotify app</div>
            <ol>
              {(state.externalQueue ?? []).slice(0, 1).map((t) => (
                <li key={t.uri} className="row q-item ext">
                  {t.image ? (
                    <img className="art sm" src={t.image} alt="" loading="lazy" />
                  ) : (
                    <div className="art sm placeholder"><IconNote size={20} /></div>
                  )}
                  <div className="grow">
                    <div className="q-name">
                      <strong>{t.name}</strong>
                      {t.explicit && <span className="tag">E</span>}
                    </div>
                    <div className="muted">
                      {t.artists} · {fmt(t.durationMs)}
                    </div>
                  </div>
                  <span className="badge spotify-badge">Spotify</span>
                </li>
              ))}
            </ol>
            {(state.externalQueue?.length ?? 0) > 1 && (
              <div className="muted">+{state.externalQueue.length - 1} more in the Spotify app</div>
            )}
          </div>
        )}
      </section>

      {state && <Stats state={state} />}

      <footer className="foot">
        {isLocal
          ? 'Local testing — no cooldown or queue limit.'
          : `${maxPending} songs per person · under ${state?.limits.maxTrackMin ?? 7} min each`}
        {state?.explicitBlocked === false && ' · explicit allowed'}
        <br />
        <a className="foot-link" href="/admin">
          Host sign-in
        </a>
      </footer>
    </main>
  )
}
