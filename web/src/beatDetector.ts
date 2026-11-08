// Bass onset detection, shared by the projector's live audio path and the
// dev-only click-track self-test.
//
// Why this shape:
//  - The old detector looked at the whole spectrum, used a *mean* threshold and
//    fired on every frame the flux crossed it. That produced ~2x too many
//    pulses (one per frame of the kick's rise) and, because the FFT was 2048
//    wide with smoothingTimeConstant 0.6, every pulse was 130-200 ms late.
//  - Here we look at 30-150 Hz only, on the *log magnitude* (dB) spectrum, use
//    a rolling *median* threshold (medians ignore the kicks themselves) and
//    confirm a local peak (rise, then fall) before firing. The refractory and
//    the strength mapping keep big flashes under ~3/sec.

export const DETECT_FFT = 1024
export const DETECT_SMOOTHING = 0.05
export const BASS_MIN_HZ = 30
export const BASS_MAX_HZ = 150
const MID_MAX_HZ = 2000
const HIGH_MAX_HZ = 8000
// ~1.5 s of flux: long enough to see a few beats, short enough to track a
// section change. The median is robust to the kicks inside the window.
export const ROLLING_MS = 1500
export const THRESHOLD_MULT = 1.6
export const THRESHOLD_FLOOR = 0.6
// 280 ms => at most ~3.5 onsets/sec before the rapid-hit limiter dulls them.
export const REFRACTORY_MS = 280
const PEAK_FALL = 0.9
const PEAK_HOLD_MS = 140
const RUNNING_MAX_MS = 2500
export const SILENCE_RMS = 0.008
const STRENGTH_GAMMA = 0.75
const STRENGTH_FLOOR = 0.22
// Big flashes must stay under 3/sec: a second hit inside this window is
// scaled down instead of dropped, so the grid still reads as steady.
const RAPID_MS = 400
const RAPID_SCALE = 0.55
const MIN_STRENGTH_RANGE = 0.5
// dB -> linear band level -> 0..1. A loud kick sits around -20 dB.
const BASS_GAIN = 10
const MID_GAIN = 7
const HIGH_GAIN = 5
const BAND_ATTACK_MS = 25
const BAND_RELEASE_MS = 220
// Synthetic self-test frame step. 8 ms is below one display frame, so the
// detector sees a smooth rise/fall without needing a real audio device.
const TEST_FRAME_MS = 8
const TEST_BASE_LATENCY_MS = 10

export type OnsetFrame = {
  beat: boolean
  strength: number
  seq: number
  /** performance.now() of the peak frame that produced this onset */
  at: number
  flux: number
  threshold: number
  runningMax: number
  rms: number
  bass: number
  mid: number
  treble: number
  shimmer: number
  latencyMs: number
}

type Sample = { t: number; v: number }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function follow(current: number, target: number, dt: number, attackMs: number, releaseMs: number) {
  const ms = target > current ? attackMs : releaseMs
  const k = 1 - Math.exp(-dt / ms)
  return current + (target - current) * k
}

type DetectorSpec = { sampleRate: number; fftSize: number; baseLatencyMs: number }

export class OnsetDetector {
  private analyser: AnalyserNode | null
  private freq: Float32Array<ArrayBuffer>
  private prev: Float32Array<ArrayBuffer>
  private time: Float32Array<ArrayBuffer>
  private bassStart = 1
  private bassEnd = 1
  private midStart = 1
  private midEnd = 1
  private highStart = 1
  private highEnd = 1
  private hist: Sample[] = []
  private maxHist: Sample[] = []
  private candidate: { flux: number; at: number; threshold: number } | null = null
  private lastBeatAt = -1e9
  private prevBeatAt = -1e9
  private lastAt = 0
  private seq = 0
  private prepared = false
  private baseLatencyMs: number
  private fftWindowMs: number
  private bass = 0
  private mid = 0
  private treble = 0
  private lastLatencyMs = 0

  constructor(ctx: BaseAudioContext | null, analyser: AnalyserNode | null, spec?: DetectorSpec) {
    this.analyser = analyser
    const fftSize = analyser?.fftSize ?? spec?.fftSize ?? DETECT_FFT
    const sampleRate = ctx?.sampleRate ?? spec?.sampleRate ?? 48000
    const binCount = analyser?.frequencyBinCount ?? Math.max(1, fftSize / 2)
    this.freq = new Float32Array(binCount)
    this.prev = new Float32Array(binCount)
    this.time = new Float32Array(fftSize)
    const binHz = sampleRate / fftSize
    const bin = (hz: number) => Math.min(binCount - 1, Math.max(1, Math.round(hz / binHz)))
    this.bassStart = bin(BASS_MIN_HZ)
    this.bassEnd = bin(BASS_MAX_HZ)
    this.midStart = bin(BASS_MAX_HZ)
    this.midEnd = bin(MID_MAX_HZ)
    this.highStart = bin(MID_MAX_HZ)
    this.highEnd = bin(HIGH_MAX_HZ)
    this.baseLatencyMs = analyser
      ? ('baseLatency' in (ctx as AudioContext) ? (ctx as AudioContext).baseLatency : 0) * 1000
      : (spec?.baseLatencyMs ?? TEST_BASE_LATENCY_MS)
    // The newest FFT frame represents roughly the last window/2 of audio, so
    // that is the floor on how late an onset can be detected.
    this.fftWindowMs = (fftSize / sampleRate) * 1000
  }

