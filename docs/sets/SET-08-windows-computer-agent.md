# SET 8 — Windows Computer Agent

- Status: **all 10 acceptance tests pass on a real Windows desktop**, and the
  required demonstration passes in the real application. Evidence: CI on
  Linux, Windows and Legacy (`61a2bd9`, run 36250056233). See §7 and §12.
  Tagged `jupiter-set-08-windows-computer-agent`.
- SET 7 was checked first: green in CI on Linux and Windows (`f6ec992`,
  run 36231978700) and tagged `jupiter-set-07-permission-and-security-engine`.
  Its suites pass again on the SET 8 code; the changes are listed in §12.
- The real-desktop tests run on the CI Windows runner:
  - Microsoft Windows Server 2025 Datacenter 10.0.26100
  - classic Notepad 10.0.26100.32860
  - PowerShell 5.1 with .NET UI Automation
- Elsewhere, the agent is shown as **Unavailable**, with the reason; see §9.
- SET 8 was first merged in PR #4, before the Windows job was green. The
  fixes that made it green are in PR #5 (§7).

## 1. Scope completed

### Typed actions

`ComputerAction` (`packages/contracts/src/computer.ts`) has 15 types:

- `OPEN_APP` and `CLOSE_APP`
- `FOCUS_WINDOW` and `MANAGE_WINDOW` (minimize, maximize, restore, move,
  resize)
- `LIST_WINDOWS`, which also reports the active window
- `WAIT_FOR_WINDOW`
- `READ_UI_TREE`
- `CLICK_ELEMENT`, `TYPE_TEXT`, `PRESS_KEYS`, `SCROLL` and `SELECT_ELEMENT`
- `SCREENSHOT` (a window or the screen)
- `SAVE_FILE`
- `CLICK_POINT`: the coordinate fallback

Every action returns:

- action, target and success
- the method used: `system`, `semantic`, `keyboard` or `coordinate`
- the observation
- evidence (a screenshot file, or the saved file), when there is any
- error, `startedAt` and `completedAt`

### Priority order

1. **UI Automation.** Controls are found by automation id, name, control type
   and class.
2. **Application adapters.** There are three:
   - Generic Windows
   - Notepad: finds its editor by role; saves through Ctrl+S and the Save As
     dialog
   - File Explorer: opens the save folder
3. **Semantic controls:**
   - Value, Invoke, Toggle, ExpandCollapse, Scroll and SelectionItem
     patterns
   - for classic Win32 controls without patterns: the control's own messages
     (`WM_GETTEXT`, `WM_SETTEXT`, `BM_CLICK`) and Win32 focus
4. **Computer vision:** not built (§9).
5. **Coordinates:** only `CLICK_POINT`, which is opt-in, has its own
   permission, is limited to its window, labelled and audited.

### Architecture

- **Runtime.** A dedicated process (`services/agent-runtime`): PowerShell 5.1
  with UI Automation.
  - It speaks a narrow JSON-lines RPC.
  - Messages are validated with zod on both sides.
  - Every call has a deadline.
- **Host.** `computer-host.ts` alone chooses:
  - the executables
  - the save folder (the Desktop)
  - the evidence folder
- **Core.** `ComputerAgent` decides:
  - the order of actions
  - permissions
  - verification
  - cancellation
  - re-resolution of stale windows
  - events and storage

See ADR 0009.

### Permissions

- **Before a task runs:** every requirement is checked with an exact target.
  The missing ones are asked for together, and the task waits
  (`WAITING_APPROVAL`) with nothing done.
- **Each action** is checked again when it runs.
- **New capabilities:** `computer.click` and `computer.click_point` (both
  HIGH).
- **Requester:** `agent/computer`.

### Missions

- The step type is `computer.notepad_write`, with inputs text and fileName.
- The step builds four actions: `OPEN_APP`, `TYPE_TEXT` (editor), `SAVE_FILE`
  and `CLOSE_APP`.
- It waits for permissions like a Skill step.
- The step type is offered only where the agent is available.

### Interface

- **Diagnostics › Computer Agent:**
  - availability, with the reason
  - the runtime process and its restarts
  - the screen and the save folder
  - recent tasks, with each action's method and observation
- **Activity feed:** computer events.
- **Languages:** English and Thai.

