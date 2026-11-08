import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import type { BeatSignal, MeshLevels } from './useMeshAudio'

const DEFAULT_ENERGY = 0.82
// Kick envelope decay. ~300 ms matches the glow so the two read as one pulse.
const KICK_DECAY_MS = 300

// The canvas is this multiple of the cover box, so the glow, particles, and
// shockwaves have room outside the artwork. It is centered on the wrapper with
// a CSS transform, which keeps the drawing origin equal to the cover center.
const RING_SCALE = 2
// Ring radius relative to the cover width. 0.68 puts the outline just outside
// the artwork while the rest of the halo stays inside the canvas.
const RING_RADIUS_RATIO = 0.68

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
  enabled: boolean
  /** Drives bass/mid/treble envelopes and the shared onset detector. */
  sample: (now: number) => MeshLevels
  /** Same signal the glow backdrop pulses from. */
  beatBus: MutableRefObject<BeatSignal>
  /** Album cover (and anything else that should sit inside the ring). */
  children?: ReactNode
}

/*
 * Neon ring visualizer, anchored to the album-cover wrapper.
 *
 * Geometry:
 *   - The wrapper is exactly the cover's size (it is sized by the <img>).
 *   - The canvas is RING_SCALE x the wrapper, absolutely centered with
 *     top/left 50% + translate(-50%, -50%). Its center is therefore exactly the
 *     cover center at any window size.
 *   - A ResizeObserver re-measures the wrapper, sets the DPR backing store,
 *     and resets cx/cy to the canvas center. Nothing ever translates the
 *     drawing origin: only the radius/wobble changes.
 *
 * Beats come from the shared beat bus (the detector's bass onsets, the sim
 * clock, or the Beat Listener). There is no internal tempo grid: pulsing on a
 * guessed BPM is what made the ring feel off the music.
 */