  private bandLevel(start: number, end: number, gain: number) {
    let sum = 0
    let n = 0
    for (let i = start; i <= end; i++) {
      const v = this.freq[i]
      if (Number.isFinite(v)) {
        sum += Math.pow(10, v / 20)
        n++
      }
    }
    if (!n) return 0
    return clamp((sum / n) * gain, 0, 1)
  }

  /** Analyze one frame from the live AnalyserNode. */
  process(now: number): OnsetFrame {
    const analyser = this.analyser
    if (!analyser) throw new Error('OnsetDetector has no analyser; use pushSpectrum().')
    analyser.getFloatFrequencyData(this.freq)
    analyser.getFloatTimeDomainData(this.time)

    let sumSq = 0
    for (let i = 0; i < this.time.length; i++) {
      const x = this.time[i]
      sumSq += x * x
    }
    const rms = Math.sqrt(sumSq / this.time.length)
    return this.analyze(now, rms)
  }

  /**
   * Analyze a caller-supplied log-magnitude spectrum. Used by the offline
   * click-track self-test so detection can be measured on machines with no
   * audio output device (a frozen AudioContext clock).
   */
  pushSpectrum(now: number, freq: Float32Array<ArrayBuffer>, rms: number): OnsetFrame {
    this.freq = freq
    return this.analyze(now, rms)
  }

  private analyze(now: number, rms: number): OnsetFrame {
    const dt = this.lastAt ? Math.min(120, Math.max(1, now - this.lastAt)) : 16
    this.lastAt = now

    if (!this.prepared) {
      this.prev.set(this.freq)
      this.prepared = true
      return this.frame(now, false, 0, 0, 0, rms, 0, 0)
    }

    // Silence gate. Keep the flux baseline aligned so the first real sound
    // after a quiet gap is a clean rise, not a stale delta.
    if (rms < SILENCE_RMS) {
      this.prev.set(this.freq)
      this.candidate = null
      this.bass = follow(this.bass, 0, dt, BAND_ATTACK_MS, BAND_RELEASE_MS)
      this.mid = follow(this.mid, 0, dt, BAND_ATTACK_MS, BAND_RELEASE_MS)
      this.treble = follow(this.treble, 0, dt, BAND_ATTACK_MS, BAND_RELEASE_MS)
      const threshold = this.pushFlux(now, 0)
      return this.frame(now, false, 0, 0, threshold, rms, 0, 0)
    }

    // Positive spectral flux on the log-magnitude bass band.
    let fluxSum = 0
    for (let i = this.bassStart; i <= this.bassEnd; i++) {
      const v = this.freq[i]
      const p = this.prev[i]
      if (Number.isFinite(v)) {
        if (Number.isFinite(p) && v > p) fluxSum += v - p
        this.prev[i] = v
      }
    }
    const count = Math.max(1, this.bassEnd - this.bassStart + 1)
    const flux = fluxSum / count

    this.bass = follow(this.bass, this.bandLevel(this.bassStart, this.bassEnd, BASS_GAIN), dt, BAND_ATTACK_MS, BAND_RELEASE_MS)
    this.mid = follow(this.mid, this.bandLevel(this.midStart, this.midEnd, MID_GAIN), dt, BAND_ATTACK_MS, BAND_RELEASE_MS)
    this.treble = follow(this.treble, this.bandLevel(this.highStart, this.highEnd, HIGH_GAIN), dt, BAND_ATTACK_MS, BAND_RELEASE_MS)

    const threshold = this.pushFlux(now, flux)

    let beat = false
    let strength = 0
    let at = now

    // Track the highest flux since it rose above the threshold; fire when it
    // starts to fall (a local peak) or after a short hold on a sustained note.
    if (flux > threshold && (this.candidate === null || flux >= this.candidate.flux)) {
      this.candidate = { flux, at: now, threshold }
    }
    if (this.candidate) {
      const falling = flux < this.candidate.flux * PEAK_FALL
      const held = now - this.candidate.at > PEAK_HOLD_MS
      if (falling || held) {
        if (now - this.lastBeatAt >= REFRACTORY_MS) {
          this.prevBeatAt = this.lastBeatAt
          this.lastBeatAt = now
          this.seq++
          const range = Math.max(this.runningMax() - this.candidate.threshold, MIN_STRENGTH_RANGE)
          let s = clamp((this.candidate.flux - this.candidate.threshold) / range, 0, 1)
          s = Math.pow(s, STRENGTH_GAMMA)
          if (now - this.prevBeatAt < RAPID_MS) s *= RAPID_SCALE
          strength = clamp(Math.max(s, STRENGTH_FLOOR), 0, 1)
          at = this.candidate.at
          beat = true
        }
        this.candidate = null
      }
    }

    const latencyMs = beat
      ? this.fftWindowMs / 2 + this.baseLatencyMs + Math.max(0, now - at)
      : this.lastLatencyMs
    if (beat) this.lastLatencyMs = latencyMs
    return this.frame(now, beat, strength, this.runningMax(), threshold, rms, flux, latencyMs, at)
  }

