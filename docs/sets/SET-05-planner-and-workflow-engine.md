# SET 5 — Planner and Workflow Engine

- Status: **all 10 acceptance tests pass** locally on Linux with
  `npm run verify` (13/13 steps). See §7. CI evidence is recorded in §7 once
  the pushed commit has run.
- SET 4 re-checked first: green in CI on Linux and Windows (`4dd4b9c`, run
  36210734566), tagged `jupiter-set-04-mission-system`. Its E2E and in-process
  suites pass again on the SET 5 code (§12).
- Environment of the recorded run: Node.js 22.22.2, npm 10.9.7, Electron 44.4.5,
  Xvfb, GNOME Keyring (private, throwaway D-Bus session).

## 1. Scope completed

- **Plan schema** (`packages/contracts/src/plans.ts`): planId, missionId,
  goal, assumptions, a short rationale, steps, requiredSkills,
  requiredPermissions, expectedArtifacts and verificationPlan. Each step has:
  - stepId (`id`), title, description, skillId and dependencies
  - input, where `{{step}}` passes another step's output
  - an optional condition, timeoutMs and retryPolicy
    (maxAttempts, backoffMs, multiplier)
  - verification and required
  - status is kept per execution in `MissionStep`

  Plans are revisions (`revision`, `previousPlanId`, `source`, `reason`).

- **Execution states** PENDING, RUNNING, WAITING, COMPLETED, FAILED, SKIPPED
  and CANCELLED. Every attempt is recorded (completed, failed, timed-out,
  cancelled, interrupted).
- **Planner**: the configured chat model is asked for one JSON plan, never its
  reasoning. Its output must pass the strict schema and then the plan
  validator, or it is rejected with reasons and nothing runs. Jupiter's
  answer plan is available as a template. Assumptions are short and shown
  for correction.
- **Workflow Engine**:
  - sequential and parallel steps (dependency graph, at most 3 at once),
    conditional branching, bounded retries with growing waits, per-attempt
    timeouts
  - pause, resume and cancel
  - approval checkpoints; identity checkpoints are _Coming later_ (SET 14),
    so plans using them are rejected
  - artifact passing, with idempotency (step id as key, output stored once)
  - durable state and crash recovery (continues after a restart)
  - verification plan checks, and versioned re-planning after a failure or
    with the person's corrections
- **Workflow visualizer** in the Mission screen:
  - steps grouped into stages by dependencies ("These steps run in parallel")
  - the current step highlighted; completed, running, waiting, failed and
    skipped states
  - dependencies, conditions and time limits
  - attempts with their outcomes (retry state)
  - plan revision and _Re-planned_ state
  - plan panel with goal, assumptions, rationale, checks, revisions and
    rejections with reasons
  - approval with Approve and Reject
  - _Correct and re-plan_ with corrections and a planner choice
  - New Mission offers the planner (default) or the answer plan
  - English and Thai
- **Service**: `workflow-engine` is now a running Core service with a real
  self-check (it was listed as _Coming later_ for SET 5).

## 2. Files added or changed

| Area      | Files                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts | `plans.ts` (new), `missions.ts` (states, WAITING transitions, actions, attempts, plan in detail), `events.ts` (5 new events), `capabilities.ts` (approve, reject, replan, step-types; planner choice), `contracts.test.ts`                 |
| Core      | `workflow/{catalogue,validate,planner}.ts` (new), `workflow/validate.test.ts` (new), `missions/manager.ts` (workflow engine), `kernel/{core-kernel,capabilities}.ts` (`workflow-engine` service, policies), `ports.ts`, `index.ts`         |
| Database  | `schema.ts` (migration 5), `migrations.ts` (`rebuildsTables` with foreign-key check), `repositories/missions.ts`, `rows.ts`, `test/missions.integration.test.ts` (plans, attempts, v4 → v5 upgrade)                                        |
| Host      | `apps/desktop/src/main/services.ts` (workflow engine no longer planned)                                                                                                                                                                    |
| Renderer  | `views/MissionWorkflow.tsx` (new: plan panel, visualizer, approval, re-plan dialog, planner choice), `views/MissionsView.tsx`, `missionText.ts`, `useMissions.ts`, `HomeView.tsx`, `errorText.ts`, `styles.css`, `i18n/{en,th}.ts` (+test) |
| Tests     | `apps/desktop/test/{workflow,workflow-core}.integration.test.ts` (new), `core-harness.ts` (new, shared), SET 4 suites updated (`missions*.integration`, `app.integration`)                                                                 |
| Docs      | ADR `0006`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `AGENTS.md`, this report, `docs/sets/set-05/*.png`                                                                                                                         |

## 3. Architecture decisions

Recorded in [ADR 0006](../decisions/0006-planner-and-workflow-engine.md):

- a strict schema plus a validator as the only way into the engine
- a fixed step-type catalogue until skills exist (SET 6); any permission
  makes a plan unrunnable until SET 7
- the workflow as a dependency graph run by one loop per Mission, with
  attempts, backoff, timeouts and checkpoints
