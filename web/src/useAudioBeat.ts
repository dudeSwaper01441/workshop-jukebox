import { useCallback, useEffect, useRef, useState } from 'react'

export type AudioBeat = {
  event: string
  timestamp: number
  energy: number
  band?: string
  bass?: number
  mid?: number
  treble?: number
  rms?: number
}

export type AudioBeatStatus = 'disabled' | 'connecting' | 'connected' | 'unavailable'

// External listener, only started when the user turns the switch on.
const WS_URL = 'ws://localhost:8765'
// 1s, 2s, 4s, 8s between attempts. Five failed attempts total, then give up
// until the user presses Retry (or toggles the switch off and on again).
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10_000] as const
const MAX_ATTEMPTS = 5
// Absolute noise floors. The Python listener already rejects weak onsets, but
// these make the browser independent of that tuning: a quiet room must never
// produce a beat or leave the ring pulsing.
const SILENCE_ENERGY = 0.02
const SILENCE_RMS = 0.002

export function useAudioBeat(
  onBeat: (b: AudioBeat) => void,
  enabled: boolean,
  onReset?: () => void,
) {
  const onBeatRef = useRef(onBeat)
  const onResetRef = useRef(onReset)
  // Sync callbacks in an effect so the socket handlers always see the latest
  // ones without touching refs during render.
  useEffect(() => {
    onBeatRef.current = onBeat
    onResetRef.current = onReset
  }, [onBeat, onReset])

  const [status, setStatus] = useState<AudioBeatStatus>(enabled ? 'connecting' : 'disabled')
  // Incrementing this is the only thing that starts a new attempt cycle after
  // the hook has given up. A plain re-render never reconnects.
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!enabled) {
      onResetRef.current?.()
      return
    }

    // Every effect run owns its own socket and cancellation flag, so a
    // StrictMode double-mount cannot let the first run's close handler retry
    // or touch the second run's state.
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let socket: WebSocket | null = null
    let attempts = 0

    function detach() {
      if (!socket) return
      socket.onopen = null
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      try {
        socket.close()
      } catch {
        // already closed
      }
      socket = null
    }

    function scheduleRetry() {
      if (stopped) return
      if (attempts >= MAX_ATTEMPTS) {
        setStatus('unavailable')
        return
      }
      const delay = RECONNECT_DELAYS_MS[Math.min(attempts - 1, RECONNECT_DELAYS_MS.length - 1)]
      timer = setTimeout(() => {
        timer = null
        connect()
      }, delay)
    }

    function connect() {
      if (stopped) return
      detach()
      attempts += 1
      setStatus('connecting')

      let next: WebSocket
      try {
        next = new WebSocket(WS_URL)
      } catch {
        scheduleRetry()
        return
      }
      socket = next

      next.onopen = () => {
        if (stopped || socket !== next) return
        // A healthy connection resets the backoff ladder, so a later drop
        // starts again at 1s instead of inheriting an old failure count.
        attempts = 0
        setStatus('connected')
      }

      next.onmessage = (event) => {
        if (stopped || socket !== next) return
        let beat: AudioBeat
        try {
          beat = JSON.parse(String(event.data)) as AudioBeat
        } catch {
          return
        }
        const energy = typeof beat.energy === 'number' ? beat.energy : 0
        const rms = typeof beat.rms === 'number' ? beat.rms : null
        // Silence gate: no beat, bass or energy may reach the visuals.
        if (energy < SILENCE_ENERGY || (rms !== null && rms < SILENCE_RMS)) {
          onResetRef.current?.()
          return
        }
        onBeatRef.current(beat)
      }

      next.onerror = () => {
        if (stopped || socket !== next) return
        try {
          next.close()
        } catch {
          // close() is best-effort; onclose still drives the retry
        }
      }

      next.onclose = () => {
        if (stopped || socket !== next) return
        detach()
        // attempts is 0 after a successful open; count this drop as the first
        // failure of the new ladder.
        if (attempts === 0) attempts = 1
        scheduleRetry()
      }
    }

    connect()

    return () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      detach()
      onResetRef.current?.()
    }
  }, [enabled, retryKey])

  const retry = useCallback(() => setRetryKey((key) => key + 1), [])

  // OFF is derived, not stored: a stale "connected" from before the toggle
  // must never leak into the pill while the switch is off.
  return { status: enabled ? status : 'disabled', retry }
}
