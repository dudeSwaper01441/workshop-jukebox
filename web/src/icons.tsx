import type { ReactNode } from 'react'

// Inline vector icons for interface chrome. Emoji rendered differently on each
// device and read as decoration; these inherit colour and size from the text.
function Svg({
  size = 20,
  children,
}: {
  size?: number
  children: ReactNode
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconNote({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M9 17.5V5.2l10-2v12.3" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </Svg>
  )
}

export function IconPlay({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M8 5.2 19 12 8 18.8z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconPause({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="8" y="5" width="3" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="3" height="14" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconSkip({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 5.5 15 12 6 18.5z" fill="currentColor" stroke="none" />
      <rect x="16.5" y="5" width="2.2" height="14" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconStop({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconPower({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3.5v8" />
      <path d="M7.6 6.6a8 8 0 1 0 8.8 0" />
    </Svg>
  )
}

export function IconPlus({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  )
}

export function IconClose({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  )
}

export function IconRefresh({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4.5V9h-4.5" />
    </Svg>
  )
}

export function IconExpand({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" />
    </Svg>
  )
}

export function IconMic({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </Svg>
  )
}

export function IconColumns({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M12 4.5v15" />
    </Svg>
  )
}

export function IconClock({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Svg>
  )
}

export function IconSpark({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" />
      <path d="M6 6l2.6 2.6M15.4 15.4L18 18M18 6l-2.6 2.6M8.6 15.4L6 18" opacity="0.5" />
    </Svg>
  )
}

export function IconPulse({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="12" cy="12" r="6.5" opacity="0.6" />
      <circle cx="12" cy="12" r="10" opacity="0.3" />
    </Svg>
  )
}

export function IconFont({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 17h4l-2-9h2l2 9h4l-2-9h2l-2.5 9H3z" />
      <path d="M8 10h8" strokeLinecap="square" />
    </Svg>
  )
}

export function IconWifiOff({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3.5 3.5l17 17" />
      <path d="M8.5 15.2a5 5 0 0 1 7 0" />
      <path d="M5 11.6a9.5 9.5 0 0 1 3.7-2.1M15.6 9.4a9.5 9.5 0 0 1 3.4 2.2" />
      <circle cx="12" cy="18.7" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconChevronDown({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 9.5l6 6 6-6" />
    </Svg>
  )
}

export function IconChevronRight({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M9.5 6l6 6-6 6" />
    </Svg>
  )
}