- the step id as idempotency key, with the output stored in the completing
  transaction
- durable state with recovery that continues rather than failing
- re-planning as a new linked revision
- `workflow-engine` as a Core service

No IPC channel or bridge function was added.

Conflicts with the Master Prompt, resolved without going beyond SET 5:

- "missing skills" and "undeclared permissions" are checked against the
  built-in catalogue, because skills (SET 6) and permissions (SET 7) do not
  exist yet
- identity checkpoints need SET 14, so they are marked unavailable and plans
  that use them are rejected
- "compensation/recovery hooks where possible": no step type changes anything
  outside Jupiter, so there is nothing to compensate yet; recovery is
  implemented

## 4. Database migrations

Migration 5 `0005_plans_and_workflows`:

- new tables: `mission_plans` (unique `(mission, revision)`,
  `previous_plan_id`) and `mission_plan_rejections`
- new column: `missions.current_plan_id`
- `mission_executions` rebuilt: `plan_id`, and the WAITING status
- `mission_steps` rebuilt: key, description, dependencies, input, condition,
  verification, timeout, retry policy, attempts, waiting-for, and unique
  `(execution, key)`
- new table: `mission_step_attempts`
- append-only triggers for plans, rejections and attempts

SET 4 rows are converted: SUCCEEDED becomes COMPLETED, and each step depends
on the one before it. The migration declares `rebuildsTables`, so it runs
with foreign keys off and must pass `PRAGMA foreign_key_check` before it
commits. A test upgrades a real SET 4 database and checks every row and
reference. The database is backed up before any upgrade (SET 1).

## 5. Security implications

- Model output never reaches the engine unchecked. Unknown fields (for
  example `reasoning`) are refused, and no reasoning is stored or shown. A
  rejected plan is stored with its reasons only.
- No plan can ask for a permission and still run. Every step type acts only
  inside Jupiter: the configured model, or local text. Identity checkpoints
  are unavailable.
- Outputs are written once, in the completing transaction. Retries and
  recovery never duplicate a side effect. Plans, rejections and attempts are
  append-only.
- Cancel and timeouts abort the step's provider request. Model steps and the
  planner use the SET 3 guarded path: Local only, key rules and fallback
  policy.
- Every new command is an audited capability. Commands that plan or run a
  workflow require the `workflow-engine` service.

## 6. Commands actually run

```bash
npm run verify     # 13/13 steps PASS (see §7)
npx vitest run --project unit packages/core/src/workflow                                     # 15/15
npx vitest run --project integration packages/database/test/missions.integration.test.ts    # 6/6
npx vitest run --project integration apps/desktop/test/workflow-core.integration.test.ts    # 14/14
npx vitest run --project integration apps/desktop/test/missions-core.integration.test.ts    # 8/8
node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/workflow.integration.test.ts apps/desktop/test/missions.integration.test.ts  # 16/16
```

## 7. Automated test results

`npm run verify` on the final SET 5 working tree: **13/13 steps PASS**
(format, lint, typecheck, unit, build, integration + E2E, secret scan, dev
smoke, Windows and Linux unpacked builds and validation, packaged launch).

| Suite                                              | Result                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Unit (24 files)                                    | **235 passed**, 0 failed (incl. 15 new plan-validator/planner tests)        |
| Integration (22 files)                             | **164 passed**, 0 failed, 3 skipped (packaged tests, run as their own step) |
| — SET 5 E2E, real app (`workflow.integration`)     | **8 passed**                                                                |
| — SET 5 Core in process (`workflow-core`)          | **14 passed**                                                               |
| — database (`missions.integration`, incl. v4 → v5) | **6 passed**                                                                |
| — SET 4 E2E and in-process (re-check)              | **8 + 8 passed**                                                            |
| Packaged app launch (Linux unpacked)               | **3 passed**                                                                |
| Development-mode smoke                             | **passed**                                                                  |
| Secret scan (sources and build output)             | **352 files**, 0 findings                                                   |

An earlier run of the suite found one real test-design flaw, fixed before
the recorded run: two parallel requests race for scripted replies, so the
restart tests now make the step that is cut off depend on the other one,
and assertions about parallel outputs accept either order.

### CI evidence

Recorded after the push (see the PR's checks).

## 8. Manual tests

The E2E suite drives the real app through the interface; its screenshots were
reviewed:

| Screenshot                                                 | What it shows                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Parallel steps](set-05/01-parallel-steps-running.png)     | The planner's plan (goal, assumptions, rationale) and two steps running in one stage    |
| [Completed workflow](set-05/02-workflow-completed.png)     | Three stages completed, the join step used both outputs                                 |
| [Rejected: not JSON](set-05/03-plan-rejected-not-json.png) | Prose instead of a plan: rejected with the reason, nothing ran                          |
| [Rejected: cycle](set-05/04-plan-rejected-cycle.png)       | A cyclic plan rejected with the steps involved                                          |
| [Waiting for approval](set-05/05-waiting-for-approval.png) | The approval question with Approve and Reject; the checkpoint node waiting              |
| [Retried step](set-05/06-retried-step.png)                 | Attempts 1–2 failed (503), attempt 3 completed; one result                              |
| [Re-plan dialog](set-05/07-replan-dialog.png)              | Corrections and planner choice                                                          |
| [Re-planned](set-05/08-replanned.png)                      | Revision 2, _Re-planned_, both revisions listed, attempts table with each plan revision |
| [After restart](set-05/09-after-restart.png)               | The cut-off step ran again (interrupted, then completed); the finished step did not     |

