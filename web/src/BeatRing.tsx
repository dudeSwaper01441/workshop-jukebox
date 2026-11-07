import { useEffect, useRef, useCallback, useState } from 'react'
import type { Now } from './api'
import { useAudioBeat, type AudioBeat } from './useAudioBeat'

const DEFAULT_BPM = 100
const DEFAULT_ENERGY = 0.82

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  hue: number
  life: number
  decay: number
}

type Shock = {
  radius: number
  maxRadius: number
  thickness: number
  color: string
  alpha: number
  speed: number
}

interface BeatRingProps {
  now: Now | null
  isPlaying: boolean
  enabled: boolean
  audioMode?: boolean
}

/*
 * Neon ring visualizer. Two clock sources:
 *   audioMode: false -> internal uniform tempo grid at DEFAULT_BPM, anchored to
 *                the session playback clock (progressMs + Date.now() - at).
 *   audioMode: true  -> fires beats from real audio events streamed by the
 *                Python audio_listener.py on ws://localhost:8765.
 *
 * The ring itself is pure Canvas 2D: segmented orbiting ring, inner pulsing
 * core, particle explosions, shockwave rings, and camera shake. In audio mode
 * the kick strength comes from real bass/mid/treble FFT bands instead of a
 * tempo guess.
 *
 * Rendering notes:
 *   - Canvas is backed at devicePixelRatio so the ring stays crisp on
 *     Retina / high-DPI screens; all drawing happens in logical CSS pixels
 *     after a ctx.scale(dpr, dpr).
 *   - All mutable render state lives in a single ref (s) so the animation
 *     loop never needs to be torn down and restarted when values change
 *     frame to frame (avoids stale closures and rAF churn).
 *   - The rAF loop only runs while `enabled` is true.
 */
