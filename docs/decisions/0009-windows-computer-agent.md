# ADR 0009 — Windows Computer Agent: decisions in Core, targets chosen by the host, UI Automation in its own process

- Status: accepted (SET 8)
- Date: 2026-09-26

## Context

SET 8 asks for a real Windows Computer Agent that works with applications
and returns observations that can be checked. It must prefer, in order:

1. UI Automation and accessibility
2. application adapters
3. semantic controls
4. computer vision
5. coordinates, only as a controlled fallback

**Typed actions.** The agent needs typed actions, and each returns what was
observed:

- `OPEN_APP` and `CLOSE_APP`
- `FOCUS_WINDOW` and `WAIT_FOR_WINDOW`
- `CLICK_ELEMENT`, `TYPE_TEXT` and `PRESS_KEYS`
- `READ_UI_TREE` and `SCREENSHOT`
- `SAVE_FILE`

**The runtime.** Automation must run in its own runtime behind a narrow
RPC. Cancel must interrupt queued actions. Stale windows and elements must
be found again. A crash of the runtime must not crash Jupiter.

**The demonstration.** Open Notepad, type "Hello Jupiter" and save it to the
Desktop. Success counts only when the saved file is checked.

Jupiter is developed on Linux and CI has a Windows runner. The Permission
Engine (SET 7) exists.

## Decisions

### 1. Three layers, each doing one job

| Layer                                                                | Decides                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core** — `ComputerAgent` (`packages/core/src/computer/`)           | What to do, in which order, which permissions it needs, and whether each action really had its effect. Owns the task, cancellation, re-resolution of windows, events, and storage (migration 8).        |
| **Host** — `ComputerHost` (`apps/desktop/src/main/computer-host.ts`) | What may be acted on: which executables (Notepad, File Explorer), which folder files are saved to (the Desktop), where screenshots go. Reads saved files back. Serves only Core (`host.computer.call`). |
| **Agent runtime** — `services/agent-runtime`                         | Nothing. A PowerShell process with Windows UI Automation (UIAutomationClient). It does what one validated request says, then answers.                                                                   |

**Core.** Core never sees a path or an executable it could choose itself.

**The host.** The host never takes a path or a command from a request. A
file name is a plain `.txt` name, checked against the folder the host chose.

**The runtime.** The runtime keeps no state: every call finds its window by
handle and its control by query again.

**Alternatives considered.**

- A native Node addon for UI Automation. This means a compiled dependency,
  which breaks the "no node_modules in the package" rule.
- WinAppDriver or FlaUI as an external service. This is a large extra
  install.

PowerShell 5.1 and the .NET UI Automation client come with every
Windows 10 and 11. The runtime's code is carried inside Jupiter's bundle and
sent over standard input, so nothing is written to disk.

### 2. A narrow RPC, validated in both directions

**Messages.** Each message is one line, the Base64 of a UTF-8 JSON object,
so console encodings cannot change the text. Operations are defined with
zod schemas on both sides of each boundary:

- `RuntimeOps` for host ↔ runtime
- `AutomationOps` for Core ↔ host

A reply that doesn't match its schema is a fault.

**Timeouts, hangs and crashes.**

- Every call has a deadline.
- A hung runtime is stopped.
- A crash, during a call or between calls, is reported to the caller once,
  as `RUNTIME_CRASHED`.
- The next call starts a new runtime.

Jupiter's own processes are never affected.

### 3. Semantic first, verified always

**Controls.** Controls are found by automation id, name, control type and
class. Notepad's adapter finds its editor by role: the current Notepad's
`RichEditD2DPT` Document, or classic Notepad's Win32 `Edit` control (found by
class, since UI Automation may report it as an Edit, a Document or a Pane).
It uses the common Save As dialog by automation ids `1001` (file name) and
`1` (Save), opened with Notepad's own accelerator, Ctrl+S.

**Classic Win32 controls.** The runtime registers UI Automation's client-side
providers, which some Windows editions do not load by themselves. When a
classic Win32 edit box still has no Value pattern, the runtime reads and sets
its text through the control's own messages (`WM_GETTEXT`, `WM_SETTEXT`),
gives it focus with Win32 focus, and clicks a classic button with `BM_CLICK`:
still the control's semantic content, never a screen position. Windows are
listed from the window manager (`EnumWindows`), so a window that UI
Automation misses for a moment is not reported as closed.

