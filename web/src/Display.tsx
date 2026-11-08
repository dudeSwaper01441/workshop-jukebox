import { fmt, useJukebox, useTicker } from './api'
import LyricsView from './LyricsView'
import Status from './Status'
import {
  IconColumns,
  IconFont,
  IconMic,
  IconNote,
  IconPulse,
  IconRefresh,
  IconSpark,
} from './icons'
import BeatRing from './BeatRing'
import MeshBackdrop from './MeshBackdrop'
import {
  useMeshAudio,
  type BeatSignal,
  type MeshLevels,
  type MeshSource,
} from './useMeshAudio'
import { useAudioBeat, type AudioBeat } from './useAudioBeat'
import type { ClickTestResult } from './beatDetector'
import { useState, useEffect, useRef, useCallback, type MutableRefObject } from 'react'

// Projector chrome (nav + status pills) auto-hides after this much inactivity.
const CHROME_IDLE_MS = 3000

const MESH_SOURCES: { id: MeshSource; label: string }[] = [
  { id: 'idle', label: 'Idle' },
  { id: 'mic', label: 'Mic' },
  { id: 'tab', label: 'Tab' },
  { id: 'file', label: 'File' },
  { id: 'sim', label: 'Sim' },
]

// A listener beat is trusted as the shared signal for this long; detector
// onsets are suppressed meanwhile so the two sources never double-pulse.
const LISTENER_TRUST_MS = 1200

type DebugStats = MeshLevels & { beatSeq: number; at: number; source: string }