export default function BeatRing({
  now,
  isPlaying,
  enabled,
  audioMode = false,
}: BeatRingProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const raf = useRef(0)

  // Single mutable render state. Refs are stable across renders so the loop
  // callback can read fresh values without being re-created every frame.
  const s = useRef<{
    w: number            // logical canvas width (CSS px)
    h: number            // logical canvas height (CSS px)
    dpr: number          // device pixel ratio
    cx: number
    cy: number
    kick: number
    bass: number
    mid: number
    treble: number
    lastBeatIdx: number
    beatIdx: number
    simStart: number     // performance.now() when sim clock started
    simPause: number     // accumulated sim time while paused
    simPausedAt: number | null // performance.now() when sim was paused
    parts: Particle[]
    shocks: Shock[]
    beats: number[]      // internal tempo grid (ms offsets)
    bpm: number
    energy: number
    maxDur: number
  }>({
    w: 0,
    h: 0,
    dpr: 1,
    cx: 0,
    cy: 0,
    kick: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    lastBeatIdx: -1,
    beatIdx: 0,
    simStart: 0,
    simPause: 0,
    simPausedAt: null,
    parts: [],
    shocks: [],
    beats: [],
    bpm: DEFAULT_BPM,
    energy: DEFAULT_ENERGY,
    maxDur: 0,
  })

  // ---------- canvas sizing (DPR-aware) ----------
  const resize = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = window.innerWidth
    const h = window.innerHeight
    // Set the backing-store resolution (device pixels). The CSS box is sized
    // by position: fixed; inset: 0, so we must NOT set style.width/height —
    // that conflicts with left/right/top/bottom and leaves right/bottom
    // uncovered when the viewport is larger than window.innerWidth.
    c.width = w * dpr
    c.height = h * dpr
    s.current.w = w
    s.current.h = h
    s.current.dpr = dpr
    s.current.cx = w / 2
    s.current.cy = h / 2
  }, [])

  useEffect(() => {
    window.addEventListener('resize', resize)
    resize()
    return () => window.removeEventListener('resize', resize)
  }, [resize])

  // ---------- internal tempo grid (audioMode off) ----------
  useEffect(() => {
    if (audioMode) return
    const dur = now?.durationMs ?? 0
    const beatMs = 60000 / DEFAULT_BPM
    const beats: number[] = []
    for (let t = 0; t < (dur || 300_000); t += beatMs) beats.push(Math.round(t))

    s.current.beats = beats
    s.current.energy = DEFAULT_ENERGY
    s.current.maxDur = (dur || 300_000) + 3000
    s.current.beatIdx = 0
    s.current.lastBeatIdx = -1
    s.current.kick = 0
    s.current.parts = []
    s.current.shocks = []
  }, [now?.uri, now?.durationMs, audioMode])

  const [beatFlash, setBeatFlash] = useState(false)

  const flashBeat = useCallback(() => {
    setBeatFlash(true)
    setTimeout(() => setBeatFlash(false), 120)
  }, [])

  // ---------- beat trigger: spawns particles + a shockwave ----------
  // Defined before useAudioBeat so the audio callback never reads it
  // during initialization (const arrow functions are not hoisted).
  const triggerBeat = (bass: number, mid: number, treble: number, energy: number) => {
    flashBeat()
    const bassKick = Math.min(energy * 1.2, 1.0)
    s.current.kick = Math.max(s.current.kick, bassKick)
    s.current.bass = bass
    s.current.mid = mid
    s.current.treble = treble

    const ringEnergy = s.current.energy
    const count = Math.floor(30 + ringEnergy * 40 + mid * 25)
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 5 + Math.random() * 20 * ringEnergy + mid * 12
      s.current.parts.push({
        x: s.current.cx,
        y: s.current.cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 2 + Math.random() * 4,
        hue: Math.random() > 0.5 ? 190 : 320, // cyan or magenta
        life: 1.0,
        decay: 0.015 + Math.random() * 0.02,
      })
    }

    s.current.shocks.push({
      radius: 10,
      maxRadius: Math.max(s.current.w, s.current.h) * (0.5 + bass * 0.4),
      thickness: 6 + ringEnergy * 8 + bass * 6,
      color: Math.random() > 0.4 ? '6, 182, 212' : '236, 72, 153',
      alpha: 1.0,
      speed: 15 + ringEnergy * 15 + bass * 15,
    })
  }

  // ---------- real-time audio beats (audioMode on) ----------
  const { status: audioStatus } = useAudioBeat(
    (b: AudioBeat) => {
      if (!audioMode) return
      triggerBeat(b.bass ?? 0, b.mid ?? 0, b.treble ?? 0, b.energy ?? 0.5)
    },
    audioMode,
  )

  // ---------- ring + core + glow ----------
  const renderPulseRing = (bass: number, mid: number, treble: number) => {
    const energy = s.current.energy
    const ctx = canvasRef.current!.getContext('2d')!
    const dpr = s.current.dpr
    ctx.save()
    ctx.scale(dpr, dpr) // draw in logical CSS pixels

    const baseRadius =
      Math.min(s.current.w, s.current.h) * 0.18 +
      (bass / 255) * 60 +
      s.current.kick * 50

    // Pulsing outer glow — color shifts toward magenta on treble hits.
    const glowHue = 190 + treble * 60
    ctx.beginPath()
    ctx.arc(s.current.cx, s.current.cy, baseRadius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(6, 182, 212, ${0.1 + s.current.kick * 0.3})`
    ctx.shadowBlur = 40 * (1 + s.current.kick)
    ctx.shadowColor = `hsla(${glowHue}, 100%, 60%, ${0.5 + s.current.kick * 0.5})`
    ctx.fill()

    // Dynamic segmented orbiting ring — ring radius modulated by bass.
    const segments = 64
    ctx.lineWidth = 4 + s.current.kick * 6 + mid * 4
    ctx.strokeStyle = `hsl(${190 + s.current.kick * 120}, 100%, 60%)`

    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const freqVal = bass * 0.5 + Math.sin(i + performance.now() * 0.005) * 50 + 100
      const offset = (freqVal / 255) * 35 * energy + s.current.kick * 20 + mid * 15
      const r = baseRadius + offset
      const x = s.current.cx + Math.cos(angle) * r
      const y = s.current.cy + Math.sin(angle) * r
      if (i === 0) {
        ctx.beginPath()
        ctx.moveTo(x, y)
      } else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()

    // Inner pulsing core — size follows mid energy.
    ctx.beginPath()
    ctx.arc(
      s.current.cx,
      s.current.cy,
      baseRadius * 0.4 + (mid / 255) * 20 + s.current.kick * 30,
      0,
      Math.PI * 2,
    )
    ctx.fillStyle = `rgba(236, 72, 153, ${0.4 + s.current.kick * 0.5 + treble * 0.3})`
    ctx.fill()
    ctx.restore()
  }

  // ---------- clock source ----------
  const getTimeMs = (): number => {
    if (now) {
      if (isPlaying) return Math.min(now.durationMs, now.progressMs + (Date.now() - now.at))
      return now.progressMs
    }
    // No Spotify track: free-running simulation clock.
    if (s.current.simStart === 0) s.current.simStart = performance.now()
    if (!isPlaying) {
      // Remember when we paused so we can accumulate the elapsed time on resume.
      if (s.current.simPausedAt === null) s.current.simPausedAt = performance.now()
      return s.current.simPause
    }
    // Resuming from a paused sim: bank the elapsed pause time and reset the start.
    if (s.current.simPausedAt !== null) {
      s.current.simPause += performance.now() - s.current.simPausedAt
      s.current.simPausedAt = null
      s.current.simStart = performance.now()
    }
    return (performance.now() - s.current.simStart) + s.current.simPause
  }

  // ---------- main render loop ----------
  const renderRef = useRef<(() => void) | null>(null)

  // Keep the render function current so the rAF loop never needs to
  // re-subscribe. Assigned in an effect (not during render) to avoid
  // the "ref accessed during render" warning.
  useEffect(() => {
    renderRef.current = () => {
      const t = getTimeMs()
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!ctx) return

    // Internal beat tracking (tempo grid) — skipped in audio mode.
    if (!audioMode) {
      while (
        s.current.beatIdx < s.current.beats.length &&
        t >= s.current.beats[s.current.beatIdx]
      ) {
        if (s.current.lastBeatIdx !== s.current.beatIdx) {
          triggerBeat(s.current.bass, s.current.mid, s.current.treble, s.current.energy)
          s.current.lastBeatIdx = s.current.beatIdx
        }
        s.current.beatIdx++
      }
    }

    // Decay kick and band energies (frame-rate dependent, acceptable for a visual).
    const decay = 0.88
    s.current.kick *= decay
    s.current.bass *= decay
    s.current.mid *= decay
    s.current.treble *= decay

    // Normalize band energies to 0-255 range for the ring renderer.
    const bassVal = Math.min(s.current.bass * 300, 255)
    const midVal = Math.min(s.current.mid * 300, 255)
    const trebleVal = Math.min(s.current.treble * 300, 255)

    // Clear with trails — brighter right after a beat.
    ctx.fillStyle = `rgba(3, 7, 18, ${0.2 + (1 - s.current.kick) * 0.1})`
    ctx.fillRect(0, 0, s.current.w, s.current.h)

    ctx.save()
    // Screen camera shake on heavy hits (driven by bass).
    if (s.current.kick > 0.05) {
      const shakeX = (Math.random() - 0.5) * s.current.kick * 12
      const shakeY = (Math.random() - 0.5) * s.current.kick * 12
      ctx.translate(shakeX, shakeY)
    }

    renderPulseRing(bassVal, midVal, trebleVal)

    // Particles.
    for (let i = s.current.parts.length - 1; i >= 0; i--) {
      const p = s.current.parts[i]
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.96
      p.vy *= 0.96
      p.life -= p.decay
      if (p.life <= 0) {
        s.current.parts.splice(i, 1)
        continue
      }
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${p.hue}, 100%, 65%, ${p.life})`
      ctx.fill()
    }

    // Shockwave rings.
    for (let i = s.current.shocks.length - 1; i >= 0; i--) {
      const r = s.current.shocks[i]
      r.radius += r.speed
      r.alpha = Math.max(0, 1 - r.radius / r.maxRadius)
      if (r.alpha <= 0) {
        s.current.shocks.splice(i, 1)
        continue
      }
      ctx.beginPath()
      ctx.arc(s.current.cx, s.current.cy, r.radius, 0, Math.PI * 2)
      ctx.lineWidth = r.thickness * r.alpha
      ctx.strokeStyle = `rgba(${r.color}, ${r.alpha})`
      ctx.stroke()
    }

    ctx.restore()
  }
  })

  // Start / stop the render loop based on `enabled`. The loop reads from
  // `renderRef.current` so it always uses the latest logic without the
  // effect needing to re-subscribe on every render.
  useEffect(() => {
    if (!enabled || !canvasRef.current) {
      if (raf.current) cancelAnimationFrame(raf.current)
      return
    }
    const tick = () => {
      renderRef.current?.()
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [enabled])

  if (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    !enabled
  ) {
    return null
  }

  // Connection status dot (top-left corner): green=connected, yellow=connecting, red=disconnected
  const dotColor = audioStatus === 'connected' ? '#22c95d' : audioStatus === 'connecting' ? '#e3b341' : '#ff8f8f'

  return (
    <>
      <canvas ref={canvasRef} className="fixed inset-0 z-neg1 pointer-events-none" aria-hidden="true" />
      <div
        className="fixed top-4 left-4 z-50 flex items-center gap-2 pointer-events-none"
        style={{ border: `2px solid ${dotColor}`, boxShadow: `0 0 12px ${dotColor}` }}
      >
        <div
          className="w-3 h-3 rounded-full"
          style={{
            backgroundColor: dotColor,
            animation: beatFlash ? 'none' : 'beatPulse 2s infinite',
          }}
        />
        <span className="text-xs font-mono text-slate-200 drop-shadow">
          Audio: {audioStatus}
        </span>
      </div>
    </>
  )
}
