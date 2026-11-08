import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DETECT_FFT,
  DETECT_SMOOTHING,
  OnsetDetector,
  SILENCE_RMS,
  runClickTest,
  type ClickTestResult,
} from './beatDetector'

export type MeshSource = 'idle' | 'sim' | 'mic' | 'tab' | 'file'

/** Shared beat signal, consumed by both the Glow backdrop and the neon ring. */
export type BeatSignal = {
  /** Monotonic counter; consumers apply a pulse whenever it changes. */
  seq: number
  /** OnsetDetector sequence already published, so two render loops publish once. */
  detSeq: number
  /** performance.now() of the onset */
  at: number
  /** 0..1 pulse strength */
  strength: number
  source: 'audio' | 'listener' | 'sim'
  /**
   * While performance.now() is below this, a listener beat is trusted and the
   * bass detector must not publish, so the two sources never double-pulse.
   */
  listenerUntil: number
}

export type MeshLevels = {
  /** true only on the frame an onset was detected */
  beat: boolean
  /** timestamp of the last onset, for the debug overlay */
  beatAt: number
  /** detector sequence, for publishing the shared beat signal once per onset */
  beatSeq: number
  /** 0..1 strength of the last onset */
  strength: number
  /** smoothed bass envelope, 0-1 */
  bass: number
  /** smoothed overall energy, 0-1 */
  energy: number
  /** unsmoothed bass energy, 0-1 */
  rawBass: number
  /** low-mid band envelope, for the ring wobble */
  mid: number
  /** high band envelope, for the ring wobble */
  treble: number
  /** mid/high activity; may drive a subtle shimmer, never a pulse */
  shimmer: number
  /** adaptive onset threshold (already includes the absolute floor), dB flux */
  threshold: number
  /** spectral flux on the bass band, dB */
  flux: number
  /** time-domain RMS of the current frame, 0-1 */
  rms: number
  /** detector-estimated onset-to-render latency of the last beat, ms */
  latencyMs: number
  /** onsets in the last 10 s, for the debug overlay */
  pulsesPer10s: number
  /** last (up to 8) onset intervals in ms */
  intervals: number[]
  mode: MeshSource
}

export type MeshAudioStatus = 'disabled' | 'requesting' | 'active' | 'error' | 'simulated'

// ---------- tunables ----------
// The visual analyser is allowed to be smooth: it only drives slow envelopes.
// Detection uses its own analyser (see beatDetector.ts) so the pulse stays crisp.
const VISUAL_FFT = 2048
const VISUAL_SMOOTHING = 0.7
const BASS_MIN_HZ = 30
const BASS_MAX_HZ = 150
const VIS_ATTACK_MS = 40
const VIS_RELEASE_MS = 260
const ENERGY_GAIN = 2.2
const BASS_GAIN = 2.6
const SIM_BPM = 120
const SIM_STRENGTH = 0.85
const PULSE_WINDOW_MS = 10_000
const MAX_INTERVALS = 8

type Range = { start: number; end: number }

const initialLevels = (): MeshLevels => ({
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
})

// Frame-rate independent one-pole follower: fast attack, slow release.
function follow(current: number, target: number, dt: number, attackMs: number, releaseMs: number) {
  const ms = target > current ? attackMs : releaseMs
  const k = 1 - Math.exp(-dt / ms)
  return current + (target - current) * k
}

function createContext(): AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('Web Audio is not available in this browser.')
  return new Ctor({ latencyHint: 'interactive' })
}

