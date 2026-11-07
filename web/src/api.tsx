import { useCallback, useEffect, useState } from 'react'

export type Track = {
  uri: string
  name: string
  artists: string
  image: string | null
  durationMs: number
  explicit: boolean
}
export type Now = {
  name: string
  artists: string
  image: string | null
  uri: string
  durationMs: number
  isPlaying: boolean
  explicit: boolean
  progressMs: number
  remainingMs: number
  at: number
  mine: boolean
}
export type QueueItem = {
  id: string
  name: string
  artists: string
  image: string | null
  durationMs: number
  mine: boolean
}
export type PlayedItem = {
  uri: string
  name: string
  artists: string
  durationMs: number
  at: number
}
export type ExternalTrack = {
  uri: string
  name: string
  artists: string
  image: string | null
  durationMs: number
  explicit: boolean
}
export type State = {
  now: Now | null
  paused: boolean
  local: boolean
  playerWaiting: boolean
  playerError: boolean
  playerMessage: string | null
  cooldownMs: number
  queue: QueueItem[]
  externalQueue: ExternalTrack[]
  limits: { maxPending: number; maxTrackMin: number; cooldownSec: number }
  explicitBlocked: boolean
  session: { startedAt: number; playedMs: number; played: PlayedItem[] }
  problem: string | null
  verbose?: number
}

const makeId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)

function getClientId() {
  try {
    let id = localStorage.getItem('jb_client')
    if (!id) {
      id = makeId()
      localStorage.setItem('jb_client', id)
    }
    return id
  } catch {
    return makeId()
  }
}
const clientId = getClientId()

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; pin?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  // A hung transport (dead tunnel, dropped Wi-Fi) must surface as an error,
  // not spin forever. 20s default lets the server's own precise errors
  // (its aborts fire ≤15s) arrive first. Combines with a caller signal
  // manually — no AbortSignal.any, so old phone browsers still work.
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  if (opts.signal?.aborted) ctl.abort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () =>
      ctl.abort(
        new DOMException('The server is taking too long. Check your connection.', 'TimeoutError'),
      ),
    opts.timeoutMs ?? 20_000,
  )
  try {
    const res = await fetch('/api' + path, {
      method: opts.method ?? 'GET',
      signal: ctl.signal,
      headers: {
        'x-client-id': clientId,
        ...(opts.pin ? { 'x-admin-pin': opts.pin } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
    return data as T
  } catch (e) {
    // our own timeout carries words; a caller abort rethrows untouched so
    // debounced searches keep swallowing it via their own signal
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new Error(e.message)
    throw e
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

export const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export const eta = (ms: number) => (ms < 60_000 ? 'under a minute' : `${Math.round(ms / 60_000)} min`)
export const fmtUptime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

export function useTicker(active: boolean, intervalMs = 500) {
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setClock(Date.now())
    const t = setInterval(() => setClock(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
  return clock
}

export function useJukebox(pin?: string) {
  const [state, setState] = useState<State | null>(null)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setState(await api<State>('/state', { pin }))
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [pin])

  // WebSocket for instant state push: the server broadcasts on every mutation,
  // so clients don't have to wait for the next poll cycle.
  const [wsKey, setWsKey] = useState(0)
  useEffect(() => {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${wsProto}//${window.location.host}/api/ws`)

    ws.onopen = () => {
      // Connected: fetch fresh state immediately
      refresh()
    }

    ws.onmessage = () => {
      // Server pushed a state-change notification: pull fresh state now
      refresh()
    }

    ws.onclose = () => {
      // Reconnect after a short delay (key change remounts this effect)
      setTimeout(() => setWsKey(k => k + 1), 2000)
    }

    return () => ws.close()
  }, [refresh, wsKey])

  // lively = music context exists: poll fast (1s) so Now Playing, the queue,
  // and stats feel live. Fully idle (nothing playing/queued): 2.5s to save battery.
  const lively =
    !!state?.now ||
    (state?.queue.length ?? 0) > 0 ||
    (state?.externalQueue?.length ?? 0) > 0 ||
    !!state?.playerWaiting
  useEffect(() => {
    refresh()
    const t = setInterval(() => {
      // paused in hidden tabs to save battery and avoid stale countdowns
      if (document.hidden) return
      refresh()
    }, lively ? 1000 : 2500)
    const onVis = () => {
      if (!document.hidden) refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh, lively])

  return { state, offline, refresh }
}