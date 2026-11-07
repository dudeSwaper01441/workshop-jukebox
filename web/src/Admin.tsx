import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fmt, useJukebox, useTicker } from './api'
import RequestModal from './RequestModal'
import Stats from './Stats'
import Status from './Status'
import {
  IconClose,
  IconNote,
  IconPause,
  IconPlay,
  IconPlus,
  IconPower,
  IconRefresh,
  IconSkip,
  IconStop,
  IconWifiOff,
} from './icons'

type Device = { id: string; name: string; type: string; isActive: boolean; volumePercent: number | null }

function loadPin(): string | null {
  try {
    return sessionStorage.getItem('jb_pin')
  } catch {
    return null
  }
}

export default function Admin() {
  const [pin, setPin] = useState<string | null>(loadPin)
  const [input, setInput] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const login = async () => {
    if (!input || busy) return
    setBusy(true)
    try {
      await api('/admin/check', { method: 'POST', pin: input })
      try {
        sessionStorage.setItem('jb_pin', input)
      } catch {
        // private mode: stay logged in for this tab only
      }
      setPin(input)
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const logout = () => {
    try {
      sessionStorage.removeItem('jb_pin')
    } catch {
      // ignore
    }
    setPin(null)
    setInput('')
  }

  if (!pin) {
    return (
      <main className="wrap">
        <header className="top">
          <div className="brand">
            <IconNote size={17} />
            <span className="brand-name">Admin</span>
          </div>
        </header>
        <section className="card">
          <div className="section-head">
            <h2>Enter PIN</h2>
          </div>
          <input
            type="password"
            value={input}
            placeholder="PIN"
            aria-label="Admin PIN"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
          />
          <div className="actions">
            <button className="primary" onClick={login} disabled={busy || !input}>
              {busy ? 'Checking…' : 'Enter'}
            </button>
          </div>
          <div className="slot">{err && <p className="error">{err}</p>}</div>
        </section>
      </main>
    )
  }
  return <Panel pin={pin} onLogout={logout} />
}

function Devices({ pin }: { pin: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [vol, setVol] = useState<number | null>(null)
  const volTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setBusy('list')
    setMsg('')
    try {
      const list = await api<Device[]>('/admin/devices', { pin })
      setDevices(list)
      const active = list.find((d) => d.isActive) ?? list[0]
      if (active?.volumePercent != null) setVol(active.volumePercent)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy('')
    }
  }, [pin])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => () => {
    if (volTimer.current) clearTimeout(volTimer.current)
  }, [])

  const changeVolume = (v: number) => {
    setVol(v)
    if (volTimer.current) clearTimeout(volTimer.current)
    volTimer.current = setTimeout(async () => {
      try {
        await api('/admin/volume', { method: 'POST', body: { percent: v }, pin })
      } catch (e) {
        setMsg((e as Error).message)
      }
    }, 400)
  }

  const chooseDevice = async (d: Device) => {
    setBusy(d.id)
    setMsg('')
    try {
      await api('/admin/device', { method: 'POST', body: { id: d.id }, pin })
      setMsg(`Now playing on ${d.name}.`)
      await load()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const launch = async () => {
    setBusy('launch')
    setMsg('')
    try {
      const r = await api<{ ok: boolean; devices: Device[] }>('/admin/launch', {
        method: 'POST',
        pin,
        timeoutMs: 30_000, // waits out the device-appear window server-side
      })
      setDevices(r.devices)
      if (!r.ok) setMsg('Spotify is opening. Wait a few seconds, then press Refresh.')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>Playback device</h2>
        <span className="meta">{devices?.length ?? '…'} found</span>
      </div>
      {devices ? (
        devices.length ? (
          <div role="radiogroup" aria-label="Playback device">
            {devices.map((d) => (
              <button
                key={d.id}
                role="radio"
                aria-checked={d.isActive}
                className="dev-row"
                disabled={busy === d.id}
                onClick={() => chooseDevice(d)}
              >
                <span className="radio" aria-hidden="true" />
                <span className="grow">
                  <strong>{d.name}</strong>
                  <div className="muted">
                    {d.type}
                    {d.isActive && ' · active'}
                  </div>
                </span>
                {busy === d.id && <span className="meta">…</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">No devices. Open Spotify on the laptop first.</p>
        )
      ) : (
        <p className="muted">Loading devices…</p>
      )}
      {msg && <p className="muted">{msg}</p>}
      {vol != null && (
        <label className="vol">
          Volume: {vol}%
          <input
            type="range"
            min={0}
            max={100}
            value={vol}
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
        </label>
      )}
      <div className="actions">
        <button disabled={busy === 'list'} onClick={load}>
          <IconRefresh size={14} />
          {busy === 'list' ? 'Refreshing…' : 'Refresh'}
        </button>
        <button disabled={busy === 'launch'} onClick={launch}>
          {busy === 'launch' ? 'Opening…' : 'Open Spotify app'}
        </button>
      </div>
    </section>
  )
}

function Panel({ pin, onLogout }: { pin: string; onLogout: () => void }) {
  const { state, offline, refresh } = useJukebox(pin)
  const [err, setErr] = useState('')
  const [showRequest, setShowRequest] = useState(false)
  // one action at a time: skip now takes ~1s to settle, and a double-tap
  // would skip two songs. The ref guards same-frame double clicks that land
  // before the state re-renders.
  const [acting, setActing] = useState<string | null>(null)
  const actingRef = useRef<string | null>(null)

  const liveNow = state?.now ?? null
  const clock = useTicker(!!liveNow?.isPlaying)
  const elapsed = liveNow
    ? Math.min(liveNow.durationMs, liveNow.progressMs + (liveNow.isPlaying ? clock - liveNow.at : 0))
    : 0
  const remaining = liveNow ? liveNow.durationMs - elapsed : 0

  const act = async (path: string, method = 'POST', timeoutMs?: number) => {
    if (actingRef.current) return
    actingRef.current = path
    setActing(path)
    try {
      await api(path, { method, pin, ...(timeoutMs ? { timeoutMs } : {}) })
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      actingRef.current = null
      setActing(null)
      refresh()
    }
  }

  if (!state)
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    )

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <IconNote size={17} />
          <span className="brand-name">Admin</span>
        </div>
        <div className="head-right">
          <Status tone={offline ? 'offline' : state.now?.isPlaying ? 'live' : 'idle'} />
          <a className="link" href="/">
            Guest view
          </a>
        </div>
      </header>
      {offline && (
        <div className="banner" role="status">
          <IconWifiOff size={17} />
          <span className="banner-text">Can’t reach the server. Retrying…</span>
        </div>
      )}
      <div className="slot" aria-live="polite">
        {state.problem && <p className="error">Spotify problem: {state.problem}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      <section className="card">
        <div className="section-head">
          <h2>Now playing</h2>
          {liveNow && (
            <span className="meta">
              {fmt(elapsed)} / {fmt(liveNow.durationMs)}
            </span>
          )}
        </div>
        {liveNow ? (
          <div className="hero">
            {liveNow.image ? (
              <img className="art" src={liveNow.image} alt="" />
            ) : (
              <div className="art placeholder"><IconNote size={30} /></div>
            )}
            <div className="hero-meta">
              <div className="title">
                {liveNow.name}
                {liveNow.explicit && <span className="tag">E</span>}
              </div>
              <div className="subtitle">{liveNow.artists}</div>
              <div className="status-line">
                {liveNow.isPlaying ? `${fmt(remaining)} left` : 'Paused'}
              </div>
              <div
                key={liveNow.uri}
                className="progress"
                role="progressbar"
                aria-valuenow={Math.round((elapsed / liveNow.durationMs) * 100)}
              >
                <i style={{ width: `${Math.min(100, (elapsed / liveNow.durationMs) * 100)}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <p className="muted">Nothing playing.</p>
        )}
        <div className="grid">
          <button className="primary" onClick={() => setShowRequest(true)}>
            <IconPlus size={15} />
            Request a song
          </button>
          <button disabled={acting !== null} onClick={() => act('/admin/skip')}>
            <IconSkip size={15} />
            {acting === '/admin/skip' ? 'Skipping…' : 'Skip'}
          </button>
          <button
            disabled={acting !== null}
            onClick={() => act(state.paused ? '/admin/resume' : '/admin/pause')}
          >
            {state.paused ? <IconPlay size={15} /> : <IconPause size={15} />}
            {state.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div className="grid grid-secondary">
          <button
            className="ghost"
            disabled={acting !== null}
            onClick={() => act('/admin/warmup', 'POST', 30_000)}
          >
            {acting === '/admin/warmup' ? 'Warming up…' : 'Warm up'}
          </button>
          <button className="ghost" disabled={acting !== null} onClick={() => act('/admin/verbose')}>
            Logs: {state.verbose ?? 0}
          </button>
          <button className="ghost" disabled={acting !== null} onClick={() => act('/admin/explicit')}>
            Explicit: {state.explicitBlocked ? 'blocked' : 'allowed'}
          </button>
          <button
            className="ghost"
            disabled={acting !== null}
            onClick={() => confirm('Clear the whole queue?') && act('/admin/clear')}
          >
            Clear queue
          </button>
          <button className="ghost" disabled={acting !== null} onClick={refresh}>
            <IconRefresh size={14} />
            Refresh
          </button>
          <button className="ghost" onClick={onLogout}>
            Log out
          </button>
        </div>
      </section>

      <Devices pin={pin} />

      <section className="card">
        <div className="section-head">
          <h2>Queue</h2>
          <span className="meta">
            {state.queue.length + (state.externalQueue?.length ?? 0)} waiting
          </span>
        </div>
        {state.queue.length ? (
          <ol>
            {state.queue.map((t, i) => (
              <li key={t.id} className="row q-item">
                <span className="num">{i + 1}</span>
                <div className="grow">
                  <div className="q-name">
                    <strong>{t.name}</strong>
                  </div>
                  <div className="muted">{t.artists}</div>
                </div>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${t.name}`}
                  disabled={acting !== null}
                  onClick={() => act(`/admin/queue/${t.id}`, 'DELETE')}
                >
                  <IconClose size={15} />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Queue is empty.</p>
        )}
        {!!state.externalQueue?.length && (
          <div className="ext-queue">
            <div className="ext-head">Next in queue · Spotify app (Skip to remove)</div>
            <ol>
              {(state.externalQueue ?? []).map((t) => (
                <li key={t.uri} className="row q-item ext">
                  <div className="grow">
                    <div className="q-name">
                      <strong>{t.name}</strong>
                      {t.explicit && <span className="tag">E</span>}
                    </div>
                    <div className="muted">
                      {t.artists} · {fmt(t.durationMs)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>End of event</h2>
        </div>
        <p className="muted">
          Quit the Spotify app on the laptop, or stop this server entirely (the page goes offline
          until it is restarted on the laptop).
        </p>
        <div className="actions">
          <button
            className="gray"
            disabled={acting !== null}
            onClick={() => confirm('Quit Spotify on the laptop? The music stops.') && act('/admin/quit-app')}
          >
            <IconPower size={15} />
            Quit Spotify
          </button>
          <button
            className="danger"
            disabled={acting !== null}
            onClick={() =>
              confirm('Stop the jukebox server? Guests lose the page until you restart it.') &&
              act('/admin/shutdown')
            }
          >
            <IconStop size={15} />
            Stop server
          </button>
        </div>
      </section>

      <Stats state={state} />

      {showRequest && <RequestModal onClose={() => setShowRequest(false)} onQueued={refresh} />}
    </main>
  )
}