## 2. Files added or changed

**Contracts**

- `computer.ts` (new): actions, results, tasks, status, and the automation
  RPC (`AutomationOps`)
- `capabilities.ts`: `computer.status`, `computer.run`, `computer.cancel` and
  `computer.tasks`
- `events.ts`: `computer.task_started`, `computer.action_completed` and
  `computer.task_finished`
- `host-operations.ts`: `host.computer.call`
- `permissions.ts`: `computer.click`, `computer.click_point`, and the subject
  kind `agent`
- `index.ts`

**Core**

- `computer/driver.ts`, `computer/adapters.ts` and `computer/agent.ts` (new)
- `kernel/core-kernel.ts`: the `computer-agent` service and
  `refreshComputerAvailability`
- `kernel/capabilities.ts`
- `missions/manager.ts`: `runComputer`
- `workflow/catalogue.ts` and `workflow/validate.ts`
- `ports.ts` and `index.ts`

**Database**

- `schema.ts`: migration 8
- `repositories/computer.ts` (new)
- `jupiter-database.ts`

**Agent runtime** (`services/agent-runtime`)

- `src/uia-runtime.ps1`
- `src/client.ts`, `src/protocol.ts`, `src/index.ts` and `src/raw.d.ts`
- `test/client.integration.test.ts` and `test/fake-runtime.mjs`
- `package.json`, `tsconfig.json` and `README.md`

**Desktop app**

- **Host:**
  - `main/computer-host.ts` (new)
  - `main/host-capabilities.ts` and its test
  - `main/services.ts`: `agent-runtime` is a real service on Windows and
    Unavailable elsewhere
  - `main/index.ts`
  - `core/index.ts`
- **Renderer:**
  - `views/ComputerPanel.tsx`, `useComputer.ts` and `computerText.ts` (new)
  - `DiagnosticsView.tsx`, `ActivityTimeline.tsx` and `SecurityDialogs.tsx`:
    `data-request-id`
  - `errorText.ts`, `i18n/en.ts`, `i18n/th.ts`, `i18n.test.ts` and
    `styles.css`

**Tests**

New:

- `computer-core.integration.test.ts`
- `computer-windows.integration.test.ts`
- `computer.integration.test.ts`
- `fake-desktop.ts`: a labelled test double of the host
- `windows-display.ts`: the display-mode helper for AT8

Updated:

- `app.integration.test.ts`
- `core-gateway.integration.test.ts`
- `core-harness.ts`
- `shell.integration.test.ts`
- `workflow-core.integration.test.ts`

**Docs and configuration**

- ADR 0009 (new)
- `ARCHITECTURE.md`, `README.md`, `SECURITY.md` and `AGENTS.md`
- `eslint.config.js` and `vitest.config.ts`

## 3. Architecture decisions

The decisions are recorded in
[ADR 0009](../decisions/0009-windows-computer-agent.md):

- **Three layers.**
  - Core decides.
  - The host chooses targets.
  - The runtime acts.
- **No native addon.** The runtime is PowerShell 5.1 and the .NET UI
  Automation client, which ship with every Windows 10 and 11. Its script is
  bundled with Jupiter and sent over standard input, so nothing is written
  to disk.
- **Semantic first, always verified:**
  - typing is checked by reading the text back
  - saving is checked by reading the file on the host
  - window operations are checked by reading the window state back
  - an effect that is not there is a failure
- **Windows are listed from the window manager** (`EnumWindows`), not from
  UI Automation, so a window that UI Automation misses for a moment is not
  reported as closed.
- **Classic Win32 controls.** When UI Automation reports a classic Win32
  control without patterns, as on the Windows Server 2025 runner, the
  runtime uses the control's own messages. This is still the control's own
  content, never a screen position.
- **Cancel** stops at the next boundary. A runtime call is not split.

## 4. Database migrations

Migration 8 (`0008_computer_tasks`) adds `computer_tasks`, which holds:

- the task id
- the Mission
- the status (RUNNING, SUCCEEDED, FAILED, CANCELLED, WAITING_APPROVAL)
- the task JSON: its actions and each action's result
- when it was created and completed

Typed text is never stored: a `TYPE_TEXT` action is recorded with its length
only. A task that a Core stop cut off is marked failed at the next start.
Migrations 1–7 are unchanged.

