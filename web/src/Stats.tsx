import { useState } from 'react'
import { fmt, fmtUptime, useTicker } from './api'
import { IconChevronDown, IconChevronRight } from './icons'
import type { State } from './api'

const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// Collapsed by default; ticking only while open so it costs nothing otherwise.
export default function Stats({ state }: { state: State }) {
  const [open, setOpen] = useState(false)
  const clock = useTicker(open, 1000)
  const played = state.session?.played ?? []
  const startedAt = state.session?.startedAt ?? clock
  const musicMs = state.session?.playedMs ?? 0

  return (
    <section className="card">
      <button className="stats-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>Session</span>
        {open ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
      </button>
      {open && (
        <>
          <div className="stats-facts">
            <div className="stat">
              <b>{fmtUptime(clock - startedAt)}</b>
              <span>running</span>
            </div>
            <div className="stat">
              <b>{played.length}</b>
              <span>songs played</span>
            </div>
            <div className="stat">
              <b>{fmt(musicMs)}</b>
              <span>music time</span>
            </div>
          </div>
          {played.length ? (
            <ol>
              {[...played].reverse().map((p) => (
                <li key={`${p.uri}-${p.at}`} className="row q-item">
                  <span className="played-at">{clockTime(p.at)}</span>
                  <div className="grow">
                    <div className="q-name">
                      <strong>{p.name}</strong>
                    </div>
                    <div className="muted">
                      {p.artists} · {fmt(p.durationMs)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Nothing played yet this session.</p>
          )}
        </>
      )}
    </section>
  )
}
