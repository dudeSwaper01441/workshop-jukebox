import { useEffect, useRef, useState } from 'react'
import { api, fmt } from './api'
import { IconClose, IconNote, IconPlus } from './icons'
import type { Track } from './api'

const SEARCH_DELAY = 250

// Same search + request flow as the guest page, in a popup so the host
// doesn't have to leave /admin. Requests go through the normal /api/request
// path, so cooldown / pending / duplicate / explicit rules still apply.
export default function RequestModal({ onClose, onQueued }: { onClose: () => void; onQueued: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const searchCtl = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // parent re-renders on every poll; keep setup/teardown to mount/unmount only
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    inputRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const runSearch = async (term: string) => {
    searchCtl.current?.abort()
    const ctl = new AbortController()
    searchCtl.current = ctl
    setSearching(true)
    try {
      const r = await api<Track[]>(`/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
      if (!ctl.signal.aborted) setResults(r)
    } catch (e) {
      if (ctl.signal.aborted) return
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      if (searchCtl.current === ctl) setSearching(false)
    }
  }

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      if (timer.current) clearTimeout(timer.current)
      searchCtl.current?.abort()
      setResults([])
      setSearching(false)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => runSearch(term), SEARCH_DELAY)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const searchNow = () => {
    const term = q.trim()
    if (term.length < 2) return
    if (timer.current) clearTimeout(timer.current)
    void runSearch(term)
  }

  const request = async (t: Track) => {
    setBusy(t.uri)
    setMsg(null)
    try {
      await api('/request', { method: 'POST', body: { uri: t.uri } })
      setMsg({ ok: true, text: `Added “${t.name}” to the queue!` })
      onQueued()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy('')
    }
  }

  const showResults = q.trim().length >= 2

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Request a song" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h2>Request a song</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="search-wrap">
          <input
            ref={inputRef}
            type="search"
            value={q}
            placeholder="Search for a song or artist"
            aria-label="Search for a song or artist"
            onChange={(e) => {
              setQ(e.target.value)
              setMsg(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') searchNow()
            }}
          />
          {q && (
            <button
              className="clear-btn"
              aria-label="Clear search"
              onClick={() => {
                setQ('')
                setResults([])
                setMsg(null)
              }}
            >
              <IconClose size={15} />
            </button>
          )}
        </div>
        <div className="slot" aria-live="polite">
          {msg && <div className={msg.ok ? 'toast toast-ok' : 'toast toast-err'}>{msg.text}</div>}
        </div>
        {showResults && searching && results.length === 0 && <p className="muted">Searching…</p>}
        {showResults && !searching && results.length === 0 && (
          <p className="muted">No matches. Try another song or artist.</p>
        )}
        <ul>
          {results.map((t) => (
            <li key={t.uri} className="row track">
              {t.image ? (
                <img className="art sm" src={t.image} alt="" loading="lazy" />
              ) : (
                <div className="art sm placeholder"><IconNote size={20} /></div>
              )}
              <div className="grow">
                <div className="track-name">
                  <strong>{t.name}</strong>
                  {t.explicit && <span className="tag">E</span>}
                </div>
                <div className="muted">
                  {t.artists} · {fmt(t.durationMs)}
                </div>
              </div>
              <button
                className="add"
                disabled={busy === t.uri}
                aria-label={`Request ${t.name}`}
                onClick={() => request(t)}
              >
                <IconPlus size={14} />
                {busy === t.uri ? 'Adding…' : 'Request'}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