## 5. Security implications

- **The host chooses every target.** No path, executable or command comes
  from a request.
  - The executables are System32 `notepad.exe` and `explorer.exe`.
  - A file name is a plain `.txt` name inside the save folder the host chose.
  - An existing file is never overwritten (`FILE_EXISTS`).
- **Only Core can drive the computer.** `host.computer.call` serves only the
  Core actor. The renderer reaches the agent only through capabilities.
- **Every action is permission-checked** with its exact target, at the
  moment it runs.
  - The coordinate fallback needs its own HIGH permission, and every use is
    audited.
- **Stored data.** Typed text is not stored or logged. Observations and
  errors are redacted before storage.
- **Crashes are contained.** A crash or hang of the runtime affects only the
  runtime: it is stopped, reported as `RUNTIME_CRASHED` or `RUNTIME_TIMEOUT`,
  and restarted on the next call.

## 6. Commands actually run

```bash
npm ci
npm run format:check && npm run lint && npm run typecheck
npx vitest run apps/desktop/test/computer-core.integration.test.ts services/agent-runtime apps/desktop/src/main
npm run verify
```

CI: GitHub Actions runs on PR #4 and PR #5, the Linux and Windows jobs.

## 7. Automated test results

### CI evidence (commit `61a2bd9`, run 36250056233)

| Job                                                                                                                   | Result  |
| --------------------------------------------------------------------------------------------------------------------- | ------- |
| Windows — unit, integration and E2E (incl. the real-desktop SET 8 suites), NSIS installer, package validation, launch | success |
| Linux — format, lint, typecheck, unit, build, integration + E2E, secret scan, dev smoke, packages                     | success |
| Legacy Thursday — build and acceptance checks                                                                         | success |

On Windows: 32 test files passed and 1 was skipped; 242 tests passed and 5
were skipped. The skipped ones are the Linux-only "Unavailable" checks.

The SET 8 suites in that run:

