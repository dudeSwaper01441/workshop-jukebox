import { fmt, useJukebox, useTicker } from './api'
import LyricsView from './LyricsView'
import Status from './Status'
import { IconColumns, IconFont, IconMic, IconNote, IconPulse } from './icons'
import BeatRing from './BeatRing'
import { useState, useEffect, useRef } from 'react'

// Friendly, human copy instead of soulless dashboard labels.
const HOST_NOTES = [
  "Good evening — thanks for requesting.",
  "This one's a favorite. Play it loud.",
  "Keep 'em coming, the night's young.",
  "Requested by a friend. Enjoy.",
  "A little something for the room.",
  "Thanks for keeping the music alive.",
  "A little something I think you'll like.",
  "The requests are rolling in — thank you.",
]

export default function Display() {
  const { state, offline } = useJukebox()
  const [showLyrics, setShowLyrics] = useState(false)
  // Thai font for lyrics: system fonts only, persisted per browser.
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

  // Persisted on/off for the neon ring visualizer. Lives on the display
  // browser (the projector), not the server — it's a local visual preference.
  const [beatRingEnabled, setBeatRingEnabled] = useState(() => {
    try {
      return localStorage.getItem('jb_beat_ring') !== '0'
    } catch {
      return true
    }
  })
  // Audio mode: real beat detection from the Python audio listener on
  // ws://localhost:8765. Only works on the host laptop running Spotify.
  const [audioEnabled, setAudioEnabled] = useState(() => {
    try {
      return localStorage.getItem('jb_beat_audio') === '1'
    } catch {
      return false
    }
  })

  const toggleBeatRing = () => {
    const next = !beatRingEnabled
    setBeatRingEnabled(next)
    try {
      localStorage.setItem('jb_beat_ring', next ? '1' : '0')
    } catch {
      // ignore (private mode)
    }
  }
  const toggleAudio = () => {
    const next = !audioEnabled
    setAudioEnabled(next)
    try {
      localStorage.setItem('jb_beat_audio', next ? '1' : '0')
    } catch {
      // ignore (private mode)
    }
  }

  const liveNow = state?.now ?? null
  const clock = useTicker(!!liveNow?.isPlaying)
  const elapsed = liveNow
    ? Math.min(liveNow.durationMs, liveNow.progressMs + (liveNow.isPlaying ? clock - liveNow.at : 0))
    : 0
  const pct = liveNow ? Math.min(100, (elapsed / liveNow.durationMs) * 100) : 0

  // A host note that changes when the song changes, so the screen feels like
  // it's run by a person, not a dashboard.
  const [noteIdx, setNoteIdx] = useState(0)
  const lastUri = useRef<string | null>(null)
  useEffect(() => {
    if (liveNow?.uri && lastUri.current !== liveNow.uri) {
      lastUri.current = liveNow.uri
      setNoteIdx((i) => (i + 1) % HOST_NOTES.length)
    }
  }, [liveNow?.uri])
  const hostNote = HOST_NOTES[noteIdx]

  // Warm time-of-day greeting instead of a blank idle state.
  const hour = new Date().getHours()
  const dayGreeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <main className="wrap display relative overflow-hidden">
      <BeatRing now={liveNow} isPlaying={!!liveNow?.isPlaying} enabled={beatRingEnabled} audioMode={audioEnabled} />
      <header className="top">
        <div className="brand">
          <IconNote size={18} />
          <span className="brand-name">Jukebox</span>
          <span className="brand-sub">mixtape</span>
        </div>
        <div className="head-right">
          <Status tone={offline ? 'offline' : liveNow?.isPlaying ? 'live' : 'idle'} />
          <button
            className={`ghost head-btn ${beatRingEnabled ? '' : 'opacity-50'} ${audioEnabled ? 'ring-audio-on' : ''}`}
            onClick={toggleBeatRing}
            aria-pressed={beatRingEnabled}
            title="Toggle neon ring visualizer"
          >
            <IconPulse size={14} />
            Ring
          </button>
          <button
            className={`ghost head-btn ${audioEnabled ? 'ring-audio-on' : 'opacity-50'}`}
            onClick={toggleAudio}
            aria-pressed={audioEnabled}
            title="Use real audio beat detection (needs python audio_listener.py on localhost:8765)"
          >
            <IconMic size={14} />
            Audio
          </button>
          <button
            className="ghost head-btn"
            onClick={() => setShowLyrics((v) => !v)}
            aria-pressed={showLyrics}
          >
            <IconMic size={14} />
            Lyrics
          </button>
          <button
            className="ghost head-btn"
            onClick={() => (window.location.href = '/?tv=apmu')}
            title="ApMu: artwork and lyrics side by side"
          >
            <IconColumns size={14} />
            ApMu
          </button>
          <button
            className="ghost head-btn"
            onClick={cycleThaiFont}
            aria-pressed={lyricsFont !== 'auto'}
            title={`Lyrics font: ${THAI_FONTS.find((f) => f.id === lyricsFont)?.label}`}
          >
            <IconFont size={14} />
            font
          </button>
        </div>
      </header>

      {/* Human note from the "DJ" — changes with each song. */}
      <div className="host-note" aria-live="polite">
        <span className="host-dot" aria-hidden="true">•</span>
        <span>{hostNote}</span>
        {liveNow && <span className="host-divider">·</span>}
        {liveNow && (
          <span className="host-requested">
            {liveNow.mine ? "Your pick" : "Requested by a friend"}
          </span>
        )}
      </div>

      <section className="card display-hero" aria-live="polite">
        {liveNow ? (
          <>
            {liveNow.image && <img className="display-art" src={liveNow.image} alt="" />}
            <div className="display-meta">
              <span className="now-spinning">Now spinning</span>
              <div className="display-title">
                {liveNow.name}
                {liveNow.explicit && <span className="tag">E</span>}
              </div>
              <div className="display-artist">{liveNow.artists}</div>
              <div className="display-time">
                {fmt(elapsed)} / {fmt(liveNow.durationMs)}
              </div>
              <div key={liveNow.uri} className="progress display-progress">
                <i style={{ width: `${pct}%` }} />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="display-greeting">{dayGreeting}</div>
            <div className="display-title">Nothing playing yet</div>
            <div className="display-artist">Scan the QR code and request a song!</div>
          </>
        )}
      </section>

      {showLyrics && (
        <section className="card" aria-live="polite">
          <div className="section-head">
            <h2>Lyrics</h2>
          </div>
          <div className="display-lyrics">
            <LyricsView uri={liveNow?.uri ?? null} positionMs={elapsed} fontClass={lyricsFontClass} />
          </div>
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h2>Coming up</h2>
          <span className="meta">
            {(state?.queue.length ?? 0) + (state?.externalQueue?.length ?? 0)} waiting
          </span>
        </div>
        {state?.queue.length || state?.externalQueue?.length ? (
          <ol className="display-queue">
            {state.queue.slice(0, 5).map((t, i) => (
              <li key={t.id} className={`row q-item ${t.mine ? 'mine' : ''}`}>
                <span className="num">{i + 1}</span>
                <div className="grow">
                  <div className="q-name">
                    <strong>{t.name}</strong>
                    {t.mine && <span className="badge">yours</span>}
                  </div>
                  <div className="muted">{t.artists}</div>
                </div>
              </li>
            ))}
            {(state.externalQueue ?? []).slice(0, Math.max(0, 5 - (state.queue.length ?? 0))).map((t) => (
              <li key={t.uri} className="row q-item ext">
                <div className="grow">
                  <div className="q-name">
                    <strong>{t.name}</strong>
                  </div>
                  <div className="muted">{t.artists} · via Spotify app</div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">The queue's empty. Be the first to request.</p>
        )}
      </section>
    </main>
  )
}