Found and fixed through this review: after a restart a step showed _Attempt 2
of 1_. The interrupted attempt does not use up the retry budget, and the
counter now shows only attempts that do (_Attempt 1 of 1_). The E2E test
checks this.

## 9. Known limitations

- Step types are a fixed catalogue:
  - ask the chat model
  - compose text
  - ask for approval

  Skills (SET 6) replace it, and permissions (SET 7) can then be granted.

- Identity checkpoints are _Coming later_ (SET 14).
- Nothing needs compensation yet. Side-effecting skills must bring their
  compensating action.
- A step cut off by a restart runs again from its start. There is no
  mid-step resume: a model request cannot be resumed.
- Planning cut off by a restart is recorded as failed. Re-plan is offered.
- Plan quality depends on the model. Plans that are invalid are always
  rejected, but a valid plan can still be a poor one; correcting its
  assumptions and re-planning is the remedy.

## 10. How to run

```bash
npm ci && npm run dev
```

1. Set up a model in _AI Models_.
2. Open _Missions_ › _New Mission_ and describe a task. The planner is the
   default.
3. Read the plan, watch the workflow stages, and answer approvals.
4. After a failure, use _Correct and re-plan_.

## 11. Evidence and artifact paths

- `test-results/set-05/*.png` (written by the E2E suite; uploaded by CI)
- `docs/sets/set-05/*.png`

## 12. Acceptance tests

| #   | Test                                               | Status   | Evidence                                                                                                                                                                                                                             |
| --- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Planner returns valid schema                       | **PASS** | In-process: the model's JSON plan is stored as revision 1 with every field, `mission.planned`, run to COMPLETED; E2E: the plan panel shows source, revision, goal, assumptions, rationale; unit: the template plan validates         |
| 2   | Invalid model output is rejected                   | **PASS** | Unit + in-process + E2E: prose → `not-json`; an extra `reasoning` field → `schema` (and the text is stored nowhere); Mission FAILED with `PLAN_INVALID`, rejection stored with reasons, no execution, only the planning request made |
| 3   | Dependency ordering works                          | **PASS** | In-process: a → b → c, events in order started/finished 0,1,2; b's prompt contains a's output, c's template both; E2E: the join step ran after both and used both outputs                                                            |
| 4   | Independent steps execute in parallel              | **PASS** | In-process + E2E with a gated server: both model steps' requests are open at once, both nodes RUNNING in one stage, the dependent step PENDING until both complete                                                                   |
| 5   | Cancel stops all child steps                       | **PASS** | In-process + E2E: Cancel with two steps running → both CANCELLED (attempts `cancelled`), dependent SKIPPED, both provider connections closed, no further request                                                                     |
| 6   | Timeout terminates step correctly                  | **PASS** | In-process + E2E: a stalled model step with a 5 s limit → `STEP_TIMEOUT` after ≈5 s, attempt `timed-out`, provider request closed, no partial output kept                                                                            |
| 7   | Retry policy works without duplicate side effects  | **PASS** | In-process: 503, 503, check failed, success → attempts 1–4 recorded, retry waits 100/200/400 ms, exactly one artifact per step; E2E: _Attempt 3 of 3_, outcomes failed/failed/completed, one result                                  |
| 8   | Failed step can trigger versioned re-plan          | **PASS** | In-process + E2E: after a failed step, re-plan with corrections → the planner receives the failed step, error code and corrections; revision 2 linked to 1; new execution linked to the failed one; both kept                        |
| 9   | Workflow state survives UI refresh and app restart | **PASS** | E2E: page reload shows the same running workflow; app closed mid-step and relaunched → the cut-off step ran again (interrupted → completed), the finished step was not repeated; in-process: also a waiting approval survives        |
| 10  | Cyclic and permission-invalid plans cannot run     | **PASS** | Unit + in-process + E2E: cycle → `cycle`, a permission → `permission-unavailable`, a missing dependency → `missing-dependency`; no execution or step, only the planning request made                                                 |

### SET 0–4 re-check (on the SET 5 code)

All earlier suites pass (`app`, `core-gateway`, `shell`, `ai`, `ai-core`,
`missions`, `missions-core`, `packaged`), updated only where SET 5 changed
facts:

- `workflow-engine` is a running Core service.
- SET 4 Missions run the answer plan in the SET 5 schema: two steps, a
  `non-empty` check, COMPLETED instead of SUCCEEDED.
- The answer step retries once.
- Interrupted work continues after a restart instead of failing.
- Retry needs a plan (Re-plan otherwise).
- Finished Missions also offer _Correct and re-plan_.
