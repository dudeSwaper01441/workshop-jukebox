import { useCallback, useEffect, useRef, useState } from 'react'

export type AudioBeat = {
  event: string
  timestamp: number
  energy: number
  band?: string
  bass?: number
  mid?: number
  treble?: number
}

type AudioStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected'

export function useAudioBeat(
  onBeat: (b: AudioBeat) => void,
  enabled: boolean,
) {
  const onBeatRef = useRef(onBeat)
  onBeatRef.current = onBeat

  const [status, setStatus] = useState<AudioStatus>(enabled ? 'connecting' : 'disabled')
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const set = (s: AudioStatus) => {
    setStatus(s)
    console.log('[AudioBeat] status:', s)
  }

  const connect = useCallback(() => {
    if (!enabled) {
      set('disabled')
      return
    }
    set('connecting')
    console.log('[AudioBeat] connecting to ws://localhost:8765')
    try {
      const ws = new WebSocket('ws://localhost:8765')
      wsRef.current = ws
      ws.onopen = () => {
        console.log('[AudioBeat] WebSocket OPEN')
        set('connected')
      }
      ws.onclose = () => {
        console.log('[AudioBeat] WebSocket CLOSED')
        wsRef.current = null
        set('disconnected')
        timerRef.current = setTimeout(connect, 1000)
      }
      ws.onmessage = (e) => {
        try {
          onBeatRef.current(JSON.parse(e.data) as AudioBeat)
        } catch {}
      }
      ws.onerror = (err) => {
        console.log('[AudioBeat] WebSocket ERROR:', err)
        ws?.close()
      }
    } catch (e) {
      console.log('[AudioBeat] WebSocket constructor error:', e)
      timerRef.current = setTimeout(connect, 2000)
    }
  }, [enabled])

  useEffect(() => {
    connect()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      wsRef.current?.close()
      wsRef.current = null
      set('disabled')
    }
  }, [connect, enabled])

  return { status }
}