export default function BeatRing({ enabled, sample, beatBus, children }: BeatRingProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const raf = useRef(0)

  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Single mutable render state. Refs are stable across renders so the loop
  // callback can read fresh values without being re-created every frame.
  const s = useRef<{
    w: number // logical canvas width (CSS px)
    h: number // logical canvas height (CSS px)
    coverW: number // logical cover width (CSS px)
    dpr: number
    cx: number
    cy: number
    kick: number
    bass: number
    mid: number
    treble: number
    lastBeatSeq: number
    last: number
    energy: number
    parts: Particle[]
    shocks: Shock[]
  }>({
    w: 0,
    h: 0,
    coverW: 0,
    dpr: 1,
    cx: 0,
    cy: 0,
    kick: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    lastBeatSeq: -1,
    last: 0,
    energy: DEFAULT_ENERGY,
    parts: [],
    shocks: [],
  })

  // ---------- sizing: derive the canvas from the cover wrapper ----------
  const resize = useCallback(() => {
    const wrap = wrapRef.current
    const c = canvasRef.current
    if (!wrap || !c) return
    const coverW = wrap.clientWidth
    const coverH = wrap.clientHeight
    if (!coverW || !coverH) return

    const dpr = window.devicePixelRatio || 1
    const w = coverW * RING_SCALE
    const h = coverH * RING_SCALE
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)

    // The old flight paths are relative to the old center; drop them so a
    // resize never leaves visible debris off to one side.
    if (s.current.w !== w || s.current.h !== h) {
      s.current.parts = []
      s.current.shocks = []
    }

    s.current.w = w
    s.current.h = h
    s.current.coverW = coverW
    s.current.dpr = dpr
    s.current.cx = w / 2
    s.current.cy = h / 2
  }, [])

  useEffect(() => {
    if (!enabled || reducedMotion) return
    resize()
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    window.addEventListener('resize', resize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [enabled, reducedMotion, resize])

  // ---------- beat trigger: particles + shockwave ----------
  // Called from the render loop when the shared beat sequence advances.
  const triggerBeat = (strength: number) => {
    const kick = Math.min(Math.max(strength, 0.2), 1)
    s.current.kick = Math.max(s.current.kick, kick)

    const ringEnergy = s.current.energy
    const coverW = s.current.coverW || 320
    const scale = coverW / 360
    const count = Math.floor(18 + ringEnergy * 28 + kick * 44)
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = (5 + Math.random() * 18 * ringEnergy + kick * 16) * scale
      s.current.parts.push({
        x: s.current.cx,
        y: s.current.cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: (2 + Math.random() * 4) * Math.max(0.8, scale),
        hue: Math.random() > 0.5 ? 190 : 320, // cyan or magenta
        life: 1,
        decay: 0.015 + Math.random() * 0.02,
      })
    }

    s.current.shocks.push({
      radius: 10,
      maxRadius: coverW * (1.0 + kick * 0.5),
      thickness: 5 + ringEnergy * 6 + kick * 12,
      color: Math.random() > 0.4 ? '6, 182, 212' : '236, 72, 153',
      alpha: 1,
      speed: (14 + ringEnergy * 12 + kick * 26) * scale,
    })
  }

  // ---------- ring + core ----------
  // All radius modifiers act on the radius only. cx/cy stay fixed.
  const renderPulseRing = (bass: number, mid: number, treble: number) => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const coverW = s.current.coverW || Math.min(s.current.w, s.current.h) / RING_SCALE
    const energy = s.current.energy
    const scale = coverW / 360
    const kick = s.current.kick
    ctx.save()

    const baseRadius = coverW * RING_RADIUS_RATIO + (bass * 22 + kick * 30) * scale

    // Pulsing outer glow — color shifts toward magenta on treble hits.
    const glowHue = 190 + treble * 60
    ctx.beginPath()
    ctx.arc(s.current.cx, s.current.cy, baseRadius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(6, 182, 212, ${0.09 + kick * 0.45})`
    ctx.shadowBlur = 40 * (1 + kick * 1.4)
    ctx.shadowColor = `hsla(${glowHue}, 100%, 60%, ${0.5 + kick * 0.5})`
    ctx.fill()

    // Segmented orbiting ring — each vertex wobbles on its own radius.
    const segments = 64
    ctx.lineWidth = (4 + kick * 8 + mid * 4) * scale
    ctx.strokeStyle = `hsl(${190 + kick * 120}, 100%, 60%)`

    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const freqVal = bass * 127 + Math.sin(i + performance.now() * 0.005) * 50 + 100
      const offset = ((freqVal / 255) * 35 * energy + kick * 26 + mid * 15) * scale
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

    // Inner pulsing core — mostly hidden behind the artwork, visible as a rim.
    ctx.beginPath()
    ctx.arc(
      s.current.cx,
      s.current.cy,
      baseRadius * 0.4 + (mid * 18 + kick * 26) * scale,
      0,
      Math.PI * 2,
    )
    ctx.fillStyle = `rgba(236, 72, 153, ${Math.min(1, 0.38 + kick * 0.5 + treble * 0.3)})`
    ctx.fill()
    ctx.restore()
  }

  // ---------- main render loop ----------
  const renderRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    renderRef.current = () => {
      const now = performance.now()
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return

      // Drive the shared detector even when the glow backdrop is off, then
      // consume the beat bus. Publishing is idempotent, so whichever loop runs
      // first in a frame produces exactly one pulse for both. A trusted
      // listener beat mutes the detector so the two never double-pulse.
      const lv = sample(now)
      const bus0 = beatBus.current
      if (
        !(bus0.listenerUntil && now < bus0.listenerUntil) &&
        lv.beat &&
        lv.beatSeq !== bus0.detSeq
      ) {
        beatBus.current = {
          seq: bus0.seq + 1,
          detSeq: lv.beatSeq,
          at: lv.beatAt,
          strength: lv.strength,
          source: lv.mode === 'sim' ? 'sim' : 'audio',
          listenerUntil: bus0.listenerUntil,
        }
      }
      const bus = beatBus.current
      if (bus.seq !== s.current.lastBeatSeq) {
        s.current.lastBeatSeq = bus.seq
        triggerBeat(bus.strength)
      }

      // Decay the kick exponentially (frame-rate independent).
      const dt = Math.min(80, Math.max(0, now - s.current.last))
      s.current.last = now
      s.current.kick *= Math.exp(-dt / KICK_DECAY_MS)
      // Band envelopes follow the live levels so the wobble keeps moving
      // between beats instead of freezing.
      s.current.bass = lv.bass
      s.current.mid = lv.mid
      s.current.treble = lv.treble
      s.current.energy = 0.55 + lv.energy * 0.4

      const bass = Math.min(s.current.bass, 1)
      const mid = Math.min(s.current.mid, 1)
      const treble = Math.min(s.current.treble, 1)

      // Draw in logical CSS pixels; the backing store stays DPR-sharp.
      ctx.setTransform(s.current.dpr, 0, 0, s.current.dpr, 0, 0)
      ctx.clearRect(0, 0, s.current.w, s.current.h)

      renderPulseRing(bass, mid, treble)

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
    }
  })

  // Start / stop the render loop based on `enabled`.
  useEffect(() => {
    if (!enabled || reducedMotion || !canvasRef.current) {
      if (raf.current) cancelAnimationFrame(raf.current)
      return
    }
    const tick = () => {
      renderRef.current?.()
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [enabled, reducedMotion])

  return (
    <div ref={wrapRef} className="display-art-wrap">
      {enabled && !reducedMotion && (
        <canvas ref={canvasRef} className="ring-canvas" aria-hidden="true" />
      )}
      {children}
    </div>
  )
}
