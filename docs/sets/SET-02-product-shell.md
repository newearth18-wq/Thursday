# SET 2 — Product shell, design system and accessible interface

- Status: **all 10 acceptance tests pass** locally on Linux, after a clean
  `npm ci` and `npm run verify` (13/13 steps), and in CI on Linux and Windows
  (commit `ea0a9b4`, run 36144417257). See §7 and §12.
- Checkpoint tag: `jupiter-set-02-product-shell` on `ea0a9b4`. It was created
  in the development environment, which can push branches only, so publishing
  it is left to the repository owner.
- SET 1 re-checked before SET 2 started: `1721a09` green in CI (run
  36136124624). The docs-only follow-up `bf3fe90` then failed CI on two SET 1
  tests that had passed on the same code before. Both were root-caused and
  fixed in this change (§9, "Fixed on the way").
- Environment of the recorded run: Node.js 22.22.2, npm 10.9.7, Electron 44.4.5
  (Chromium 152.0.7977.130, Node 24.21.0), Xvfb screen 4096×2304.

## 1. Scope completed

Following the Master Prompt's SET 2 work list:

**Screens (12).** Home / Command Center, Chat, Missions, Skills, Memory,
Files / Artifacts, Automations, AI Models, Devices, Plugins, Settings,
Diagnostics. Home, Settings and Diagnostics work. The other nine each show
what the feature will be, a _Coming later_ badge with the SET that builds it
(Chat and AI Models: SET 3; Missions: 4; Skills: 6; Files: 10; Memory: 11;
Devices: 12–13; Plugins: 15; Automations: 18), and no enabled control,
progress or motion.

**Components.** App shell with a compact sidebar; the native Windows title bar
(dark) with the current screen in the title; the Jupiter stage driven by
Core's real state (idle, attention, starting, connecting, unavailable); chat
composer shell (disabled, says why); current-Mission card shell (says no
Mission is running); status badges and the network and Core indicators;
timeline and recent activity from the event bus; permission-request and
identity-check dialog shells (the identity check says _Unavailable_ and offers
only Cancel); toasts and the Windows-notification bridge; empty, loading,
offline, unavailable, error and retry states; accessible dialog, menu, tabs,
radio group, switch and select; keyboard shortcuts; focus management.

**Design requirements.**

1. Design tokens for colour, surface, type (families, sizes, weights, line
   heights), spacing, radius, shadow, glow, motion (durations, easings),
   z-index and layout widths (`packages/ui/src/tokens.ts`, mirrored in
   `tokens.css`, tested equal).
2. The Design Lock v1 identity (Graphite Black, Midnight Blue and Deep Panel
   surfaces, Electric Cyan, Ice Blue and Violet accents, the Jupiter mark) is
   used on every screen.
3. Layout from 720×480 (the smallest window) to 4K, at 100% and 200% Windows
   scaling and 100–200% text size: `rem` units and container queries.
4. Thai and English from the start, switchable at any time without a restart.
   384 message keys in each language, and no copy inside components (enforced
   by a test).
5. Keyboard navigation (skip link, F6 regions, shortcuts, roving focus in
   tabs, menus and radio groups) and screen-reader labels (landmarks, named
   dialogs, `aria-current`, live status).
6. Reduce Motion (Follow Windows / On / Off), Static Avatar, Hide Avatar,
   compact mode, text size 100/125/150/175/200%, and a high-contrast theme
   (Windows forced colours are also respected).
7. No invented progress: numbers are shown only when both amounts are known;
   otherwise the indicator is indeterminate and says "in progress".
8. Persisted safely: window size, position, maximized state and last screen
   (host, `window-state.json`); theme, language, text size, compact mode,
   motion, avatar and notification preferences (Core settings in SQLite).

Not built (other SETs): chat, providers and models (SET 3), Missions (SET 4),
approvals (SET 7), the avatar engine (SET 16) and everything later.

## 2. Files added or changed

