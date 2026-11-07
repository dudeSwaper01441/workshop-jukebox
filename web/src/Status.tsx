export type StatusTone = 'live' | 'paused' | 'starting' | 'idle' | 'offline'

const LABEL: Record<StatusTone, string> = {
  live: 'Live',
  paused: 'Paused',
  starting: 'Starting',
  idle: 'Idle',
  offline: 'Offline',
}

// One quiet status indicator shared by guest, admin and display, so the same
// state never renders three different ways.
export default function Status({ tone }: { tone: StatusTone }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {LABEL[tone]}
    </span>
  )
}
