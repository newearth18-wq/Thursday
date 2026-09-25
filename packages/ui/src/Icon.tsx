import type { ReactElement } from 'react'

/**
 * Jupiter's interface icons: simple original line drawings on a 24 px grid,
 * drawn with the current text colour. They are decorative — every control
 * that uses one also has a text label or an accessible name.
 */

const PATHS = {
  home: <path d="M4 11 12 4l8 7v9h-6v-6h-4v6H4z" />,
  chat: <path d="M4 5h16v11h-9l-5 4v-4H4z" />,
  missions: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" />
    </>
  ),
  skills: <path d="m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2z" />,
  memory: (
    <>
      <path d="m12 4 8 4-8 4-8-4z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </>
  ),
  files: (
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
  automations: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l3 2" />
      <path d="M9 3h6" />
    </>
  ),
  models: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="5" width="13" height="10" rx="1.5" />
      <path d="M7 19h5M9.5 15v4" />
      <rect x="17.5" y="9" width="4" height="10" rx="1" />
    </>
  ),
  plugins: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  diagnostics: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  sidebarCollapse: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 9l-3 3 3 3" />
    </>
  ),
  sidebarExpand: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M13 9l3 3-3 3" />
    </>
  ),
  online: (
    <>
      <path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0" />
      <circle cx="12" cy="19" r="0.8" />
    </>
  ),
  offline: (
    <>
      <path d="M3 9a13 13 0 0 1 5-3M11 5.1A13 13 0 0 1 21 9M6 12.5a8.5 8.5 0 0 1 3-1.9M9 16a4 4 0 0 1 6 0" />
      <circle cx="12" cy="19" r="0.8" />
      <path d="m4 4 16 16" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 3 3 5-6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 10v4.5M12 17v.5" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M7 14h10" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <ellipse cx="12" cy="12" rx="9.5" ry="3.5" transform="rotate(-18 12 12)" />
    </>
  ),
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  chevronDown: <path d="m6 9 6 6 6-6" />
} as const satisfies Record<string, ReactElement>

export type IconName = keyof typeof PATHS

export interface IconProps {
  readonly name: IconName
  readonly size?: number
}

export function Icon({ name, size = 20 }: IconProps) {
  return (
    <svg
      className="jp-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[]