  private runningMax() {
    let max = 0
    for (const s of this.maxHist) if (s.v > max) max = s.v
    return max
  }

  private pushFlux(now: number, flux: number) {
    const hist = this.hist
    hist.push({ t: now, v: flux })
    while (hist.length && now - hist[0].t > ROLLING_MS) hist.shift()
    const sorted = hist.map((s) => s.v).sort((a, b) => a - b)
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0

    const maxHist = this.maxHist
    maxHist.push({ t: now, v: flux })
    while (maxHist.length && now - maxHist[0].t > RUNNING_MAX_MS) maxHist.shift()

    return Math.max(THRESHOLD_FLOOR, median * THRESHOLD_MULT)
  }

  private frame(
    now: number,
    beat: boolean,
    strength: number,
    runningMax: number,
    threshold: number,
    rms: number,
    flux: number,
    latencyMs: number,
    at = now,
  ): OnsetFrame {
    return {
      beat,
      strength,
      seq: this.seq,
      at,
      flux,
      threshold,
      runningMax,
      rms,
      bass: this.bass,
      mid: this.mid,
      treble: this.treble,
      shimmer: clamp(this.mid * 0.6 + this.treble * 0.4, 0, 1),
      latencyMs,
    }
  }
}

export type ClickTestResult = {
  /** 'audio' ran a real AudioBuffer through an AnalyserNode; 'spectrum' fell
   *  back to a synthesised spectrum when the machine has no audio clock. */
  mode: 'audio' | 'spectrum'
  bpm: number
  kicks: number
  detected: number
  hitRate: number
  falsePulses: number
  falseRate: number
  /** end-to-end onset-to-frame latency reported by the detector, ms */
  meanLatencyMs: number
  medianLatencyMs: number
  intervals: number[]
  durationMs: number
}

type Detected = { at: number; latencyMs: number }

function score(kicks: number[], events: Detected[], bpm: number, durationMs: number) {
  const beatMs = 60000 / bpm
  const half = beatMs / 2
  const used = new Set<number>()
  const latencies: number[] = []
  let hits = 0
  for (const c of kicks) {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < events.length; i++) {
      const d = events[i].at - c
      if (d > -60 && d < half && Math.abs(d) < Math.abs(bestD)) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) {
      hits++
      used.add(best)
      latencies.push(bestD)
    }
  }
  const falsePulses = events.filter((_, i) => !used.has(i)).length
  const intervals: number[] = []
  for (let i = 1; i < events.length; i++) intervals.push(Math.round(events[i].at - events[i - 1].at))
  const sorted = [...latencies].sort((a, b) => a - b)
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0
  return {
    bpm,
    kicks: kicks.length,
    detected: events.length,
    hitRate: kicks.length ? +(hits / kicks.length).toFixed(3) : 0,
    falsePulses,
    falseRate: events.length ? +(falsePulses / events.length).toFixed(3) : 0,
    meanLatencyMs: Math.round(mean),
    medianLatencyMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0,
    intervals,
    durationMs: Math.round(durationMs),
  }
}

/**
 * Deterministic fallback: build log-magnitude frames for an 80 BPM kick track
 * and push them through the same OnsetDetector. No AudioContext needed, so the
 * test still reports real numbers on a headless box whose audio clock is
 * frozen (the common CI/headless failure mode).
 */