| Area               | Files                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts          | `packages/contracts/src/settings.ts` (7 preference settings), `capabilities.ts` (`host.notifications.status` / `.show`, per-key `settings.update`)                                                                                                                                          |
| Core               | `packages/core/src/kernel/core-kernel.ts` (settings validated on read; host capability allowlist), `kernel/capabilities.ts`                                                                                                                                                                 |
| Design system      | `packages/ui/src/{tokens.ts,tokens.css,tokens.test.ts,Icon.tsx,JupiterMark.tsx,index.ts}`                                                                                                                                                                                                   |
| Host               | `apps/desktop/src/main/{window-state.ts,window-state.test.ts,window.ts,index.ts,host-capabilities.ts,host-capabilities.test.ts}`, `src/shared/views.ts`                                                                                                                                     |
| Renderer — shell   | `App.tsx`, `main.tsx`, `router.ts`, `preferences.tsx`, `destinations.ts`, `errorText.ts`, `useShortcuts.ts`, `useNetworkStatus.ts`, `useRuntime.ts`, `styles.css`, `i18n/{I18nProvider.tsx,index.ts,en.ts,th.ts}`                                                                           |
| Renderer — parts   | `components/{ActivityTimeline,AppMenu,ChatComposer,Dialog,FormControls,InfoDialogs,JupiterStage,Menu,MissionCard,Progress,SecurityDialogs,StateMessage,Tabs,Timeline,Toasts,TopBar,Sidebar,RecoveryNotice}.tsx`                                                                             |
| Renderer — screens | `views/{HomeView,SettingsView,DiagnosticsView,FeatureViews,ViewHeader,LoadFailure}.tsx`                                                                                                                                                                                                     |
| Tests              | `apps/desktop/test/shell.integration.test.ts` (new, SET 2 E2E), `components/components.test.tsx`, `src/checks/renderer-copy.test.ts`, `i18n/i18n.test.ts`, contracts and tokens tests; `app`, `core-gateway` and `packaged` integration tests updated for the new shell (addresses, labels) |
| SET 1 test fixes   | `packages/database/test/support/{crash-writer.ts,helpers.ts}`, `vitest.config.ts` (poll window)                                                                                                                                                                                             |
| Tooling            | `scripts/with-display.mjs` and CI: Xvfb screen 4096×2304; `apps/desktop/tsconfig.node.json`                                                                                                                                                                                                 |
| Docs               | ADR `0003`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `AGENTS.md`, this report, `docs/sets/set-02/*.png`                                                                                                                                                                          |

## 3. Architecture decisions

