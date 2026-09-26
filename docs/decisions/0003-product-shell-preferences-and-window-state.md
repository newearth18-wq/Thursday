# ADR 0003 — Product shell: address-based navigation, host-owned window state, preferences in Core

- Status: accepted (SET 2)
- Date: 2026-09-25

## Context

SET 2 asks for the production shell: twelve destinations, a design system
built from the Jupiter Visual Design Lock v1, Thai and English from the start,
keyboard and screen-reader access, Reduce Motion, Static and Hidden Avatar,
compact mode, text scaling, a Windows-appropriate title bar, a toast and
Windows-notification bridge, and persistence of window size and position, the
current screen, theme, language and accessibility preferences. It must work
from 1366×768 to 4K and at 100–200% Windows scaling, and nothing on an
unfinished screen may look like it works.

## Decisions

### 1. The current screen lives in the address (`#/view`)

Each destination has an address, `jupiter://app/index.html#/<view>`. The
renderer reads it on start and on `hashchange`; an unknown address opens Home.

- A reload keeps the screen for free, because the address is kept.
- The host watches `did-navigate-in-page` and remembers the last view in the
  window-state file. On the next start it opens the window at that address, so
  the screen is restored before any renderer code runs.
- Alternatives considered: React state with `localStorage` (lost on a profile
  reset, invisible to the host, and the renderer's storage is not where
  Jupiter keeps durable state); a router library (a dependency for twelve flat
  routes, and history-API routing needs the protocol handler to serve every
  path).

### 2. Window size and position are kept by the host, not Core

`window-state.json` in the data folder holds `{ v: 1, bounds, maximized,
lastView }`. It is validated on read (an invalid or unreadable file is logged,
ignored, and replaced by the next save), written atomically (temporary file + rename,
mode 0600) after a short debounce and on quit.

- The saved bounds are fitted to the displays that exist now: a window on a
  monitor that has been unplugged, or whose title bar would be off-screen,
  opens centred on the primary display instead; a window larger than its
  display is shrunk to fit.
- It is host state because it is needed before Core starts (the window is
  created first) and because it is about this machine's displays, not user
  data.

### 3. Preferences are Core settings

Language, theme, text size, compact mode, Reduce Motion, avatar mode and
desktop notifications are settings (`ui.*`, `notifications.desktop`) in
Core's `settings` table, through the existing `settings.list` and
`settings.update` capabilities: typed in `SettingDefinitions`, validated on
write by the dispatcher, audited, published as `settings.changed` events.

- **Validated on read, too.** A stored value that this version does not
  accept (for example from a newer build) is ignored with a
  `settings.value.invalid` warning and the default is used. It is never
  rewritten or deleted.
- **Applied at once, saved truthfully.** The interface applies a change
  immediately (no restart), then saves it. If the database is unavailable,
  the change stays in effect for the session, Settings says it is _not
  saved_ and why, and it is saved automatically once the database is back.
- Alternatives considered: renderer `localStorage` (not validated, not
  audited, lost with the profile's web storage, and outside the database's
  backups); a separate preferences file in the host (a second persistence
  path next to SQLite).

### 4. A native title bar, dark

The window keeps the standard Windows title bar (snap layouts, the system
menu, keyboard and screen-reader behaviour all come with it) and asks for the
dark variant (`nativeTheme.themeSource = 'dark'`). The window title names the
current screen (`Settings — Jupiter`), which is what the taskbar, Alt+Tab and
screen readers announce.

- Alternative considered: a frameless window with custom caption buttons and
  the Windows Controls Overlay. It re-implements what Windows already does
  accessibly, and a drag region can hide controls from assistive
  technologies. It can be revisited with the avatar work (SET 16) if the
  visual lock needs it.

### 5. One notification path: toasts in the window, Windows notifications through the dispatcher

The interface raises toasts for real events only (a Core crash, its
recovery, a backup that finished or failed). When the window is not focused
and the person allows it, the same message is sent as a Windows
notification. That is a host capability (`host.notifications.show`,
provider `host`), so it goes through Core's dispatcher like every other
privileged action: validated (title ≤ 120 characters, body ≤ 400), audited,
and rate-limited by the host (six a minute). `host.notifications.status`
reports whether the system supports notifications; when it does not,
Settings says so and the test-notification button is disabled. Clicking a notification only brings the
Jupiter window forward.

### 6. The design system is tokens, and copy is never in components

- Every colour, surface, font, size, weight, line height, spacing, radius,
  shadow, glow, motion duration and easing, z-index and layout width is a
  token in `packages/ui/src/tokens.ts`. `tokens.css` holds the same values as
  CSS custom properties, and a unit test fails if the two differ. Sizes are in `rem`, so the text-size
  preference (100–200%) scales the whole interface, and responsive layout uses
  container queries in `rem` too.
- Thai is set in Noto Sans Thai with line heights of 1.4–1.6, which leave room
  for the marks above and below the line; nothing that holds text clips it
  vertically. The E2E test measures the ink of every Thai text on every
  screen against its line box and its clipping ancestors.
- All interface text comes from the English and Thai catalogues. A unit test
  parses every renderer component and fails on literal text in JSX or in
  user-visible attributes.

## Consequences

- Twelve destinations exist. Only Home, Settings and Diagnostics work. The
  other nine are labelled _Coming later_ with the SET that builds them, and
  have no enabled controls, progress or motion; tests enforce this.
- The renderer gained no new IPC channel or bridge function. Preferences and
  notifications are capabilities behind the existing `request` channel.
- The window-state file is the only new file Jupiter writes. It holds no user
  content and nothing sensitive.
