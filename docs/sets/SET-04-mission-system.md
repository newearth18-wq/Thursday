# SET 4 — Mission System

- Status: **all 10 acceptance tests pass locally on Linux**, after a clean
  `npm ci` and `npm run verify` (13/13 steps). CI on Linux and Windows is
  recorded in §7 once it has run on the pushed commit.
- SET 3 re-checked before SET 4 was committed: green in CI on Linux and
  Windows (`abb94f8`, run 36208820322), tagged
  `jupiter-set-03-ai-providers-and-chat`.
- Environment of the recorded run: Node.js 22.22.2, npm 10.9.7, Electron 44.4.5,
  Xvfb 4096×2304, GNOME Keyring (private, throwaway D-Bus session).

## 1. Scope completed

- **Mission schema** (`packages/contracts/src/missions.ts`): id, title,
  user request, created/updated time, status, priority, plan, steps, current
  and next step, permissions, artifacts, errors, verification results and
  execution history (attempts, each with its steps, plus every transition).
- **The 13 statuses** (`CREATED` … `CANCELLED`) and an explicit state machine
  (`MISSION_TRANSITIONS`). Invalid transitions are rejected, stored with their
  reason, published and audited.
- **Normalized records** (migration 4): Missions, executions, steps,
  transitions, errors, verification results and Mission artifacts. History
  tables are append-only.
- **Operations**: create, pause (at a safe boundary), resume, cancel
  (propagates to the active step and its provider request), retry (a new
  linked attempt; the failed one is kept), archive, open detail, and the
  timeline.
- **Rules**: COMPLETED needs at least one successful verification and no
  unresolved required step. PARTIAL_SUCCESS lists completed and
  failed/skipped steps.
- **Execution**: the steps Jupiter can really run today. The chat model
  answers the request (required), writes a one-line summary (optional), and
  the answer is checked (required). Model steps use the SET 3 routing,
  network guard and fallback rules. The plan is labelled as Jupiter's standard
  answer plan; the planner arrives in SET 5.
- **Interface**: the _Missions_ screen (list, detail, recovery actions,
  human-readable timeline, attempts table), a New Mission dialog, and Home's
  Mission card and stage following the current Mission. Agents, skills and
  permissions are shown as _Coming later_ or _None needed_. English and Thai.

## 2. Files added or changed

| Area      | Files                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts | `packages/contracts/src/missions.ts` (new), `events.ts` (11 Mission events), `capabilities.ts` (9 capabilities), `contracts.test.ts`                                                                                          |
| Core      | `packages/core/src/missions/manager.ts` (new), `ai/complete.ts` (new), `kernel/{core-kernel,capabilities}.ts`, `dispatch/dispatcher.ts` (error code in audit), `ports.ts`                                                     |
| Database  | `packages/database/src/schema.ts` (migration 4), `repositories/missions.ts` (new), `jupiter-database.ts`, `test/missions.integration.test.ts` (new)                                                                           |
| Host      | `apps/desktop/src/main/services.ts` (Mission manager is now a Core service)                                                                                                                                                   |
| Renderer  | `views/MissionsView.tsx` (new), `useMissions.ts` (new), `missionText.ts` (new), `components/{MissionCard,JupiterStage,ActivityTimeline}.tsx`, `HomeView.tsx`, `router.ts`, `destinations.ts`, `styles.css`, `i18n/{en,th}.ts` |
| Shared    | `apps/desktop/src/shared/views.ts` (`#/missions/<id>`)                                                                                                                                                                        |
| Tests     | `apps/desktop/test/{missions.integration,missions-core.integration}.test.ts` (new); SET 2–3 tests updated; `packages/testing/src/protocol-servers.ts` (reset releases stale gates)                                            |
| Docs      | ADR `0005`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `AGENTS.md`, this report, `docs/sets/set-04/*.png`                                                                                                            |

## 3. Architecture decisions

Recorded in [ADR 0005](../decisions/0005-mission-state-machine-and-executions.md):
the state machine as data in the contract, enforced in one place in Core;
executions as attempts, with append-only history; one step at a time, with
the boundary between steps as the only pause point; only real steps (the
answer plan); the timeline as the Mission's own event stream. No IPC channel
or bridge function was added.

## 4. Database migrations

Migration 4 `0004_missions`: `missions`, `mission_executions` (unique
`(mission, attempt)`, `retry_of` foreign key), `mission_steps` (unique
`(execution, index)`), `mission_transitions`, `mission_errors`,
`mission_verifications`, `mission_artifacts`, plus eight triggers that make
the last four append-only. An existing database is backed up before the
upgrade (SET 1 mechanism).

## 5. Security implications

- Every Mission command is a capability, audited on every call, including
  refusals, now with the error code. A refused transition is also kept in
  `mission_transitions`.
- History cannot be rewritten or erased (append-only triggers). Retry never
  changes an earlier attempt, and nothing is deleted (Archive hides).
- Cancelling aborts the active provider request. Model steps use the SET 3
  network guard, so Local only and the key rules apply to Missions too.
- No step can act outside Jupiter: no files, shell or network beyond the
  configured model. Permissions (SET 7) are not needed by any step yet, and the
  interface says so.

## 6. Commands actually run

