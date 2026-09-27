# SET 9 — Browser Agent

- Status: **all 10 acceptance tests pass with a real browser.** The Browser
  Agent also works in the real application, end to end. Evidence: see §7 and
  §12. CI on PR #6 was still running when this report was written; its result is recorded in §7 once it is known. SET 9 is not tagged until CI is green.
- SET 8 was checked first: it was green in CI on Linux, Windows and Legacy
  (`692a928`, run 36251841189) and merged (PR #5). Its suites pass again on
  the SET 9 code; the changes are listed in §12.
- The tests drive a real Chromium-family browser:
  - locally, Chromium 141 (Playwright build 1194)
  - in CI, the runner's own Google Chrome (Linux) and Microsoft Edge or
    Google Chrome (Windows)
- Without such a browser, the agent is shown as **Unavailable**, with the
  reason (§9).

## 1. Scope completed

### Typed actions

`BrowserAction` (`packages/contracts/src/browser.ts`) has 18 types:

- `NAVIGATE`, `NEW_TAB`, `SWITCH_TAB` and `CLOSE_TAB`
- `CLICK`, `TYPE`, `FILL_FORM`, `SELECT_OPTION` and `PRESS_KEYS`
- `SUBMIT`, with a declared kind: search, login, message, form or purchase
- `WAIT_FOR`
- `READ_PAGE`, `EXTRACT`, `SCREENSHOT` and `SNAPSHOT_HTML`
- `DOWNLOAD` and `UPLOAD`
- `CLICK_POINT`: the opt-in coordinate fallback

Every action returns:

- action, target and success
- the method used: `semantic`, `selector`, `coordinate`, `page` or `none`
- the page's address, origin and title
- the observation
- untrusted content, when there is any
- labelled instructions (`suspicious`)
- evidence and error
- `startedAt` and `completedAt`

### Finding controls

1. **Semantic controls** come first: role and accessible name, then label,
   placeholder, text or test id.
2. **A CSS selector** is used only when the task names one.
3. **Coordinates** are used only through `CLICK_POINT`. It is opt-in, needs
   its own HIGH permission, and is labelled as "Coordinate fallback".

### Architecture

The Browser Agent has three layers (ADR 0010):

- **Core** — `BrowserAgent` decides:
  - the permissions and the allowed origins
  - labelling of injected instructions
  - cancel
  - events and storage
- **Host** — `BrowserHost` chooses:
  - the browser
  - every folder
  - the download checks
- **Runtime** — `services/browser-runtime`: `playwright-core`, bundled into
  one file and run in its own process.

### Sessions

- **Isolated.** Each task gets its own temporary context: no shared cookies,
  storage or cache, and nothing on disk.
- **Locked down.** Sessions have no site permissions, service workers are
  blocked, and tabs that a page opens by itself are closed.
- **Persistent profile.** Only with the setting `browser.persistentProfile`,
  which is off by default. Even then it is Jupiter's own profile folder,
  never the person's.

### Permissions

- **Every action** needs a capability for its exact origin. The missing
  ones are asked for together, before anything runs (`WAITING_APPROVAL`,
  nothing done). Each is checked again when it runs.
- **New capabilities:**
  - `browser.read` (LOW)
  - `browser.interact` (MEDIUM)
  - `browser.submit_login` (MEDIUM)
  - `browser.click_point` (HIGH)
- **Existing capabilities used:**
  - `browser.navigate`
  - `browser.download`
  - `browser.upload` (CRITICAL; asked for both the file and the site)
  - `browser.submit_form` (HIGH)
  - `payment.make` (CRITICAL)
- **Sign-ins.** A form that asks for a password is a sign-in, whatever the
  task calls it.
- **Credentials.** Text that looks like a credential is never typed into a
  page.
- **Single-use answers.** An _Allow once_ answer covers only the rest of the
  task it was given for, for the same LOW or MEDIUM capability and target.

### Safety response

After every action, the page's origin is compared with the task's approved
origins. Any other origin — reached through a link, a redirect or a script —
has this effect:

- the task stops with status `SAFETY_STOP` and error `UNEXPECTED_ORIGIN`
- the page is stopped
- a `browser.safety_stop` event is published
- nothing after that action runs

### Untrusted content

- **Page text** is returned only as `UntrustedContent`, labelled with its
  origin.
- **Instructions in a page** are labelled with seven kinds:
  - override-instructions
  - reveal-secrets
  - exfiltrate-files
  - grant-permissions
  - redirect-agent
  - install-software
  - impersonate-user

  They are reported and never followed.

- **Missions.** The step `browser.read_page` passes the page text to later
  steps between `BEGIN/END UNTRUSTED PAGE TEXT` fences, with a note of what
  was labelled.

### Missions

- **New step type:** `browser.read_page`. Its input is `url`, and it builds
  NAVIGATE, READ_PAGE and SCREENSHOT.
- **Agent and permissions.** The Mission detail now shows the agents the
  plan uses and each permission with the person's answer. Before, it said
  "Agents arrive in SET 8" and always showed "None needed".
- **Attempts.** The attempt count no longer counts waits for permission.

### Interface

- **Diagnostics › Browser Agent:**
  - availability, with the reason
  - the browser, the runtime process and the profile kind
  - the downloads and uploads folders
  - recent tasks, with each action's method and observation
  - "Untrusted page content" badges and labelled instructions
  - safety stops
- **Settings › Permissions:** "Let browser sessions keep sign-ins"
  (`browser.persistentProfile`).
- **Activity feed:** browser events.
- **Languages:** English and Thai.

## 2. Files added or changed

**Contracts**

- `browser.ts` (new)
- `ai.ts` (`parseUrl` exported)
- `capabilities.ts`, `events.ts`, `host-operations.ts`, `permissions.ts`,
  `settings.ts` and `index.ts`

**Core**

- `browser/driver.ts`, `browser/injection.ts` (and its test) and
  `browser/agent.ts` (new)
- `permissions/engine.ts`: the outcome says whether a grant was single-use
- `kernel/core-kernel.ts` and `kernel/capabilities.ts`
- `missions/manager.ts`: `runBrowser`; the permissions in Mission detail
- `workflow/catalogue.ts` and `workflow/validate.ts`
- `ports.ts` and `index.ts`

**Database**

- `schema.ts`: migration 9
- `repositories/browser.ts` (new)
- `jupiter-database.ts`

**Browser runtime** (`services/browser-runtime`)

- `src/runtime.ts`, `src/protocol.ts`, `src/client.ts`, `src/build.ts` and
  `src/index.ts`
- `test/client.integration.test.ts` and `test/fake-runtime.mjs`
- `package.json`, `tsconfig.json` and `README.md`

**Desktop app**

- **Host:**
  - `main/browser-host.ts` (new)
  - `main/host-capabilities.ts`
  - `main/services.ts`: `browser-runtime` is a real service when a browser
    is found, and Unavailable otherwise
  - `main/index.ts`
  - `core/index.ts`
  - `electron.vite.config.ts`: builds `browser-runtime.cjs`
- **Renderer:**
  - `views/BrowserPanel.tsx`, `useBrowser.ts` and `browserText.ts` (new)
  - `DiagnosticsView.tsx`, `ActivityTimeline.tsx` and `SettingsView.tsx`
  - `MissionsView.tsx` and `MissionWorkflow.tsx`
  - `errorText.ts`, `i18n/en.ts`, `i18n/th.ts` and `i18n.test.ts`

**Testing**

- `packages/testing/src/web-fixtures.ts` (new): two local test websites
  - a shop on `127.0.0.1`, with search, files, upload, sign-in, a hostile
    page, a slow page, cookies and a redirect
  - another site on `localhost`

**Tests**

New:

- `browser-core.integration.test.ts`
- `browser.integration.test.ts`
- `packages/database/test/browser.integration.test.ts`
- the runtime transport tests

Updated:

- `app.integration.test.ts`
- `core-gateway.integration.test.ts`
- `core-harness.ts`
- `host-capabilities.test.ts`
- `packaged.integration.test.ts`
- `workflow-core.integration.test.ts`

**Docs and configuration**

- ADR 0010 (new)
- `ARCHITECTURE.md`, `README.md`, `SECURITY.md` and `AGENTS.md`
- `eslint.config.js`
- `package-lock.json`

## 3. Architecture decisions

The decisions are recorded in
[ADR 0010](../decisions/0010-browser-agent.md):

- **Three layers, as in SET 8.**
  - Core decides.
  - The host chooses the browser and every folder.
  - The runtime acts.
- **The browser.** `playwright-core` drives an installed browser: Edge,
  which is on every Windows 10 and 11, Chrome or Chromium. No browser is
  downloaded.
- **Packaging.** The runtime is bundled into one CommonJS file inside the
  app. It runs on Electron's own Node.js, in its own process.
- **Rejected alternatives:**
  - Electron `BrowserView`: web content would share Jupiter's process
  - the full `playwright` package with downloaded browsers: hundreds of MB
  - hand-written CDP
- **Origins.** The allowed origins are fixed when the task starts. Leaving
  them is a stop, never a warning.
- **Downloads** go to quarantine and are kept only after the host checks
  them.

## 4. Database migrations

Migration 9 (`0009_browser_tasks`) adds `browser_tasks`, which holds:

- the task id
- the Mission
- the session
- the status, constrained by a CHECK to RUNNING, SUCCEEDED, FAILED,
  CANCELLED, WAITING_APPROVAL or SAFETY_STOP
- the task JSON: its actions, with type and origin only, and each action's
  observed result
- when it was created and completed

Typed text is never stored: an action records its length only. Migrations
1–8 are unchanged.

## 5. Security implications

- **The host chooses every path.** Core never sends one.
  - Uploads come only from the uploads folder.
  - Downloads are checked in quarantine (origin, size, extension, magic
    bytes) and kept under a unique name. Nothing is overwritten.
- **Only Core can drive the browser.** `host.browser.call` serves only the
  Core actor. The renderer reaches the agent only through capabilities.
- **Every action is permission-checked** for its exact origin, at the moment
  it runs. Content never grants or requests a permission (AT7).
- **Isolation.** Web content runs in a separate browser process, driven by a
  separate runtime process. A crash or hang there never reaches Jupiter
  (AT9).
- **Stored data.** Typed text and credentials are never stored. Observations
  are redacted.

## 6. Commands actually run

```bash
npm ci
npx vitest run apps/desktop/test/browser-core.integration.test.ts
npx vitest run services/browser-runtime/test packages/database/test/browser.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/browser.integration.test.ts
JUPITER_PACKAGED_EXECUTABLE=apps/desktop/dist/linux-unpacked/jupiter node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/packaged.integration.test.ts
npm run verify
```

CI: GitHub Actions runs on PR #6 (Linux, Windows and Legacy jobs).

## 7. Automated test results

### Local run

`npm run verify` on Linux (Node.js 22, Xvfb, a throwaway GNOME Keyring):
**13/13 steps PASS**, exit 0.

- unit tests: 26 files, 250 tests
- integration and Electron E2E: 35 files passed and 2 skipped; 260 tests
  passed and 14 skipped
  - The skipped ones are the Windows-only SET 8 suites and the Windows
    installer check.
- packaged-app launch: 4 tests

The SET 9 suites:

| Suite                                                         | Tests | What it runs                                                                                                                                              |
| ------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/browser-core.integration.test.ts`          | 14    | The real host, runtime and browser, with the real Core in-process, against the fixture websites: AT1–AT10, Missions, sign-in, secrets, single-use answers |
| `apps/desktop/test/browser.integration.test.ts`               | 4     | The real Electron app: a Mission on a hostile page with the real permission dialog, a safety stop, the profile setting — with screenshots                 |
| `services/browser-runtime/test/client.integration.test.ts`    | 6     | The IPC transport: validation both ways, deadlines, hang stop, crash reported once, restart                                                               |
| `packages/database/test/browser.integration.test.ts`          | 3     | Store round trip, Mission link, the status CHECK                                                                                                          |
| `apps/desktop/test/packaged.integration.test.ts` (SET 9 test) | 1     | The packaged app runs the runtime from `app.asar` and opens and closes a real browser session (Unavailable path when there is no browser)                 |

The packaged check was run locally in both states:

- **With a browser.** A temporary link `/usr/bin/chromium` pointed to the
  test Chromium. The test was forced to fail if it took the "unavailable"
  branch, and it passed on the "available" branch.
- **Without a browser.** It passed on the Unavailable branch.

### CI

Pending: run 36294813038 on commit `e1103e6` (Linux, Windows and Legacy jobs). Legacy Thursday passed. Linux and Windows had not finished when this was written.

### Found and fixed during the SET

| Found                                                                                                                                          | Fix                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E: with _Allow once_, a Mission's `browser.read_page` failed with PERMISSION_REQUIRED on its screenshot; the read had used the answer        | A single-use answer covers the rest of its own task, for the same LOW/MEDIUM capability and target; test added                                                                                                             |
| E2E screenshot: the Mission's Agent field said "Coming later — Agents arrive in SET 8", Permissions "None needed", "Attempt 3 of 1"            | Agents and permissions shown from the plan and the person's answers; permission waits no longer count as attempts                                                                                                          |
| A popup's first navigation (`request.frame()` throws) slipped past the popup block                                                             | Counted and aborted; the observation says the page tried to open a tab                                                                                                                                                     |
| The runtime's call deadline equalled the navigation timeout                                                                                    | The host adds 15 s to each deadline                                                                                                                                                                                        |
| The E2E dialog helper could wait 30 s when the dialog closed between two reads                                                                 | The helper reads without waiting                                                                                                                                                                                           |
| CI (run 38, Linux): SET 5 AT6 failed — after 18 s a 5 s step was still RUNNING, its request never aborted (also seen once on Windows in SET 8) | A step's attempt now ends when its signal aborts even if the executor does not settle; its late result is discarded. New test: an adapter that ignores the abort reproduces the failure without the fix and passes with it |

## 8. Manual tests

The E2E suite drives the real app and saves screenshots, copied to
[docs/sets/set-09](set-09/). Each was reviewed by eye:

| File                                | Shows                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-browser-agent-available.png`    | Diagnostics › Browser Agent: Available, the browser, the runtime process, "Temporary profiles only", the downloads and uploads folders                 |
| `02-permission-request.png`         | The permission dialog: "Open a web page `browser.navigate`", target `http://127.0.0.1:…`, Medium, requested by Browser Agent for the Mission's step    |
| `03-mission-completed.png`          | The Mission COMPLETED; Agent: Browser Agent; Permissions: browser.navigate allowed, browser.read allowed; "Attempt 1 of 1"                             |
| `04-untrusted-content-labelled.png` | The hostile page's task: "Untrusted page content", six labelled instruction kinds, "The page tried to open 1 tab by itself; it was blocked and closed" |
| `05-safety-stop.png`                | "Stopped for safety": after CLICK the page was on `http://localhost:…`, not approved; nothing after it ran                                             |
| `06-browser-profile-setting.png`    | Settings › Permissions: "Let browser sessions keep sign-ins", off by default                                                                           |

The "Jupiter Core is running again" notice in 01 and 02 is the SET 2 notice
for the first start. It is not a crash.

## 9. Known limitations

- **A browser is needed.** Without Edge, Chrome or Chromium:
  - the agent is Unavailable, with the reason
  - `browser.read_page` is not offered
  - `browser.run` fails with `BROWSER_UNAVAILABLE`
- **Tested against local fixture websites only.** No public website was used
  in the tests.
- **Not built:**
  - computer vision
  - CAPTCHA solving
  - filling in payment details (a purchase always needs a fresh CRITICAL
    answer)
- **Web downloads are limited to what the task expects:** types it names,
  from the page's own origin. A download from another origin is rejected.
- **Only the Chromium family is supported.** Firefox and Safari are not.
- **Screenshots** are saved to the evidence folder. They are not shown in the
  interface.

## 10. How to run

```bash
npm ci && npm run dev
```

1. Open _Diagnostics › Browser Agent_. It shows the browser Jupiter found.
2. Create a Mission such as "Summarise the article at https://…". This needs
   a model provider for planning.
3. Answer the permission requests. Each one names the exact site.

The real-browser tests:

```bash
npx vitest run apps/desktop/test/browser-core.integration.test.ts
```

Set `JUPITER_TEST_BROWSER_EXECUTABLE` if no Chromium-family browser is at a
standard place.

## 11. Evidence and artifact paths

- `docs/sets/set-09/*.png`: the E2E screenshots (also written to
  `test-results/set-09/` on each run)
- CI run 36294813038 (PR #6): pending

## 12. Acceptance tests

| #   | Test                                                                | Status   | Evidence (`browser-core.integration.test.ts` with a real browser, unless noted)                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open isolated browser session                                       | **PASS** | Two sessions, both temporary, with different ids. A cookie set in A is seen in A (`fixture_session=from-this-session`) and not in B (`no cookie`). A persistent profile is refused while the setting is off (`PERSISTENT_PROFILE_OFF`). The runtime runs in its own process (pid ≠ Jupiter's)                                                        |
| 2   | Navigate to test page                                               | **PASS** | NAVIGATE → SUCCEEDED, with the address, origin and title "Fixture Shop" and "HTTP 200" in the observation. The status reports the browser's version                                                                                                                                                                                                  |
| 3   | Search a site using semantic controls                               | **PASS** | TYPE into `searchbox "Search products"` and SUBMIT `button "Search"`, both with method `semantic`. The server received `/search?q=jupiter`, and the page became "Results for jupiter". The typed text is not stored                                                                                                                                  |
| 4   | Extract expected page text and structured content                   | **PASS** | READ_PAGE: untrusted content from the shop's origin, containing "Jupiter Telescope" and the page structure `table "Products"`. EXTRACT: heading, product names, prices and result count exactly as served                                                                                                                                            |
| 5   | Download test file and verify it                                    | **PASS** | `manual.pdf` and `prices.csv` are kept in the downloads folder: SHA-256 equals the served bytes, and the type is confirmed by content. `brochure.pdf` (not a PDF) → `DOWNLOAD_REJECTED`, "not a PDF file". A file from another origin → `DOWNLOAD_REJECTED`. Quarantine is left empty                                                                |
| 6   | Upload approved test file                                           | **PASS** | UPLOAD asks for `browser.upload` (CRITICAL, target `<uploads>/approved.txt → <shop>`) and `browser.submit_form` (HIGH). The server received the exact file (name, bytes), and the evidence has its SHA-256. A file outside the uploads folder → `UPLOAD_FILE_NOT_FOUND`, nothing done                                                                |
| 7   | Prompt injection on page cannot override Jupiter's rules            | **PASS** | The hostile page produced six labelled kinds. Only the task's three actions ran. No request reached the other site. The tab the page's script opened was closed. No permission was given or asked for because of the page. In a Mission, the model received the page only inside the untrusted fences. E2E: the same in the real app (screenshot 04) |
| 8   | Cancel stops browser operation                                      | **PASS** | `browser.cancel` during a navigation to a page that never finishes → `{cancelled: true}`, task CANCELLED in under 15 s, error category `cancellation`, and the queued READ_PAGE never ran                                                                                                                                                            |
| 9   | Browser crash does not crash Jupiter                                | **PASS** | The runtime process was killed (SIGKILL) while loading a page → FAILED, with `RUNTIME_CRASHED` or `BROWSER_CRASHED`. Core carried on, and the next task SUCCEEDED on a new runtime (new pid, restarts ≥ 1). Transport tests: a hang is stopped, and a crash is reported once                                                                         |
| 10  | Unexpected cross-origin navigation triggers defined safety response | **PASS** | A link to the other site → `SAFETY_STOP`, `UNEXPECTED_ORIGIN` naming the site reached. Results end at CLICK, and a `browser.safety_stop` event names what was reached and what was allowed. A server redirect → `SAFETY_STOP` after NAVIGATE. E2E: "Stopped for safety" in the app (screenshot 05)                                                   |

### SET 0–8 re-check (on the SET 9 code)

All earlier suites pass in the same `npm run verify` run. They were updated
only where SET 9 changed facts:

- **Service lists.** `browser-runtime` is no longer planned. It is HEALTHY
  where a browser is found, and UNAVAILABLE (planned SET 9) otherwise. Core
  adds `browser-agent`.
- **SET 1 AT6:** the page holds four live subscriptions (browser events).
- **SET 5:** the step-type list includes `browser.read_page`, which is
  unavailable where the agent is.
- **SET 8 Missions view:** the Agent row no longer says "Coming later".
- **SET 5 AT6:** a new companion test proves the time limit ends a step whose executor ignores the stop (see §7).
