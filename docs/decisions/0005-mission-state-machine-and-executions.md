# ADR 0005 — Missions: one state machine, executions as attempts, steps Jupiter can really run

- Status: accepted (SET 4)
- Date: 2026-09-26

## Context

SET 4 asks for a real Mission Manager: persistent Missions whose status is
driven by real execution events, an explicit finite-state machine that
rejects and records invalid transitions, pause/resume at a safe boundary,
cancellation that reaches active work, retry that keeps the failed attempt,
COMPLETED only with a successful verification, PARTIAL_SUCCESS that lists
what did and did not finish, and a human-readable timeline rebuilt after a
restart.

A Mission has to execute something. The planner and workflow engine arrive
in SET 5, skills in SET 6 and agents in SET 8. Whatever runs in SET 4 must be
real, not staged.

## Decisions

### 1. The state machine is data in the contract, enforced in one place in Core

`MISSION_TRANSITIONS` in `packages/contracts/src/missions.ts` lists, for each
of the 13 statuses, the statuses it may move to. The interface uses the same
table to offer only the actions a state allows (`availableMissionActions`).
Core changes a Mission's status only through `MissionManager.transition`:

- An allowed change is stored in `mission_transitions` (from, to, reason,
  actor, time), applied, and published as `mission.status_changed`, all in
  one transaction.
- A change the table does not allow is stored as **rejected** with its
  reason, published as `mission.transition_rejected`, and refused with
  `INVALID_MISSION_TRANSITION`. The dispatcher's audit record of the refused
  command now carries the error code.
- Extra guard: COMPLETED needs at least one passed verification of the
  current execution, and every required step succeeded.

Alternatives: implicit status changes spread across handlers (no single place
to prove the machine), and a state-machine library (a dependency for a
13-row table).

### 2. Executions are attempts; history is append-only

Each run is an execution (`attempt` 1, 2, …, `retryOf` the previous one) with
its own steps. Retry creates a new execution. It never resets the old one, so
the failed attempt keeps its steps, errors and verification results.
Transitions, errors, verification results and artifacts are append-only in
SQLite: triggers refuse UPDATE and DELETE. Nothing is deleted; Archive hides a
finished Mission from the default list.

### 3. Steps run one at a time; the boundary between steps is the only safe pause point

The runner executes the next pending step, then checks for Cancel and Pause.

- **Pause** records `pauseRequested` and takes effect when the current step
  ends, so nothing is cut off mid-way.
- **Cancel** aborts the run's `AbortSignal`. The model step passes it to the
  adapter, which closes the provider connection. The active step becomes
  CANCELLED and the rest SKIPPED.
- A required step that fails ends the execution as FAILED, and the steps
  after it are SKIPPED with the reason. An optional step that fails lets the
  Mission continue; if verification then passes, the outcome is
  PARTIAL_SUCCESS, with each step's outcome listed.
- Verify steps run in VERIFYING.
- Work that was running when Core stopped is marked FAILED
  (`MISSION_INTERRUPTED`) at the next start, and can be retried. A PAUSED
  Mission stays paused and can be resumed after a restart.

### 4. SET 4 runs only what Jupiter can really do: the answer plan

Planning uses Jupiter's standard **answer plan** (`source: 'template'`),
labelled as such in the interface:

1. The configured chat model answers the request (required).
2. It writes a one-line summary (optional).
3. The answer is checked (required).

Model steps go through the same routing, network guard, key handling and
fallback rules as Chat (`completeText`). Analysis checks that a chat model is
available. If none is, the Mission fails with the router's own configuration
error and nothing is invented. Permissions (SET 7), agents (SET 8) and skills
(SET 6) are shown as _Coming later_. The planner (SET 5) will produce real
plans in the same schema.

Alternatives: simulated steps with timers (forbidden: fake progress), and
waiting for SET 5 before running anything (then none of the SET 4 acceptance
tests could be proven with real execution).

### 5. The timeline is the Mission's event stream

Every change is a persistent event on the stream `mission/<missionId>`, with
the `missionId` and `executionId` envelope fields set. The timeline is these
events, read back from the event log and turned into plain language by the
interface (`missionText.ts`). After a restart it is rebuilt from the same
stored events, so it is identical. Technical details (event type, time,
correlation id) are available per entry, but hidden by default.

## Consequences

- Migration 4 adds seven tables and eight append-only triggers.
- The capability catalogue gains `missions.create/list/get/timeline/pause/resume/cancel/retry/archive`,
  audited on every call.
- Home's stage shows _Working_ only while a Mission is really analyzing,
  planning, running or verifying.
- The step kinds are an enum in the contract. SET 5 and later extend it
  together with their executors.