Recorded in [ADR 0003](../decisions/0003-product-shell-preferences-and-window-state.md)
and described in [ARCHITECTURE.md](../ARCHITECTURE.md#product-shell-set-2):

- **The current screen lives in the address** (`jupiter://app/index.html#/view`).
  A reload keeps it. The host remembers the last one and opens the window
  there.
- **Window state belongs to the host** (`window-state.json`): validated,
  written atomically, and fitted to the displays that exist at start.
- **Preferences are Core settings.** They are validated on write and on read,
  audited, and published as events. They apply at once. When the database is
  down they are kept for the session, shown as not saved, and saved when it is
  back.
- **Native dark title bar**, not a frameless window.
- **Windows notifications are a dispatcher capability** (validated, audited,
  rate-limited).
- **Tokens and catalogues**: nothing visual or textual is hard-coded in
  components.

The renderer gained no IPC channel and no bridge function.

## 4. Database migrations

None. The seven preferences use the existing `settings` table (migration 1).
The schema stays at version 2.

## 5. Security implications

- No new IPC surface. Preferences and notifications are capabilities behind
  the existing `request` channel, so they are validated, authorized per actor,
  and audited on every call.
- Stored preferences are validated when read. A value this version does not
  accept is ignored with a warning, and it is not rewritten or deleted.
- A Windows notification's title (120 chars) and body (400 chars) are bounded.
  The host shows at most six a minute. Clicking one only focuses Jupiter.
- `window-state.json` contains only window bounds and the last screen name. It
  is validated on read and written atomically with owner-only permissions.
- The Content Security Policy is unchanged. Fonts are bundled, nothing is
  loaded remotely, and `connect-src` is still `'none'`.
- Controls table: [SECURITY.md](../../SECURITY.md).

## 6. Commands actually run

Baseline before SET 2: `1721a09` (SET 1) green in CI, run 36136124624; the
working tree was clean.

```bash
# final, from a clean tree (node_modules, out/, dist/, test-results/ deleted)
npm ci                                                    # added 529 packages, 0 vulnerabilities
npm audit                                                 # found 0 vulnerabilities
npm run verify                                            # 13/13 steps PASS
cd legacy/thursday-browser && npm ci && npm run build && xvfb-run -a npm run test:acceptance
# the SET 2 E2E suite on a 1024×768 screen, to exercise the emulation fallback
xvfb-run -a -s "-screen 0 1024x768x24" npx vitest run --project integration apps/desktop/test/shell.integration.test.ts   # 18/18
# the fixed SET 1 crash test, repeated
for i in 1..12: vitest run packages/database/test/crash.integration.test.ts        # 12/12
8 parallel × 2 rounds of the same, under load                                       # 16/16
```

## 7. Automated test results

| Suite                                      | Result                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Unit (Vitest, 21 files)                    | **185 passed**, 0 failed                                                                 |
| Integration (13 files)                     | **74 passed**, 0 failed, 3 skipped (the packaged-app tests, run in their own step below) |
| — of which SET 2 E2E (`shell.integration`) | **18 passed**: AT1–AT7, AT10, 6 layout cases (AT8), 4 offline/failure cases (AT9)        |
| Packaged-app launch (Linux unpacked build) | **3 passed**, 0 failed                                                                   |
| Development-mode smoke                     | **5/5 checks** passed                                                                    |
| Secret scan (sources + build output)       | **295 files**, 0 findings                                                                |
| Windows package validation                 | **6/6 checks** passed (unpacked build; 22 entries in `app.asar`; no credentials)         |
| Linux package validation                   | **5/5 checks** passed                                                                    |
| Legacy Thursday acceptance                 | **24/24 + 8/8** passed (unchanged code, own lockfile)                                    |

New in SET 2: 18 real-Electron E2E tests; unit tests for window state (10),
host notifications (3 new), components (8: dialog, menu, tabs, progress,
Mission card, permission and identity shells), design tokens (5), the
copy scanner (3), catalogue coverage of every runtime-built key, and preference
settings in the contracts.

Layout cases in the final run (`test-results/set-02/layout-cases.json`): all six
used a real window (1366×768 at 100%, text 200% and 200% scaling; 720×480 at
200%; 3840×2160 physical at 200% and at 100%).

### CI evidence (commit `ea0a9b4`, run 36144417257)

| Job                                                                                                                                                                                                                                                                                                                                              | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Linux — format, lint, typecheck, unit, build, integration + E2E (Xvfb 4096×2304), secret scan, dev smoke, Windows and Linux package validation, packaged launch                                                                                                                                                                                  | success |
| Windows — unit 185/185; integration 73 passed + 4 skipped (the 3 packaged tests, run in their own step, and one POSIX-only permission test), including **all 18 SET 2 E2E tests on Windows** and the SET 1 E2E suite; NSIS installer `Jupiter-Setup-0.1.0-alpha.0-x64.exe` (106.5 MB) built and validated 7/7; packaged `Jupiter.exe` launch 3/3 | success |
| Legacy Thursday — build and 24 + 8 acceptance checks                                                                                                                                                                                                                                                                                             | success |

The Windows job's `layout-cases.json` records, for each layout case, whether a
real window or viewport emulation was used there. It is uploaded with the
`jupiter-windows-installer` artifact.

## 8. Manual tests

The built app was checked visually under Xvfb at 1366×768 after each round of
changes. The screenshots below are from the final code:

| Screenshot                                                                   | What it shows                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Command Center](set-02/home-en.png)                                         | Stage idle (Core running, all services healthy), composer disabled with reason, empty Mission card |
| [Chat](set-02/chat-coming-later-en.png)                                      | An unfinished screen: _Coming later_ · SET 3, disabled composer                                    |
| [Settings › Accessibility](set-02/settings-accessibility-en.png)             | Reduce Motion, avatar, compact mode                                                                |
| [Keyboard shortcuts](set-02/shortcuts-dialog-en.png)                         | Modal dialog opened from the Jupiter menu                                                          |
| [Compact mode](set-02/compact-en.png)                                        | Sidebar collapsed to icons (Ctrl+B)                                                                |
| [Offline](set-02/offline-en.png)                                             | Network indicator _Offline_; nothing else changes because nothing needs the network yet            |
| [Core stopped](set-02/core-stopped-en.png)                                   | Core killed: stage _Jupiter Core is not running_, Core indicator, warning toast                    |
| [Thai, database failed](set-02/home-th-database-failed.png)                  | Database service FAILED with its real error and Retry                                              |
| [Thai, preference not saved](set-02/settings-th-not-saved-text150.png)       | Text size 150% applied at once and truthfully marked _not saved_ while the database is unavailable |
| [Thai Home](set-02/thai-home.png), [Thai Settings](set-02/thai-settings.png) | Thai throughout, marks unclipped                                                                   |
| [Text 200%](set-02/layout-1366x768-text200-home.png)                         | 1366×768 with 200% text                                                                            |
| [200% scaling](set-02/layout-1366x768-dpr2-settings.png)                     | 1366×768 at device pixel ratio 2                                                                   |
| [Smallest window](set-02/layout-720x480-dpr2-home.png)                       | 720×480 at 200% scaling                                                                            |
| [4K at 200%](set-02/layout-4k-dpr2-home.png)                                 | 3840×2160 physical pixels                                                                          |

