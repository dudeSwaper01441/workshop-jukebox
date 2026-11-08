import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { DEFAULT_PALETTE, useArtPalette } from './palette'
import type { BeatSignal, MeshLevels } from './useMeshAudio'

// ---------- tunables ----------
const BLOB_COUNT = 5
const PALETTE_FADE_MS = 1500
// Exponential decay of the glow pulse. ~300 ms keeps a hard kick visible
// without bleeding into the next beat at 80-160 BPM.
const PULSE_DECAY_MS = 300
// Brightness/scale pushed onto the shader by a full-strength pulse.
const PULSE_BRIGHTNESS = 0.22
const PULSE_SIZE = 0.08
const PULSE_PUSH = 0.06
const FLOW_SPEED = 0.000045
const MAX_PIXELS = 1_500_000

type BlobParam = {
  ax: number
  ay: number
  fx: number
  fy: number
  px: number
  py: number
  size: number
}

// Each blob drifts on its own slow Lissajous path. The phases are spread out
// so they never all sit in the same corner at once.
const BLOB_PARAMS: BlobParam[] = [
  { ax: 0.34, ay: 0.28, fx: 0.31, fy: 0.23, px: 0.0, py: 1.7, size: 0.52 },
  { ax: 0.30, ay: 0.32, fx: 0.21, fy: 0.29, px: 2.1, py: 0.4, size: 0.48 },
  { ax: 0.38, ay: 0.26, fx: 0.17, fy: 0.33, px: 4.2, py: 3.1, size: 0.56 },
  { ax: 0.28, ay: 0.34, fx: 0.27, fy: 0.19, px: 1.2, py: 5.0, size: 0.46 },
  { ax: 0.32, ay: 0.30, fx: 0.23, fy: 0.27, px: 3.4, py: 2.2, size: 0.50 },
]

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG = `
precision mediump float;
#define BLOBS ${BLOB_COUNT}
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uEnergy;
uniform float uPulse;
uniform float uShimmer;
uniform vec3 uBase;
uniform vec3 uPos[BLOBS];
uniform vec3 uColor[BLOBS];
uniform float uSize[BLOBS];

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // aspect-corrected coordinates: x in [0, aspect], y in [0, 1]
  vec2 p = gl_FragCoord.xy / uRes.y;
  vec3 col = uBase;

  for (int i = 0; i < BLOBS; i++) {
    vec2 d = p - uPos[i].xy;
    float r = uSize[i] * (1.0 + uBass * 0.22 + uPulse * ${PULSE_SIZE.toFixed(3)} + uShimmer * 0.03);
    // inverse-quadratic falloff: a long, soft tail like a blurred blob,
    // much cheaper than exp() at full-screen resolution
    float q = dot(d, d) / max(r * r, 0.0001);
    float f = 1.0 / (1.0 + q * 1.4);
    f *= f;
    col += uColor[i] * f * (0.62 + uEnergy * 0.20) * (1.0 + uBass * 0.20 + uPulse * ${PULSE_BRIGHTNESS.toFixed(3)} + uShimmer * 0.06);
  }

  // gentle rolloff keeps highlights from blowing out on cheap projectors
  col = col / (1.0 + col * 0.45);

  float aspect = uRes.x / uRes.y;
  vec2 q = vec2(p.x / max(aspect, 0.0001), p.y) - 0.5;
  col *= 1.0 - dot(q, q) * 0.55;

  // dither: large flat gradients band badly on 8-bit panels
  float n = hash21(gl_FragCoord.xy + fract(uTime) * 100.0);
  col += (n - 0.5) * 0.012;

  gl_FragColor = vec4(col, 1.0);
}
`

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return [0, 0, 0]
  const n = Number.parseInt(match[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function paletteToRgb(palette: readonly string[]): Rgb[] {
  const out: Rgb[] = []
  for (let i = 0; i < 5; i++) out.push(hexToRgb(palette[i] ?? DEFAULT_PALETTE[i]))
  return out
}

type Props = {
  enabled: boolean
  artUrl: string | null
  sample: (now: number) => MeshLevels
  /** Shared beat signal; the same onsets drive the ring. */
  beatBus: MutableRefObject<BeatSignal>
}

export default function MeshBackdrop({ enabled, artUrl, sample, beatBus }: Props) {
  const palette = useArtPalette(artUrl)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [glFailed, setGlFailed] = useState(false)
  const [glEpoch, setGlEpoch] = useState(0)

  const currentPaletteRef = useRef<Rgb[]>(paletteToRgb(DEFAULT_PALETTE))
  const targetPaletteRef = useRef<Rgb[]>(paletteToRgb(DEFAULT_PALETTE))
  const fadeFromRef = useRef<Rgb[]>(paletteToRgb(DEFAULT_PALETTE))
  const fadeStartRef = useRef(0)

  // Crossfade palette colors over ~1.5s whenever the album art changes. The
  // fade starts from the currently displayed (possibly mid-fade) colors, so
  // skipping through songs quickly never snaps.
  useEffect(() => {
    fadeFromRef.current = currentPaletteRef.current.map((c) => [c[0], c[1], c[2]] as Rgb)
    targetPaletteRef.current = paletteToRgb(palette)
    fadeStartRef.current = performance.now()
  }, [palette])

  useEffect(() => {
    if (!enabled) return
    const canvas = canvasRef.current
    if (!canvas) return

    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        powerPreference: 'low-power',
      })
    } catch {
      gl = null
    }
    if (!gl) {
      setGlFailed(true)
      return
    }
    const glc = gl
    setGlFailed(false)

    const compile = (type: number, src: string) => {
      const shader = glc.createShader(type)
      if (!shader) throw new Error('Could not create shader')
      glc.shaderSource(shader, src)
      glc.compileShader(shader)
      if (!glc.getShaderParameter(shader, glc.COMPILE_STATUS)) {
        const log = glc.getShaderInfoLog(shader) ?? 'Shader compile failed'
        glc.deleteShader(shader)
        throw new Error(log)
      }
      return shader
    }

    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null
    try {
      const vs = compile(glc.VERTEX_SHADER, VERT)
      const fs = compile(glc.FRAGMENT_SHADER, FRAG)
      program = glc.createProgram()
      if (!program) throw new Error('Could not create program')
      glc.attachShader(program, vs)
      glc.attachShader(program, fs)
      glc.linkProgram(program)
      if (!glc.getProgramParameter(program, glc.LINK_STATUS))
        throw new Error(glc.getProgramInfoLog(program) ?? 'Shader link failed')
      glc.deleteShader(vs)
      glc.deleteShader(fs)
      glc.useProgram(program)

      buffer = glc.createBuffer()
      if (!buffer) throw new Error('Could not create buffer')
      glc.bindBuffer(glc.ARRAY_BUFFER, buffer)
      glc.bufferData(
        glc.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        glc.STATIC_DRAW,
      )
      const aPos = glc.getAttribLocation(program, 'aPos')
      glc.enableVertexAttribArray(aPos)
      glc.vertexAttribPointer(aPos, 2, glc.FLOAT, false, 0, 0)
    } catch (e) {
      console.warn('mesh backdrop: WebGL init failed', e)
      setGlFailed(true)
      return
    }
    if (!program || !buffer) {
      setGlFailed(true)
      return
    }
    const prog = program
    const buf = buffer

    const loc = {
      res: glc.getUniformLocation(prog, 'uRes'),
      time: glc.getUniformLocation(prog, 'uTime'),
      bass: glc.getUniformLocation(prog, 'uBass'),
      energy: glc.getUniformLocation(prog, 'uEnergy'),
      pulse: glc.getUniformLocation(prog, 'uPulse'),
      shimmer: glc.getUniformLocation(prog, 'uShimmer'),
      base: glc.getUniformLocation(prog, 'uBase'),
      pos: glc.getUniformLocation(prog, 'uPos[0]'),
      color: glc.getUniformLocation(prog, 'uColor[0]'),
      size: glc.getUniformLocation(prog, 'uSize[0]'),
    }

    const resize = () => {
      const w = Math.max(1, window.innerWidth)
      const h = Math.max(1, window.innerHeight)
      // The backdrop is heavily blurred, so it does not need full retina
      // resolution. Cap the total pixels to keep mid-range laptops at 60fps.
      const dpr = Math.min(2, Math.max(0.25, Math.sqrt(MAX_PIXELS / (w * h))))
      const cw = Math.max(1, Math.floor(w * dpr))
      const ch = Math.max(1, Math.floor(h * dpr))
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
        glc.viewport(0, 0, cw, ch)
      }
    }
    resize()
    window.addEventListener('resize', resize)

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = mq.matches
    const onMotion = (e: MediaQueryListEvent) => {
      reduced = e.matches
    }
    mq.addEventListener('change', onMotion)

    let raf = 0
    const onLost = (e: Event) => {
      e.preventDefault()
      if (raf) cancelAnimationFrame(raf)
      setGlFailed(true)
    }
    const onRestored = () => {
      setGlFailed(false)
      setGlEpoch((v) => v + 1)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    let last = performance.now()
    let flow = 0
    let pulse = 0
    let lastBeatSeq = -1

    const flatPos = new Float32Array(BLOB_COUNT * 3)
    const flatColor = new Float32Array(BLOB_COUNT * 3)
    const sizes = new Float32Array(BLOB_COUNT)
    const current = currentPaletteRef.current

    const draw = (now: number) => {
      const dt = Math.min(50, Math.max(0, now - last))
      last = now
      if (document.hidden) {
        raf = requestAnimationFrame(draw)
        return
      }

      const lv = sample(now)
      const motion = reduced ? 0.25 : 1
      const idle = lv.mode === 'idle'

      // Publish this frame's detector onset to the shared signal exactly once,
      // so the ring can consume the identical beat. A trusted listener beat
      // mutes the detector so the two never double-pulse.
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
      // Instant attack on any new beat (detector, sim, or listener).
      const bus = beatBus.current
      if (bus.seq !== lastBeatSeq) {
        lastBeatSeq = bus.seq
        pulse = bus.strength
      }
      pulse *= Math.exp(-dt / PULSE_DECAY_MS)
      const bass = idle ? 0 : lv.bass * motion
      const energy = idle ? 0 : lv.energy
      const shimmer = idle ? 0 : lv.shimmer
      const pulseLevel = idle ? 0 : pulse * motion

      // Energy sets the base drift speed; a beat briefly spikes it. Idle keeps
      // only the slow, barely-there drift.
      const flowRate = idle ? 0.32 : 0.6 + energy * 1.4 + pulse * 1.6
      flow += dt * flowRate * motion

      const fade = Math.min(1, (now - fadeStartRef.current) / PALETTE_FADE_MS)
      const eased = fade * fade * (3 - 2 * fade)
      const from = fadeFromRef.current
      const target = targetPaletteRef.current
      for (let i = 0; i < 5; i++) {
        const a = from[i]
        const b = target[i]
        const c = current[i]
        c[0] = a[0] + (b[0] - a[0]) * eased
        c[1] = a[1] + (b[1] - a[1]) * eased
        c[2] = a[2] + (b[2] - a[2]) * eased
      }

      const aspect = canvas.width / Math.max(1, canvas.height)
      const t = flow * FLOW_SPEED
      const cx = aspect * 0.5
      const cy = 0.5
      const push = 1 + pulseLevel * PULSE_PUSH
      for (let i = 0; i < BLOB_COUNT; i++) {
        const p = BLOB_PARAMS[i]
        const x = aspect * (0.5 + p.ax * motion * Math.sin(t * p.fx * Math.PI * 2 + p.px))
        const y = 0.5 + p.ay * motion * Math.sin(t * p.fy * Math.PI * 2 + p.py)
        flatPos[i * 3] = cx + (x - cx) * push
        flatPos[i * 3 + 1] = cy + (y - cy) * push
        flatPos[i * 3 + 2] = 0
        sizes[i] = p.size
      }

      const c0 = current[0]
      const c1 = current[1]
      const c2 = current[2]
      const c3 = current[3]
      const colors = [c0, c1, c2, c3, mixRgb(c0, c2, 0.5)]
      const base = current[4]
      for (let i = 0; i < BLOB_COUNT; i++) {
        const c = colors[i]
        flatColor[i * 3] = c[0]
        flatColor[i * 3 + 1] = c[1]
        flatColor[i * 3 + 2] = c[2]
      }

      glc.useProgram(prog)
      glc.uniform2f(loc.res, canvas.width, canvas.height)
      glc.uniform1f(loc.time, now * 0.001)
      glc.uniform1f(loc.bass, bass)
      glc.uniform1f(loc.energy, energy)
      glc.uniform1f(loc.pulse, pulseLevel)
      glc.uniform1f(loc.shimmer, shimmer)
      glc.uniform3f(loc.base, base[0], base[1], base[2])
      glc.uniform3fv(loc.pos, flatPos)
      glc.uniform3fv(loc.color, flatColor)
      glc.uniform1fv(loc.size, sizes)
      glc.drawArrays(glc.TRIANGLE_STRIP, 0, 4)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      mq.removeEventListener('change', onMotion)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      glc.deleteBuffer(buf)
      glc.deleteProgram(prog)
    }
  }, [enabled, sample, beatBus, glEpoch])

  if (!enabled) return null

  const colors = palette.length >= 5 ? palette : [...DEFAULT_PALETTE]
  const [c0, c1, c2, c3, c4] = colors
  const fallbackCss = [
    `radial-gradient(60% 70% at 18% 28%, ${c0}66 0%, transparent 70%)`,
    `radial-gradient(55% 65% at 82% 22%, ${c1}55 0%, transparent 68%)`,
    `radial-gradient(65% 70% at 62% 82%, ${c2}66 0%, transparent 70%)`,
    `radial-gradient(50% 60% at 30% 88%, ${c3}55 0%, transparent 65%)`,
    c4,
  ].join(', ')

  return (
    <div className="mesh-backdrop" aria-hidden="true">
      <div className="mesh-fallback" style={{ background: fallbackCss }} />
      <canvas ref={canvasRef} style={{ opacity: glFailed ? 0 : 1 }} />
    </div>
  )
}