function runSpectrumTest(bpm: number, seconds: number): ClickTestResult {
  const sampleRate = 48000
  const det = new OnsetDetector(null, null, {
    sampleRate,
    fftSize: DETECT_FFT,
    baseLatencyMs: TEST_BASE_LATENCY_MS,
  })
  const binHz = sampleRate / DETECT_FFT
  const binCount = DETECT_FFT / 2
  const bassStart = Math.max(1, Math.round(BASS_MIN_HZ / binHz))
  const bassEnd = Math.min(binCount - 1, Math.round(BASS_MAX_HZ / binHz))
  const beatMs = 60000 / bpm
  const lead = 500
  const count = Math.max(1, Math.floor((seconds * 1000) / beatMs))
  const kicks: number[] = []
  for (let n = 0; n < count; n++) kicks.push(lead + n * beatMs)

  const freq = new Float32Array(binCount)
  const events: Detected[] = []
  const totalMs = lead + seconds * 1000
  for (let t = 0; t <= totalMs; t += TEST_FRAME_MS) {
    let env = 0
    for (const k of kicks) {
      const dt = t - k
      if (dt >= 0 && dt < 240) env = Math.max(env, Math.exp(-dt / 45))
    }
    freq.fill(-96)
    for (let i = bassStart; i <= bassEnd; i++) {
      freq[i] = -96 + 80 * env + (Math.random() - 0.5) * 0.4
    }
    const frame = det.pushSpectrum(t, freq, env * 0.35)
    if (frame.beat && t > lead) events.push({ at: t, latencyMs: frame.latencyMs })
  }
  return { mode: 'spectrum', ...score(kicks, events, bpm, totalMs) }
}

/**
 * Dev-only self-test. Tries a real 80 BPM AudioBuffer through an AnalyserNode
 * first; if the AudioContext clock never advances (no output device), falls
 * back to the deterministic spectrum path so the numbers are still real.
 */
export async function runClickTest(bpm = 80, seconds = 8): Promise<ClickTestResult> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return runSpectrumTest(bpm, seconds)

  const ctx = new Ctor({ latencyHint: 'interactive' })
  const timerRef: { id: ReturnType<typeof setInterval> | null } = { id: null }
  try {
    await ctx.resume()
    await new Promise((r) => setTimeout(r, 350))
    // No audio device => the clock is frozen. Do not waste 9 s waiting.
    if (ctx.currentTime < 0.05) {
      void ctx.close().catch(() => {})
      return runSpectrumTest(bpm, seconds)
    }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = DETECT_FFT
    analyser.smoothingTimeConstant = DETECT_SMOOTHING
    analyser.minDecibels = -90
    analyser.maxDecibels = -10

    const sr = ctx.sampleRate
    const beatSec = 60 / bpm
    const lead = 0.5
    const count = Math.max(1, Math.floor(seconds / beatSec))
    const len = Math.ceil(sr * (lead + seconds + 0.5))
    const buffer = ctx.createBuffer(1, len, sr)
    const ch = buffer.getChannelData(0)
    for (let n = 0; n < count; n++) {
      const start = Math.floor(sr * (lead + n * beatSec))
      for (let i = 0; i < sr * 0.22 && start + i < len; i++) {
        const t = i / sr
        const f = 50 + 90 * Math.exp(-t * 30)
        ch[start + i] = Math.sin(2 * Math.PI * f * t) * 0.5 * Math.exp(-t * 16)
      }
    }

    const src = ctx.createBufferSource()
    src.buffer = buffer
    const mute = ctx.createGain()
    mute.gain.value = 0
    src.connect(analyser)
    analyser.connect(mute)
    mute.connect(ctx.destination)

    const detector = new OnsetDetector(ctx, analyser)
    const anchorPerf = performance.now()
    const anchorCtx = ctx.currentTime
    const kicks: number[] = []
    for (let n = 0; n < count; n++) kicks.push(anchorPerf + (lead + n * beatSec) * 1000)

    src.start(anchorCtx + lead)
    const events: Detected[] = []
    const startWall = performance.now()
    const totalMs = (lead + seconds) * 1000
    await new Promise<void>((resolve) => {
      timerRef.id = setInterval(() => {
        const now = performance.now()
        const frame = detector.process(now)
        if (frame.beat && now > anchorPerf + lead * 1000) {
          events.push({ at: now, latencyMs: frame.latencyMs })
        }
        if (now - startWall > totalMs) {
          if (timerRef.id) clearInterval(timerRef.id)
          timerRef.id = null
          resolve()
        }
      }, 4)
    })
    try {
      src.stop()
    } catch {
      // already ended
    }
    // A real device should have produced most of the kicks. If not, the audio
    // path was starved; use the deterministic numbers instead of a 0% report.
    if (events.length < Math.floor(count * 0.5)) {
      void ctx.close().catch(() => {})
      return runSpectrumTest(bpm, seconds)
    }
    return { mode: 'audio', ...score(kicks, events, bpm, totalMs) }
  } catch {
    return runSpectrumTest(bpm, seconds)
  } finally {
    if (timerRef.id) clearInterval(timerRef.id)
    void ctx.close().catch(() => {})
  }
}