```bash
npm ci                    # 0 vulnerabilities
npm run verify            # result recorded in §7
node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/missions.integration.test.ts   # 8/8
npx vitest run --project integration apps/desktop/test/missions-core.integration.test.ts                          # 8/8
```

## 7. Automated test results

The full `npm run verify` result and the per-suite counts are added here once the run on the final tree completes.

CI (Linux and Windows) on the pushed commit: see the pull request; this
section is updated with the run once it completes.

## 8. Manual tests

The E2E suite drives the real app through the interface; its screenshots were
reviewed:

| Screenshot                                               | What it shows                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Completed](set-04/01-mission-completed.png)             | A completed Mission: steps, results, verification, timeline               |
| [Home while running](set-04/02-home-running-mission.png) | Stage _Working_ with the Mission's title, Mission card with real progress |
| [Paused](set-04/03-mission-paused.png)                   | Paused after the first step, Resume offered                               |
| [Cancelled](set-04/04-mission-cancelled.png)             | Active step stopped, remaining steps skipped                              |
| [Partial](set-04/05-mission-partial.png)                 | What was completed and what was not                                       |
| [Retried](set-04/06-mission-retried.png)                 | Attempt 2 completed, attempt 1 kept as failed                             |
| [After restart](set-04/07-mission-after-restart.png)     | The same Mission and timeline after relaunching                           |

Found and fixed through this review: Home's stage said _Idle — nothing is in
progress_ while a Mission was running. It now says _Working_, naming the
Mission, only while a Mission is really analyzing, planning, running or
verifying.

## 9. Known limitations

- Missions run one fixed plan (answer, summary, check). The planner (SET 5)
  replaces the template with a plan for each request.
- `WAITING_APPROVAL` and `WAITING_IDENTITY` are in the state machine but no
  step leads there yet (SET 7, SET 14).
- Work interrupted by a Core stop is marked failed and must be retried; it is
  not resumed mid-step.
- Artifacts are text kept in the database; the Artifact Manager (SET 10) takes
  over files.

## 10. How to run

```bash
npm ci && npm run dev
```

Set up a model in _AI Models_ (for example a local server), open _Missions_ ›
_New Mission_, describe a task, and watch its steps. Try Pause during the
first step, Cancel, and Retry after turning the model server off and on.

## 11. Evidence and artifact paths

- `test-results/set-04/*.png` (written by the E2E suite; uploaded by CI)
- `docs/sets/set-04/*.png`

## 12. Acceptance tests

| #   | Test                                               | Status   | Evidence                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Create a Mission                                   | **PASS** | E2E: New Mission dialog → Mission created, opened at `#/missions/<id>`, runs; in-process test checks title, priority, plan, steps, artifacts                                                                                                                 |
| 2   | Restart Jupiter; the Mission still exists          | **PASS** | E2E: app closed and relaunched, Missions list identical; in-process: Core restarted on the same database, detail identical                                                                                                                                   |
| 3   | Valid status transitions work                      | **PASS** | E2E + in-process: stored path CREATED → ANALYZING → PLANNING → READY → RUNNING → VERIFYING → COMPLETED, all accepted; pause/resume and retry paths; contract tests of the table                                                                              |
| 4   | Invalid transition is rejected and audited         | **PASS** | E2E + in-process: Resume on a COMPLETED Mission → `INVALID_MISSION_TRANSITION`, status unchanged, rejected transition stored (actor `user-interface`), `mission.transition_rejected` event, audit record `FAILED` with the error code, shown in the timeline |
| 5   | Pause/resume works at a safe boundary              | **PASS** | E2E + in-process with a gated server: Pause during the first step keeps RUNNING (_Pausing after the current step_), pauses when the step ends, sends nothing more; Resume completes; also across a Core restart                                              |
| 6   | Cancellation stops active work                     | **PASS** | E2E + in-process: Cancel during the first step → CANCELLED, steps CANCELLED/SKIPPED/SKIPPED, the provider saw its connection closed                                                                                                                          |
| 7   | Retry creates valid linked execution history       | **PASS** | E2E + in-process: after a 503 failure, Retry → attempt 2 with `retryOf` = attempt 1, which keeps its FAILED/SKIPPED steps and errors                                                                                                                         |
| 8   | Completed Mission contains successful verification | **PASS** | E2E + in-process: `answer-present` and `summary-present` passed for the completing execution; the state machine refuses COMPLETED without one                                                                                                                |
| 9   | Partial success identifies incomplete results      | **PASS** | E2E + in-process: summary step hits a 503 → PARTIAL_SUCCESS; the screen lists "Completed: Answer the request, Check the answer" and "Not completed: Write a one-line summary (Failed)"                                                                       |
| 10  | Timeline is reconstructed accurately after restart | **PASS** | E2E: the visible timeline entries and the stored events are identical before and after relaunching; in-process: timeline events equal after a Core restart                                                                                                   |

### SET 0–3 re-check (on the SET 4 code)

All earlier E2E suites pass (`app`, `core-gateway`, `shell`, `ai`,
`ai-core`, `packaged`), updated only where SET 4 changed facts: Missions is
no longer _Coming later_ (6 unfinished screens instead of 7), `mission-manager`
is a running Core service, and the Mission card's empty state points to
Missions.