function BeatDebug({
  levels,
  bus,
  sourceLabel,
  status,
  statusMsg,
  selfTest,
}: {
  levels: MutableRefObject<MeshLevels>
  bus: MutableRefObject<BeatSignal>
  sourceLabel: string
  status: string
  statusMsg: string
  selfTest: (bpm?: number, seconds?: number) => Promise<ClickTestResult>
}) {
  const [snap, setSnap] = useState<DebugStats>(() => ({ ...levels.current, ...bus.current }))
  const [beatOn, setBeatOn] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ClickTestResult | null>(null)
  const lastSeqRef = useRef(-1)

  useEffect(() => {
    const id = setInterval(() => {
      setSnap({ ...levels.current, ...bus.current })
      const b = bus.current
      const fresh = b.seq !== lastSeqRef.current
      lastSeqRef.current = b.seq
      setBeatOn(fresh || performance.now() - b.at < 160)
    }, 80)
    return () => clearInterval(id)
  }, [levels, bus])

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await selfTest(80, 8))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mesh-debug" data-state={status}>
      <div className="row">
        <span>source</span>
        <b>{sourceLabel}</b>
      </div>
      <div className="row">
        <span>state</span>
        <b>{status}</b>
      </div>
      <div className="mesh-msg">{statusMsg}</div>
      <div className="row">
        <span>latency</span>
        <b>{snap.latencyMs ? `${Math.round(snap.latencyMs)} ms` : '—'}</b>
      </div>
      <div className="row">
        <span>pulses/10s</span>
        <b>{snap.pulsesPer10s}</b>
      </div>
      <div className="row">
        <span>intervals</span>
        <b>{snap.intervals.length ? snap.intervals.join(' ') : '—'}</b>
      </div>
      <div className="row">
        <span>bass</span>
        <b>{snap.bass.toFixed(2)}</b>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.round(snap.bass * 100)}%` }} />
      </div>
      <div className="row">
        <span>threshold</span>
        <b>{snap.threshold.toFixed(2)}</b>
      </div>
      <div className="bar">
        <i className="thr" style={{ width: `${Math.min(100, Math.round(snap.threshold * 20))}%` }} />
      </div>
      <div className="row">
        <span>flux</span>
        <b>{snap.flux.toFixed(2)}</b>
      </div>
      <div className="row">
        <span>rms</span>
        <b>{snap.rms.toFixed(3)}</b>
      </div>
      <div className="row">
        <span>beat</span>
        <b className={beatOn ? 'beat-on' : ''} key={snap.beatSeq}>
          {beatOn ? '●' : '○'}
        </b>
      </div>
      <div className="row">
        <span>signal</span>
        <b>{snap.source}</b>
      </div>
      <button type="button" className="mesh-test-btn" onClick={runTest} disabled={testing}>
        {testing ? 'Testing…' : '80 BPM self-test'}
      </button>
      {test && (
        <div className="mesh-test-out">
          {test.mode} · hits {Math.round(test.hitRate * 100)}% · false {test.falsePulses} ·{' '}
          {test.meanLatencyMs} ms
          <br />
          intervals {test.intervals.slice(0, 6).join(' ')}
        </div>
      )}
    </div>
  )
}

export default function Display() {
  const { state, offline } = useJukebox()
  // The lyrics dock is on by default: the whole point of the bottom strip is
  // that people can see lyrics exist. The nav toggle still hides it.
  const [showLyrics, setShowLyrics] = useState(true)

  // Audio-reactive mesh backdrop. Local to this browser (the projector), like
  // the ring toggle. It starts idle: no audio source, no reaction, only the
  // slow drift. Sim is an explicit choice, never a default or a fallback.
  const [meshEnabled, setMeshEnabled] = useState(() => {
    try {
      return localStorage.getItem('jb_mesh') !== '0'
    } catch {
      return true
    }
  })
  const [meshSource, setMeshSource] = useState<MeshSource>('idle')
  const meshFileRef = useRef<HTMLInputElement | null>(null)
  const {
    levels,
    sample: sampleMesh,
    selfTest,
    status: meshStatus,
    statusMsg: meshStatusMsg,
    statusError: meshStatusError,
    flowing: meshFlowing,
    start: startMeshAudio,
    attachFile: attachMeshFile,
    stop: stopMeshAudio,
  } = useMeshAudio()
  const meshSourceLabel = MESH_SOURCES.find((s) => s.id === meshSource)?.label ?? 'Idle'
  const meshStateText =
    meshStatus === 'active'
      ? meshFlowing
        ? `${meshSourceLabel} live`
        : `${meshSourceLabel} · silent`
      : meshStatus === 'requesting'
        ? 'Requesting...'
        : meshStatus === 'error'
          ? 'Error'
          : meshStatus === 'simulated'
            ? 'Sim'
            : 'Idle'
  const meshPillState = meshStatus === 'active' && !meshFlowing ? 'active silent' : meshStatus
  const meshDetail = meshStatusError ? `${meshStatusMsg} (${meshStatusError})` : meshStatusMsg

  // One shared beat signal for the glow, the ring, and the Beat Listener.
  const beatBus = useRef<BeatSignal>({
    seq: 0,
    detSeq: 0,
    at: 0,
    strength: 0,
    source: 'audio',
    listenerUntil: 0,
  })

  const [debug, setDebug] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('debug')
    } catch {
      return false
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return
      setDebug((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleMesh = () => {
    const next = !meshEnabled
    setMeshEnabled(next)
    if (!next) {
      // release a live mic or tab share when the backdrop is hidden
      stopMeshAudio()
      setMeshSource('idle')
    }
    try {
      localStorage.setItem('jb_mesh', next ? '1' : '0')
    } catch {
      // private mode: still applies for this tab
    }
  }

  const cycleMeshSource = () => {
    const idx = MESH_SOURCES.findIndex((s) => s.id === meshSource)
    const next = MESH_SOURCES[(idx + 1) % MESH_SOURCES.length].id
    setMeshSource(next)
    if (!meshEnabled) {
      setMeshEnabled(true)
      try {
        localStorage.setItem('jb_mesh', '1')
      } catch {
        // ignore (private mode)
      }
    }
    if (next === 'file') {
      void startMeshAudio('file')
      meshFileRef.current?.click()
    } else {
      void startMeshAudio(next)
    }
  }
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
  // Beat Listener: real beat detection from the Python audio listener on
  // ws://localhost:8765. Off by default; never connects until switched on.
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

  // Beat Listener lives at this level, not inside BeatRing: the switch and its
  // status must work even when no cover (and therefore no ring) is rendered.
  // Listener beats go straight onto the shared bus so the glow and ring use the
  // identical signal; detector onsets are muted while the listener is trusted.
  const handleBeat = useCallback((beat: AudioBeat) => {
    const energy = typeof beat.energy === 'number' ? beat.energy : 0.6
    const strength = Math.min(1, Math.max(0.25, energy))
    const at = performance.now()
    beatBus.current = {
      seq: beatBus.current.seq + 1,
      detSeq: beatBus.current.detSeq,
      at,
      strength,
      source: 'listener',
      listenerUntil: at + LISTENER_TRUST_MS,
    }
  }, [])
  const resetBeat = useCallback(() => {
    if (beatBus.current.source === 'listener') {
      beatBus.current = { ...beatBus.current, source: 'audio', strength: 0, at: 0, listenerUntil: 0 }
    }
  }, [])
  const { status: listenerStatus, retry: retryListener } = useAudioBeat(
    handleBeat,
    audioEnabled,
    resetBeat,
  )
  const listenerPill =
    listenerStatus === 'connected'
      ? { text: 'Listening', cls: 'on' }
      : listenerStatus === 'connecting'
        ? { text: 'Connecting...', cls: 'connecting' }
        : listenerStatus === 'unavailable'
          ? { text: 'Unavailable', cls: 'unavailable' }
          : { text: 'Off', cls: 'off' }

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyListenerCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText('python server/audio_listener.py')
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be blocked; the command stays visible to type manually.
    }
  }, [])
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  // Projector chrome auto-hide: any input wakes the nav, then 3s of quiet
  // fades it out. Hovering or keyboard-focusing the chrome keeps it up so the
  // buttons never disappear mid-interaction.
  const [chromeIdle, setChromeIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chromeHold = useRef(false)

  // A listener that is still connecting or has given up, and a Glow source
  // that is waiting for permission or failed, must not vanish with the rest of
  // the chrome: the user needs the status pill and the Retry button.
  const keepChromeVisible =
    listenerStatus === 'connecting' ||
    listenerStatus === 'unavailable' ||
    meshStatus === 'requesting' ||
    meshStatus === 'error'
  const keepChromeRef = useRef(keepChromeVisible)

  const wakeChrome = useCallback(() => {
    setChromeIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => {
      if (!chromeHold.current && !keepChromeRef.current) setChromeIdle(true)
    }, CHROME_IDLE_MS)
  }, [])

  const holdChrome = useCallback(
    (hold: boolean) => {
      chromeHold.current = hold
      if (hold) {
        if (idleTimer.current) clearTimeout(idleTimer.current)
        setChromeIdle(false)
      } else {
        wakeChrome()
      }
    },
    [wakeChrome],
  )

  // Wake immediately when a status becomes urgent; when it clears, arm a fresh
  // 3s timer so the nav can hide normally again.
  useEffect(() => {
    if (keepChromeRef.current === keepChromeVisible) return
    keepChromeRef.current = keepChromeVisible
    wakeChrome()
  }, [keepChromeVisible, wakeChrome])

  useEffect(() => {
    const onActivity = () => wakeChrome()
    window.addEventListener('mousemove', onActivity, { passive: true })
    window.addEventListener('mousedown', onActivity, { passive: true })
    window.addEventListener('touchstart', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    // Arm the first hide without a synchronous setState inside the effect.
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => {
      if (!chromeHold.current && !keepChromeRef.current) setChromeIdle(true)
    }, CHROME_IDLE_MS)
    return () => {
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('mousedown', onActivity)
      window.removeEventListener('touchstart', onActivity)
      window.removeEventListener('keydown', onActivity)
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [wakeChrome])

  // Hide the OS cursor with the chrome, so the projector is just music.
  useEffect(() => {
    document.body.classList.toggle('cursor-hidden', chromeIdle)
    return () => document.body.classList.remove('cursor-hidden')
  }, [chromeIdle])

  const liveNow = state?.now ?? null
  const clock = useTicker(!!liveNow?.isPlaying)
  const elapsed = liveNow
    ? Math.min(liveNow.durationMs, liveNow.progressMs + (liveNow.isPlaying ? clock - liveNow.at : 0))
    : 0
  const pct = liveNow ? Math.min(100, (elapsed / liveNow.durationMs) * 100) : 0

  // Warm time-of-day greeting instead of a blank idle state.
  const hour = new Date().getHours()
  const dayGreeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <>
      <MeshBackdrop
        enabled={meshEnabled}
        artUrl={liveNow?.image ?? null}
        sample={sampleMesh}
        beatBus={beatBus}
      />
      <main className={`wrap display${showLyrics ? ' has-lyrics' : ''}`}>
        <div
          className={`display-top${chromeIdle ? ' is-idle' : ''}`}
          onMouseEnter={() => holdChrome(true)}
          onMouseLeave={() => holdChrome(false)}
          onFocusCapture={() => holdChrome(true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdChrome(false)
          }}
        >
          <header className="top display-nav">
            <div className="brand">
              <IconNote size={18} />
              <span className="brand-name">Jukebox</span>
              <span className="brand-sub">mixtape</span>
            </div>
            <div className="head-right">
              <span className="nav-status-chip">
                <Status tone={offline ? 'offline' : liveNow?.isPlaying ? 'live' : 'idle'} />
              </span>

              <div className="nav-group" role="group" aria-label="Display">
                <button
                  type="button"
                  className="ghost head-btn"
                  onClick={toggleBeatRing}
                  aria-pressed={beatRingEnabled}
                  title="Toggle neon ring visualizer"
                >
                  <IconPulse size={14} />
                  Ring
                </button>
                <button
                  type="button"
                  className="ghost head-btn"
                  onClick={toggleMesh}
                  aria-pressed={meshEnabled}
                  title="Toggle the audio-reactive mesh backdrop"
                >
                  <IconSpark size={14} />
                  Glow
                </button>
                <span
                  className={`mesh-state ${meshPillState}`}
                  title={meshDetail}
                  aria-live="polite"
                >
                  <i aria-hidden="true" />
                  Glow: {meshStateText}
                </span>
                <button
                  type="button"
                  className="ghost head-btn"
                  onClick={cycleThaiFont}
                  aria-pressed={lyricsFont !== 'auto'}
                  title={`Lyrics font: ${THAI_FONTS.find((f) => f.id === lyricsFont)?.label}`}
                >
                  <IconFont size={14} />
                  font
                </button>
              </div>

              <span className="nav-divider" aria-hidden="true" />

              <div className="nav-group nav-group-audio" role="group" aria-label="Audio">
                <div className="beat-listener">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={audioEnabled}
                    aria-describedby="beat-listener-tip"
                    className={`beat-listener-switch${audioEnabled ? ' is-on' : ''}`}
                    onClick={toggleAudio}
                  >
                    <IconMic size={14} />
                    <span>Beat Listener</span>
                    <span className="beat-listener-track" aria-hidden="true">
                      <span className="beat-listener-knob" />
                    </span>
                  </button>
                  <span
                    className={`beat-listener-pill ${listenerPill.cls}`}
                    role="status"
                    aria-live="polite"
                  >
                    <i className="beat-listener-dot" aria-hidden="true" />
                    {listenerPill.text}
                  </span>
                  <span id="beat-listener-tip" role="tooltip" className="beat-listener-tip">
                    Reacts to your music through a local Python audio listener
                  </span>
                </div>
                <button
                  type="button"
                  className="ghost head-btn"
                  onClick={cycleMeshSource}
                  title={`Backdrop audio source: ${meshSourceLabel} — ${meshDetail}`}
                >
                  <IconPulse size={14} />
                  Src
                </button>
              </div>

              <span className="nav-divider" aria-hidden="true" />

              <div className="nav-group" role="group" aria-label="Content">
                <button
                  type="button"
                  className="ghost head-btn"
                  onClick={() => setShowLyrics((v) => !v)}
                  aria-pressed={showLyrics}
                >
                  <IconMic size={14} />
                  Lyrics
                </button>
                <button
                  type="button"
                  className="ghost head-btn"
                  onClick={() => (window.location.href = '/?tv=apmu')}
                  title="ApMu: artwork and lyrics side by side"
                >
                  <IconColumns size={14} />
                  ApMu
                </button>
              </div>
            </div>
          </header>

          {listenerStatus === 'unavailable' && (
            <div className="beat-listener-hint" role="status">
              <span>Start audio_listener.py, then press Retry.</span>
              <button
                type="button"
                className="beat-listener-cmd"
                onClick={copyListenerCommand}
                title="Copy command"
              >
                <code>python server/audio_listener.py</code>
                <span className="beat-listener-copy">{copied ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                className="ghost head-btn beat-listener-retry"
                onClick={retryListener}
              >
                <IconRefresh size={14} />
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Backdrop audio is a local, opt-in thing; surface requesting/error
            states instead of leaving the projector looking mysteriously dead.
            Kept outside the auto-hiding top area so a problem never disappears. */}
        {(meshStatus === 'requesting' || meshStatus === 'error') && meshSource !== 'idle' && (
          <div className={`mesh-banner ${meshStatus}`} role="status">
            <span>{meshStatusMsg}</span>
            {meshStatusError && <span className="mesh-banner-detail">{meshStatusError}</span>}
          </div>
        )}

        <div className="display-stage">
          <section className="card display-hero" aria-live="polite">
            {liveNow ? (
              <>
                {liveNow.image && (
                  <BeatRing
                    enabled={beatRingEnabled}
                    sample={sampleMesh}
                    beatBus={beatBus}
                  >
                    <img className="display-art" src={liveNow.image} alt="" />
                  </BeatRing>
                )}
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
        </div>

        {showLyrics && (
          <section className="display-lyrics-dock" aria-live="polite">
            <div className="display-lyrics">
              <LyricsView uri={liveNow?.uri ?? null} positionMs={elapsed} fontClass={lyricsFontClass} />
            </div>
          </section>
        )}

        {debug && (
          <BeatDebug
            levels={levels}
            bus={beatBus}
            sourceLabel={meshSourceLabel}
            status={meshStatus}
            statusMsg={meshStatusMsg}
            selfTest={selfTest}
          />
        )}
      </main>
      <input
        ref={meshFileRef}
        type="file"
        accept="audio/*"
        className="mesh-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void attachMeshFile(file)
        }}
      />
    </>
  )
}