**Typing.** The agent sets the control's value through UI Automation's
Value pattern when it has one, and falls back to the keyboard otherwise.

**Every action is checked afterwards:**

| Action            | Checked by                                                      |
| ----------------- | --------------------------------------------------------------- |
| Typing            | reading the text back                                           |
| Saving            | reading the file back on the host (existence and exact content) |
| Window operations | reading the window's state back                                 |
| Opening an app    | a new window of that app appearing                              |

An action whose effect isn't there fails, with `ACTION_NOT_VERIFIED`,
`SAVE_NOT_VERIFIED`, `WINDOW_STATE_NOT_APPLIED` or `WINDOW_NOT_FOUND`. A
failed action ends the task: nothing after it runs. An existing file is
never overwritten (`FILE_EXISTS`).

### 4. Permissions before touching anything

Every action maps to a capability and an exact target:

| Actions                                | Capability                   | Target                  |
| -------------------------------------- | ---------------------------- | ----------------------- |
| `OPEN_APP`                             | `computer.open_app`          | `app:notepad`           |
| `CLOSE_APP`, `FOCUS`, `MANAGE`, `WAIT` | `computer.manage_window`     | the app                 |
| `LIST_WINDOWS`                         | `computer.read_screen`       | the window list         |
| `READ_UI_TREE`, `SCREENSHOT`           | `computer.read_screen`       | the app (or the screen) |
| `CLICK_ELEMENT`, `SCROLL`, `SELECT`    | `computer.click` (new)       | the app                 |
| `TYPE_TEXT`, `PRESS_KEYS`              | `computer.type`              | the app                 |
| `SAVE_FILE`                            | `files.write`                | the exact path          |
| `CLICK_POINT`                          | `computer.click_point` (new) | the app                 |

The requester is the agent (`agent/computer`). Before a task runs, all its
requirements are checked without using anything up. The missing ones are
asked for at once, and the task waits (`WAITING_APPROVAL`) with nothing done.
Each action is checked again when it runs, which is when a single-use answer
is used.

A Mission step (`computer.notepad_write`) waits for these answers like a
Skill step does (ADR 0008).

### 5. Cancel at the safest boundary; re-resolve stale handles

**Cancel.** Cancel aborts the task's signal. The action under way finishes
its current runtime call; a UI Automation call is not split. Waits (for a
window, for a dialog) stop at their next poll. No queued action runs.

**Windows.** A window is looked up again for every action. The task's own
window of that application comes first. If its handle has gone stale, the
application's windows are searched again, and the log records the
re-resolution.

### 6. The coordinate fallback is opt-in, bounded and labelled

`CLICK_POINT` is refused before anything runs unless the task sets
`allowCoordinateFallback`. When allowed:

- It needs its own `computer.click_point` permission (HIGH), which is audited.
- The point is relative to the target window and must lie inside it. This
  is checked by Core and again by the runtime.
- Its result carries `method: "coordinate"`, and its observation says
  "Coordinate fallback" and that the effect isn't verified.

The interface labels it the same way.

### 7. Availability is stated, never simulated

On any system other than Windows:

- The host has no runtime.
- `agent-runtime` is shown as **Unavailable** (SET 8).
- `computer.status` gives the reason.
- The Notepad step is marked unavailable, so the planner cannot use it.
- `computer.run` fails with `COMPUTER_UNAVAILABLE`.

The acceptance tests against the real Notepad run on the Windows CI runner.
The agent's own logic is also tested on every platform, with a clearly
labelled test double of the host (`apps/desktop/test/fake-desktop.ts`).

## Consequences

- **Capabilities:** `computer.status`, `computer.run` (HIGH, always audited,
  10-minute deadline), `computer.cancel` and `computer.tasks`.
- **Host operation:** `host.computer.call`, for Core only.
- **Events:** `computer.task_started`, `computer.action_completed` and
  `computer.task_finished`.
- **Services:** `computer-agent` (Core) and `agent-runtime` (host; Windows
  only).
- **Migration 8** adds `computer_tasks`. It stores action types and
  observations, and never typed text.
- **Diagnostics** has a Computer Agent card: availability, runtime process
  and restarts, screen, save folder, and recent tasks with each action's
  method and observation.
- **Not in SET 8** (see the SET 8 report, §9):
  - computer vision
  - drag and drop
  - clipboard as a separate action
  - applications other than Notepad and File Explorer