Found and fixed through visual review:

- The disabled _Send_ button kept its cyan fill at half opacity and still
  looked ready. Disabled buttons now have no fill, a dashed border and muted
  text (in Windows contrast themes, `GrayText`). AT10 asserts this.
- "Not saved" was shown in the success colour. It is now a warning, and the
  AT9 E2E test asserts it.
- Sidebar badges overlapped labels; they are replaced by one _Coming later_
  group heading.
- Icons did not follow the text size, and radio buttons and inputs did not
  inherit the font size.
- An empty status line left a gap in Settings.

## 9. Known limitations

- Error _messages_ inside an `ErrorEnvelope` come from Core in English. Service
  and load-failure notices show a translated summary for each known error code
  next to the original message, which keeps the real details. Other places
  (for example the Settings notice) show the original message inside
  translated text.
- Only Home, Settings and Diagnostics work. The nine other screens are shells
  labelled _Coming later_ by design.
- The Jupiter stage animation is a restrained breathing and sway of the mark,
  and it runs only while Jupiter is idle or needs attention. The avatar engine
  with thinking and working states is SET 16.
- Windows notifications are verified by unit tests of the host capability
  (validation, rate limit, unsupported system), not end to end: a test cannot
  observe a notification shown by the operating system.
- On a display too small for a real window of the tested size (e.g. a CI
  runner's default screen), the layout test uses Chromium's viewport emulation
  at the same size and records that it did (`layout-cases.json`). On the
  4096×2304 Xvfb screen every case uses a real window.

**Fixed on the way (SET 1 tests that failed intermittently in CI on
`bf3fe90`):**

- _Database crash test, Linux._ The writer announced "migrating" before it had
  opened the database, and the test killed it 300 ms later. On a slower
  machine the kill could land while the file was still being created, before
  WAL mode was on. That left a hot rollback journal, which the test's
  **read-only** integrity check cannot recover (`SQLITE_READONLY_ROLLBACK`).
  The writer now applies migrations 1–2 first and signals right before
  migration 3, and the check opens the file read-write as Jupiter does.
  Verified 12/12 sequentially and 16/16 under parallel load.
- _Core crash policy test, Windows._ After Retry, the audit record of the
  retry is written durably (`synchronous=FULL`), behind Core's own start-up
  writes. On the Windows runner that took longer than Vitest's default
  1-second `expect.poll` window. The integration project now polls for up to
  15 s (100 ms interval).

## 10. How to run

```bash
npm ci
npm run dev                  # development
npm run build && npm start   # production build, unpackaged
npm run verify               # all gates
```

Things to try: switch _Settings › General › Language_ and watch the whole
interface change without a restart; Ctrl+1…9 to move between screens, F6 to
move between regions, F1 for the shortcuts; _Settings › Accessibility › Reduce
motion: On_ stops every animation; _Settings › Appearance › Text size 200%_;
end the Jupiter Core process in Task Manager and watch Home report it and
recover.

## 11. Evidence and artifact paths

- `test-results/set-02/*.png` and `layout-cases.json` (written by the E2E
  suite; uploaded by CI as `jupiter-linux-evidence`)
- `docs/sets/set-02/*.png`
- `test-results/package-validation-win.json`, `test-results/package-validation-linux.json`

## 12. Acceptance tests

### SET 2

| #   | Test                                           | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every navigation destination renders           | **PASS** | E2E AT1: all 12 destinations opened from the sidebar and by address: heading present, no error boundary, `aria-current="page"`, correct address, window title names the screen, no page errors and no `renderer.error` log entries                                                                                                                                                                            |
| 2   | Refresh preserves the selected view            | **PASS** | E2E AT2: reload on Skills stays on Skills; an unknown address opens Home; after a restart the window reopens on the last screen (Memory) with its size and position within 4 px                                                                                                                                                                                                                               |
| 3   | Thai and English switch without restart        | **PASS** | E2E AT3: English → Thai → English → Thai in Settings; `lang`, navigation, window title and stage status change at once; host and Core process ids unchanged; stored as `ui.language = th`, and a new session opens in Thai                                                                                                                                                                                    |
| 4   | Thai text renders without clipped marks        | **PASS** | E2E AT4: Noto Sans Thai 400 and 600 loaded; every visible Thai text on all 12 screens and all 5 Settings tabs measured — ink height within the line box and no clipping ancestor; [screenshots](set-02/thai-home.png)                                                                                                                                                                                         |
| 5   | Keyboard-only navigation reaches every control | **PASS** | E2E AT5: on each of the 12 screens, every visible enabled control is reached with Tab alone; arrow keys move through tabs; skip link, Ctrl+3, Ctrl+, Ctrl+Shift+D and F6 work. Unit tests: menu (arrows, Home/End, Escape), tabs (roving tab stop)                                                                                                                                                            |
| 6   | Modal focus is trapped and restored            | **PASS** | E2E AT6: shortcuts dialog opened by keyboard from the Jupiter menu; 20 Tab / Shift+Tab presses stay inside; shortcuts behind it are ignored; Escape closes it and focus returns to the menu button; same for the reset confirmation in Settings. Unit test of the dialog (labelled, described, wrap-around, restore)                                                                                          |
| 7   | Reduce Motion disables nonessential motion     | **PASS** | E2E AT7: the idle stage animates; with Reduce Motion _On_ nothing on the page animates and transitions are `0s`; _Follow Windows_ follows the system setting live; Static Avatar stops the stage's motion; Hide Avatar removes the mark and keeps the status text                                                                                                                                             |
| 8   | Usable at 1366×768 and 200% scaling            | **PASS** | E2E AT8, 6 cases × 12 screens in real windows: 1366×768 at 100%, with 200% text, and at 200% scaling; 720×480 at 200%; 4K at 200% and 100% — no horizontal overflow, nothing past the edge, top bar fits, menu visible, no overlap, every navigation link reachable; [screenshots](set-02/layout-1366x768-dpr2-settings.png)                                                                                  |
| 9   | Offline and service-failure states truthful    | **PASS** | E2E AT9: the network indicator follows Chromium's offline state and nothing else changes; a killed Core is shown at once (indicator, stage, warning toast) and recovery only once Core really runs; with the database down Settings gives the real reason, applies a change for the session, shows _not saved_ as a warning, and saves it after Retry; an invalid stored preference falls back to the default |
| 10  | No unfinished screen implies it works          | **PASS** | E2E AT10: the 9 unfinished screens are marked `COMING_LATER` with the _Coming later_ badge and have 0 enabled controls, 0 progress indicators and 0 animations, and only the allowed labels; the chat composer is disabled, says why, and its Send button has no accent fill; the Mission card says none is running and has no buttons; unit and copy-scan tests                                              |

### SET 0 and SET 1 re-check (on the SET 2 code)

| Check                                             | Status   | Evidence                                                                                     |
| ------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| SET 0: clean install, dev launch, build, packages | **PASS** | `npm ci` (0 vulnerabilities), dev smoke 5/5, build, Windows 6/6 and Linux 5/5 package checks |
| SET 0: lint, strict typecheck, no secrets         | **PASS** | 0 errors, 0 warnings; secret scan 295 files, 0 findings                                      |
| SET 0: renderer has no Node.js                    | **PASS** | `app.integration.test.ts` (updated for the new shell) passes                                 |
| SET 1: all 10 acceptance tests                    | **PASS** | `core-gateway.integration.test.ts` (8 E2E) and the 25 database integration tests pass        |
| SET 1: the two tests that failed intermittently   | **PASS** | root-caused and fixed (§9); 12/12 sequential and 16/16 parallel runs of the crash test       |