| Suite                                                    | Where         | Tests | What it runs                                                                                                |
| -------------------------------------------------------- | ------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/computer-windows.integration.test.ts` | Windows       | 10    | The real host, runtime, Notepad, File Explorer and files, with the real Core in-process: AT1–AT10, and more |
| `apps/desktop/test/computer.integration.test.ts`         | Windows/Linux | 1 + 1 | The real Electron app. Windows: the required demonstration. Linux: shown as Unavailable                     |
| `apps/desktop/test/computer-core.integration.test.ts`    | all           | 12    | The agent's logic with a labelled test double of the host (faults on demand), and Mission integration       |
| `services/agent-runtime/test/client.integration.test.ts` | all           | 6     | The RPC transport: validation, deadlines, hang stop, crash report, restart                                  |

What the Windows run did:

- The required demonstration ran as a Mission, in 32.7 s.
- On the real desktop:
  - AT1–AT4 in 10.1 s
  - AT8 in 19.5 s: the resolution was changed to 640×480, and the window
    moved to 10,10 and resized to 520×400

### Fixed during the SET (from the Windows runs)

The Windows runner showed what could not be known in advance:

| Run | Found                                                                                                                           | Fix                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 24  | The editor query `controlType=Document` did not match; the E2E waited for the dialog to hide between requests; no display modes | Editor found by role; the E2E waits for the next request id; display modes read in C#               |
| 26  | A diagnostic printed Notepad's UI tree: its editor was a Win32 `Edit` (id 15) reported as a bare `Pane`                         | Editor candidates include the Win32 `Edit` by class; windows listed with `EnumWindows`              |
| 28  | UI Automation could not focus that Pane; an unhandled EPIPE after the crash test                                                | Win32 focus fallback; the runtime client handles errors on its input stream                         |
| 29  | Typing verified, but the Save button (`Button` id 1) was also a bare Pane                                                       | Button found by class and clicked with `BM_CLICK`                                                   |
| 30  | The file was checked before Notepad had written it; after a UI Automation move, Notepad's window was no longer visible          | Wait for Notepad's title to name the file; move and resize with `SetWindowPos`; invisible = failure |
| 31  | Notepad titles the file without its extension ("hello - Notepad")                                                               | Title matched with or without the extension; the test double does the same                          |
| 32  | —                                                                                                                               | All green                                                                                           |

Two tests from earlier SETs were also adjusted:

- **SET 2 AT3.** On Windows, the stage still said _Starting_ while the agent
  runtime was being checked. The test now waits for the real _Idle_ state.
- **SET 5 AT6.** It failed once on Windows (run 25) and passed in every run
  after. It now reports the Mission's steps, attempts and model requests if
  it fails again.

### Local run

`npm run verify` on Linux (Node.js 22.22.2, npm 10.9.7, Xvfb, a throwaway
GNOME Keyring): **13/13 steps PASS**, exit 0:

- formatting, lint, strict typecheck
- unit tests: 25 files, 247 tests
- production build
- integration and Electron E2E: 31 files passed and 2 skipped; 233 tests
  passed and 14 skipped. The skipped ones are the Windows-only SET 8 suites
  and the Windows installer check. Notepad cannot run on Linux, so these
  suites are skipped there, never faked.
- secret scan: 405 files, no credentials
- development-mode launch
- Windows and Linux unpacked builds, and their package validation
- packaged-app launch

## 8. Manual tests

The E2E suite takes screenshots as it drives the real app.

**Linux.** The run writes `test-results/set-08/01-unavailable-here.png`,
copied to [docs/sets/set-08](set-08/01-unavailable-here.png). It shows the
Computer Agent card saying **Unavailable** and "needs Windows".

**Windows.** The run writes these screenshots:

- `02-permission-request.png`: the first permission request, naming the
  exact target
- `03-mission-completed.png`: the completed Mission
- `04-computer-agent-diagnostics.png`: the task, with each action's method
  and observation

They are in the CI artifact `jupiter-windows-installer` of run 36250056233,
under `test-results/set-08/`. The proxy of the environment that wrote this
report blocks downloads from GitHub's artifact storage. So these screenshots
were **not** copied into the repository, and they were **not** reviewed by
eye here. What they show is asserted by the test itself (status COMPLETED,
the file on disk equals `Hello Jupiter`, the task results).

## 9. Known limitations

- **Windows only.** On other systems:
  - the agent is Unavailable, with the reason
  - the Notepad step is not offered
  - `computer.run` fails with `COMPUTER_UNAVAILABLE`
- **Tested on one Windows.** The real-desktop tests ran only on Windows
  Server 2025 with classic Notepad.
  - The current Microsoft Store Notepad (`RichEditD2DPT`) is in the adapter,
    but no CI runner has it, so it is **untested**.
  - Windows 10 and 11 desktops are untested.
- **Capabilities in the SET 8 list that are not built:**
  - drag and drop
  - copy and paste as an action of its own
  - computer vision (priority 4)
- **Applications.** Only Notepad and File Explorer have adapters. The Generic
  adapter covers windows and controls of other applications, but no other
  application has been tested.
- **Screenshots** are saved to the evidence folder. They are not shown in the
  interface.
- **Interrupting an action.** Cancel stops at the next boundary. An action in
  progress (one UI Automation call) finishes first; the longest single call
  is bounded by its deadline.

## 10. How to run

On Windows:

```bash
npm ci && npm run dev
```

1. Open _Diagnostics › Computer Agent_. It shows the agent as available, the
   runtime, the screen and the Desktop as the save folder.
2. Create a Mission: "Open Notepad, type Hello Jupiter, save it to Desktop"
   (needs a model provider for planning).
3. Answer the permission requests. Each one names the exact target.

The real-desktop tests:

```bash
npx vitest run apps/desktop/test/computer-windows.integration.test.ts
```

## 11. Evidence and artifact paths

- **CI run 36250056233** (commit `61a2bd9`):
  - Windows job 108426278373 log: the SET 8 suites, the Notepad diagnostic
    and the demonstration
  - artifact `jupiter-windows-installer`: `test-results/set-08/*.png`
- `docs/sets/set-08/01-unavailable-here.png` (Linux)

## 12. Acceptance tests

| #   | Test                                                         | Status   | Evidence (Windows CI run 36250056233 unless noted)                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Launch real Notepad                                          | **PASS** | `OPEN_APP` starts System32 `notepad.exe`. It succeeds only when a new Notepad window appears (handle, process). The diagnostic test recorded the process, `C:\Windows\System32` and version 10.0.26100.32860                                                 |
| 2   | Type actual text                                             | **PASS** | `TYPE_TEXT` into the editor (a Win32 `Edit`, found by class), method `keyboard`; succeeds only when reading the control back equals the text ("reading Pane #15 back confirms the text is there")                                                            |
| 3   | Save an actual file                                          | **PASS** | `SAVE_FILE`: Ctrl+S → the Save As dialog of Notepad's process → the path into the file name box (id 1001) → Save (id 1) → the dialog closes → Notepad's title names the file                                                                                 |
| 4   | Verify file existence and content                            | **PASS** | The host reads the file back (BOM and line endings normalised, SHA-256). The test reads it again from disk and it equals `Hello Jupiter`. The result carries `evidence: {kind: 'file', path}`. Demonstration: the Mission is COMPLETED only after this check |
| 5   | Missing UI element returns structured failure                | **PASS** | `CLICK_ELEMENT` on `automationId=jupiter-no-such-control` → task FAILED, `ELEMENT_NOT_FOUND`, and the following `TYPE_TEXT` did not run                                                                                                                      |
| 6   | Cancel interrupts the agent                                  | **PASS** | `computer.cancel` during a 60 s `WAIT_FOR_WINDOW` → `{cancelled: true}`, task CANCELLED well within 30 s, and the queued `TYPE_TEXT` never ran                                                                                                               |
| 7   | Incorrect action cannot be reported as success               | **PASS** | Typing into the title bar → FAILED. A save whose file content differs from the expected text → `SAVE_FILE` failed with `SAVE_NOT_VERIFIED`, although the file exists. (Linux, test double: a text box that ignores input → `ACTION_NOT_VERIFIED`)            |
| 8   | Screen-resolution change does not break semantic interaction | **PASS** | The display was changed for real to 640×480 (`ChangeDisplaySettings` → 0). The window moved to 10,10 and resized to 520×400, each read back. Then typing, save and file verification all succeeded. The resolution was restored afterwards                   |
| 9   | Automation runtime crash does not crash Jupiter              | **PASS** | The runtime process was killed during a task → FAILED `RUNTIME_CRASHED`. Core carried on, and the next task SUCCEEDED on a new runtime (new pid, restarts ≥ 1). No unhandled error (the EPIPE of run 28 is fixed)                                            |
| 10  | Coordinate fallback is labelled, constrained, audited        | **PASS** | Without opt-in → `COORDINATE_FALLBACK_DISABLED`. Opted in, outside the window → `POINT_OUTSIDE_WINDOW`, method `coordinate`. Inside → success, method `coordinate`, observation "Coordinate fallback…". The audit trail has `computer.click_point` ALLOWED   |

### The required demonstration (real app, Windows)

The test _"the required demonstration: permission, real Notepad, exact text,
semantic save to the approved path, verified file"_ passed in 32.7 s:

1. A person creates the Mission in the interface: "Open Notepad, type Hello
   Jupiter, save it to Desktop".
2. The person answers each permission request in the real dialog. The
   `files.write` request names the exact path.
3. The Mission reaches COMPLETED.
4. The file on disk equals `Hello Jupiter`.
5. The task's results are `OPEN_APP` (system), `TYPE_TEXT` (not coordinate),
   `SAVE_FILE` (semantic, with the file as evidence) and `CLOSE_APP`
   (semantic).

In the test environment, "Desktop" is a temporary folder
(`JUPITER_TEST_COMPUTER_FOLDER`), so that CI does not write to the runner's
real Desktop.

### SET 0–7 re-check (on the SET 8 code)

All earlier suites pass in the same CI run. They were updated only where
SET 8 changed facts:

- **Service lists** include `computer-agent` (Core) and `agent-runtime`
  (host). The latter is HEALTHY on Windows and UNAVAILABLE elsewhere.
- **SET 1 AT6:** the page holds three live subscriptions.
- **SET 1 AT9:** it waits for the settled HEALTHY state.
- **SET 5:** the step-type list includes `computer.notepad_write`, which is
  unavailable where the agent is.
- **SET 2 AT3 and SET 5 AT6:** see §7.