// Keep the technical reason for the debug overlay, but give the projector a
// short, human sentence for the visible banner.
function describeMediaError(e: unknown, source: MeshSource): { message: string; detail: string } {
  const err = e as { name?: string; message?: string }
  const name = err?.name ?? 'Error'
  const detail = `${name}: ${err?.message ?? String(e)}`

  if (name === 'NotAllowedError') {
    return {
      message:
        source === 'tab'
          ? 'Screen share was blocked or cancelled. Allow it for this site, then try again.'
          : 'Microphone permission was denied. Allow it, then try again.',
      detail,
    }
  }
  if (name === 'NotFoundError') {
    return { message: 'No microphone was found on this device.', detail }
  }
  if (name === 'NotReadableError') {
    return { message: 'The audio device is busy in another app.', detail }
  }
  if (name === 'NotSupportedError') {
    return {
      message:
        source === 'tab'
          ? 'Screen/tab audio is not supported here. Use Chrome or Edge on localhost or HTTPS.'
          : 'Audio capture is not supported in this browser.',
      detail,
    }
  }
  if (name === 'AbortError') {
    return { message: 'Screen share was cancelled.', detail }
  }
  return { message: err?.message || 'Could not open audio.', detail }
}

export function useMeshAudio() {
  const levels = useRef<MeshLevels>(initialLevels())
  const [status, setStatus] = useState<MeshAudioStatus>('disabled')
  const [statusMsg, setStatusMsg] = useState('Idle · no audio reaction')
  const [statusError, setStatusError] = useState<string | null>(null)
  // "Connected" and "actually making sound" are different states. The pill
  // uses this to stay gray for a live-but-silent mic/tab.
  const [flowing, setFlowing] = useState(false)

  const mountedRef = useRef(true)
  const modeRef = useRef<MeshSource>('idle')
  const genRef = useRef(0)
  const flowingRef = useRef(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const detectorRef = useRef<OnsetDetector | null>(null)
  const visualRef = useRef<AnalyserNode | null>(null)
  const visualDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const sourceRef = useRef<AudioNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const bassRangeRef = useRef<Range>({ start: 1, end: 7 })

  const lastSampleRef = useRef(0)
  const lastFrameRef = useRef(-1)
  const simIdxRef = useRef(-1)
  const simSeqRef = useRef(0)
  const pulseTimesRef = useRef<number[]>([])
  const intervalsRef = useRef<number[]>([])
  const lastPulseAtRef = useRef(0)

  const setStatusSafe = useCallback(
    (next: MeshAudioStatus, msg: string, error: string | null = null) => {
      if (!mountedRef.current) return
      setStatus(next)
      setStatusMsg(msg)
      setStatusError(error)
    },
    [],
  )

  const setFlowingSafe = useCallback((next: boolean) => {
    if (!mountedRef.current) return
    if (flowingRef.current === next) return
    flowingRef.current = next
    setFlowing(next)
  }, [])

  const resetLevels = useCallback(
    (mode: MeshSource) => {
      const lv = levels.current
      lv.mode = mode
      lv.beat = false
      lv.beatAt = 0
      lv.beatSeq = 0
      lv.strength = 0
      lv.bass = 0
      lv.energy = 0
      lv.rawBass = 0
      lv.mid = 0
      lv.treble = 0
      lv.shimmer = 0
      lv.flux = 0
      lv.threshold = 0
      lv.rms = 0
      lv.latencyMs = 0
      lv.pulsesPer10s = 0
      lv.intervals = intervalsRef.current
      intervalsRef.current.length = 0
      pulseTimesRef.current.length = 0
      lastPulseAtRef.current = 0
      lastFrameRef.current = -1
      lastSampleRef.current = 0
      simIdxRef.current = -1
      simSeqRef.current = 0
      setFlowingSafe(false)
    },
    [setFlowingSafe],
  )

  const teardown = useCallback(() => {
    genRef.current++

    const stream = streamRef.current
    if (stream) stream.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const source = sourceRef.current
    if (source) {
      try {
        source.disconnect()
      } catch {
        // already disconnected
      }
    }
    sourceRef.current = null

    const el = audioElRef.current
    if (el) {
      el.pause()
      el.src = ''
    }
    audioElRef.current = null
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    const visual = visualRef.current
    if (visual) {
      try {
        visual.disconnect()
      } catch {
        // already disconnected
      }
    }
    visualRef.current = null
    visualDataRef.current = null
    detectorRef.current = null

    lastFrameRef.current = -1
    lastSampleRef.current = 0

    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
  }, [])

  const prepareAnalysers = useCallback((ctx: AudioContext) => {
    // Detection sees raw, unsaturated bass so a kick is a clean rise.
    const detection = ctx.createAnalyser()
    detection.fftSize = DETECT_FFT
    detection.smoothingTimeConstant = DETECT_SMOOTHING
    detection.minDecibels = -90
    detection.maxDecibels = -10

    // Visuals keep a slower, prettier envelope.
    const visual = ctx.createAnalyser()
    visual.fftSize = VISUAL_FFT
    visual.smoothingTimeConstant = VISUAL_SMOOTHING
    visual.minDecibels = -90
    // Leave headroom for loud bass so the byte bands do not pin at 255.
    visual.maxDecibels = -5
    const binHz = ctx.sampleRate / VISUAL_FFT
    bassRangeRef.current = {
      start: Math.max(1, Math.floor(BASS_MIN_HZ / binHz)),
      end: Math.min(visual.frequencyBinCount - 1, Math.ceil(BASS_MAX_HZ / binHz)),
    }

    detectorRef.current = new OnsetDetector(ctx, detection)
    visualRef.current = visual
    visualDataRef.current = new Uint8Array(visual.frequencyBinCount)
    return { detection, visual }
  }, [])

  const recordPulse = useCallback((at: number) => {
    const lv = levels.current
    const times = pulseTimesRef.current
    const now = at || performance.now()
    times.push(now)
    while (times.length && now - times[0] > PULSE_WINDOW_MS) times.shift()
    const intervals = intervalsRef.current
    if (lastPulseAtRef.current) {
      intervals.push(Math.round(now - lastPulseAtRef.current))
      while (intervals.length > MAX_INTERVALS) intervals.shift()
    }
    lastPulseAtRef.current = now
    lv.pulsesPer10s = times.length
    lv.intervals = intervals
  }, [])

  const start = useCallback(
    async (source: MeshSource) => {
      // Everything before the capture call is synchronous, so getUserMedia /
      // getDisplayMedia run inside the click's user-activation window.
      teardown()
      const gen = genRef.current
      modeRef.current = source
      resetLevels(source)

      if (source === 'idle') {
        setStatusSafe('disabled', 'Idle · no audio reaction')
        return
      }
      if (source === 'sim') {
        setStatusSafe('simulated', 'Simulated beat · 120 BPM')
        return
      }
      if (source === 'file') {
        setStatusSafe('requesting', 'Choose an audio file...')
        return
      }

      if (!window.isSecureContext) {
        modeRef.current = 'idle'
        resetLevels('idle')
        setStatusSafe(
          'error',
          'Screen/tab audio needs HTTPS or localhost.',
          `Insecure context: ${window.location.origin}. Open http://localhost:3000 or the HTTPS tunnel.`,
        )
        return
      }
      if (!navigator.mediaDevices) {
        modeRef.current = 'idle'
        resetLevels('idle')
        setStatusSafe(
          'error',
          'This browser does not expose media devices.',
          'navigator.mediaDevices is undefined (secure context required).',
        )
        return
      }

      setStatusSafe(
        'requesting',
        source === 'mic'
          ? 'Requesting microphone...'
          : 'Choose a tab and tick “Share tab audio”...',
      )

      let stream: MediaStream | null = null
      try {
        const ctx = createContext()
        ctxRef.current = ctx
        const { detection, visual } = prepareAnalysers(ctx)
        // Resume while the click is still active; the picker can take a while.
        void ctx.resume().catch(() => {})

        // The capture call itself must happen before any await. Chrome only
        // shows the picker while the click's transient activation is alive.
        const request =
          source === 'mic'
            ? navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
                video: false,
              })
            : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })

        stream = await request
        if (gen !== genRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        if (source === 'tab') {
          // Chrome requires video to show the picker; only audio is analysed.
          stream.getVideoTracks().forEach((track) => track.stop())
          if (!stream.getAudioTracks().length) {
            stream.getTracks().forEach((track) => track.stop())
            throw new Error(
              "No audio shared. In the picker, choose a Chrome Tab and tick 'Share tab audio'.",
            )
          }
        }
        if (!stream.getAudioTracks().length) {
          throw new Error('No audio track was shared.')
        }

        const node = ctx.createMediaStreamSource(stream)
        node.connect(detection)
        node.connect(visual)
        sourceRef.current = node
        streamRef.current = stream

        stream.getAudioTracks().forEach((track) => {
          track.addEventListener('ended', () => {
            if (gen !== genRef.current) return
            if (modeRef.current !== source) return
            teardown()
            modeRef.current = 'idle'
            resetLevels('idle')
            setStatusSafe('disabled', 'Audio ended · no reaction')
          })
        })

        await ctx.resume().catch(() => {})
        if (gen !== genRef.current) return
        if (ctx.state === 'running') {
          setStatusSafe('active', source === 'mic' ? 'Microphone · live' : 'Tab audio · live')
        } else {
          setStatusSafe('requesting', 'Tap Src to start audio')
        }
      } catch (e) {
        stream?.getTracks().forEach((track) => track.stop())
        if (gen !== genRef.current) return
        teardown()
        modeRef.current = 'idle'
        resetLevels('idle')
        const { message, detail } = describeMediaError(e, source)
        console.warn('[mesh audio]', detail, e)
        setStatusSafe('error', message, detail)
      }
    },
    [prepareAnalysers, resetLevels, setStatusSafe, teardown],
  )

  const attachFile = useCallback(
    async (file: File) => {
      teardown()
      const gen = genRef.current
      modeRef.current = 'file'
      resetLevels('file')
      setStatusSafe('requesting', `Loading ${file.name}...`)

      try {
        const ctx = createContext()
        ctxRef.current = ctx
        const { detection, visual } = prepareAnalysers(ctx)
        const url = URL.createObjectURL(file)
        const el = new Audio(url)
        el.loop = true
        el.preload = 'auto'
        const node = ctx.createMediaElementSource(el)
        node.connect(detection)
        node.connect(visual)
        node.connect(ctx.destination)
        sourceRef.current = node
        audioElRef.current = el
        objectUrlRef.current = url
        void ctx.resume().catch(() => {})
        await el.play()
        if (gen !== genRef.current) return
        if (ctx.state === 'running') {
          setStatusSafe('active', `File · ${file.name}`)
        } else {
          setStatusSafe('requesting', 'Tap Src to start audio')
        }
      } catch (e) {
        if (gen !== genRef.current) return
        teardown()
        modeRef.current = 'idle'
        resetLevels('idle')
        const { message, detail } = describeMediaError(e, 'file')
        console.warn('[mesh audio]', detail, e)
        setStatusSafe('error', message, detail)
      }
    },
    [prepareAnalysers, resetLevels, setStatusSafe, teardown],
  )

  const stop = useCallback(() => {
    teardown()
    modeRef.current = 'idle'
    resetLevels('idle')
    setStatusSafe('disabled', 'Idle · no audio reaction')
  }, [resetLevels, setStatusSafe, teardown])

  // Called once per render frame by the backdrop and the ring. The detector
  // runs on the first call of a frame; the second call returns the same levels
  // so both visuals apply the identical pulse in the same frame.
  const sample = useCallback(
    (now: number) => {
      const lv = levels.current
      if (now === lastFrameRef.current) return lv
      lastFrameRef.current = now
      lv.beat = false

      const dt = lastSampleRef.current ? Math.min(120, Math.max(0, now - lastSampleRef.current)) : 16
      lastSampleRef.current = now

      // Idle means exactly that: no reaction. Never fall through to a simulated
      // clock here, or the backdrop keeps pulsing with no audio source.
      if (modeRef.current === 'idle') {
        lv.bass = 0
        lv.energy = 0
        lv.rawBass = 0
        lv.mid = 0
        lv.treble = 0
        lv.shimmer = 0
        lv.flux = 0
        lv.threshold = 0
        lv.rms = 0
        lv.latencyMs = 0
        setFlowingSafe(false)
        return lv
      }

      // Simulated beats are opt-in (Src -> Sim), never a fallback.
      if (modeRef.current === 'sim') {
        const beatMs = 60_000 / SIM_BPM
        const idx = Math.floor(now / beatMs)
        if (idx !== simIdxRef.current) {
          simIdxRef.current = idx
          simSeqRef.current++
          lv.beat = true
          lv.beatAt = now
          lv.beatSeq = simSeqRef.current
          lv.strength = SIM_STRENGTH
          lv.latencyMs = 0
          recordPulse(now)
        }
        const phase = (now % beatMs) / beatMs
        const target = Math.exp(-phase * 5.5) * 0.9
        lv.bass = follow(lv.bass, target, dt, VIS_ATTACK_MS, VIS_RELEASE_MS)
        lv.energy = follow(lv.energy, 0.42 + target * 0.35, dt, 120, 500)
        lv.mid = follow(lv.mid, target * 0.6, dt, VIS_ATTACK_MS, VIS_RELEASE_MS)
        lv.treble = follow(lv.treble, target * 0.3, dt, VIS_ATTACK_MS, VIS_RELEASE_MS)
        lv.rawBass = target
        lv.flux = lv.beat ? 1 : 0
        lv.threshold = 0.5
        lv.rms = 0
        setFlowingSafe(false)
        return lv
      }

      const ctx = ctxRef.current
      const detector = detectorRef.current
      const visual = visualRef.current
      const data = visualDataRef.current

      // A live source without a working analyser must not feed stale or random
      // values into the visuals. Force silence instead.
      if (!ctx || !detector || !visual || !data || ctx.state !== 'running') {
        lv.bass = 0
        lv.energy = 0
        lv.rawBass = 0
        lv.mid = 0
        lv.treble = 0
        lv.shimmer = 0
        lv.flux = 0
        lv.threshold = 0
        lv.rms = 0
        lv.latencyMs = 0
        setFlowingSafe(false)
        return lv
      }

      const frame = detector.process(now)

      visual.getByteFrequencyData(data)
      const { start: bassStart, end: bassEnd } = bassRangeRef.current
      const count = Math.max(1, bassEnd - bassStart + 1)
      let bassSum = 0
      for (let i = 0; i < count; i++) bassSum += data[bassStart + i] / 255
      const bassRaw = Math.min(1, (bassSum / count) * BASS_GAIN)

      let sum = 0
      let n = 0
      for (let i = 0; i < data.length; i += 2) {
        sum += data[i] / 255
        n++
      }
      const energyRaw = Math.min(1, (sum / Math.max(1, n)) * ENERGY_GAIN)

      lv.bass = follow(lv.bass, bassRaw, dt, VIS_ATTACK_MS, VIS_RELEASE_MS)
      lv.energy = follow(lv.energy, energyRaw, dt, VIS_ATTACK_MS, VIS_RELEASE_MS)
      lv.rawBass = bassRaw
      lv.mid = frame.mid
      lv.treble = frame.treble
      lv.shimmer = frame.shimmer
      lv.flux = frame.flux
      lv.threshold = frame.threshold
      lv.rms = frame.rms
      lv.beat = frame.beat
      lv.beatSeq = frame.seq
      lv.strength = frame.strength
      lv.beatAt = frame.at
      lv.latencyMs = frame.latencyMs
      if (frame.beat) recordPulse(frame.at)

      setFlowingSafe(frame.rms >= SILENCE_RMS)
      return lv
    },
    [recordPulse, setFlowingSafe],
  )

  const selfTest = useCallback((bpm = 80, seconds = 8): Promise<ClickTestResult> => {
    return runClickTest(bpm, seconds)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      teardown()
    }
  }, [teardown])

  return {
    levels,
    sample,
    selfTest,
    status,
    statusMsg,
    statusError,
    flowing,
    start,
    attachFile,
    stop,
  }
}
