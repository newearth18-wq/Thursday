# ADR 0006 — Planner and Workflow Engine: validated plans, a durable dependency graph, versioned re-planning

- Status: accepted (SET 5). Supersedes parts of ADR 0005 §3 (one step at a
  time; interrupted work marked failed) and §4 (the fixed answer plan).
- Date: 2026-09-26

## Context

SET 5 asks for a Planner that turns a request into a structured plan, and a
Workflow Engine that runs it. The engine must handle sequential and parallel
steps, conditions, bounded retries with backoff, timeouts, pause, resume,
cancel, approval and identity checkpoints, passing results between steps,
idempotency, recovery after a crash, and re-planning. Model output must pass
a strict schema before the engine sees it. Plans with cycles, missing
dependencies, missing skills, undeclared permissions, invalid timeouts or
unclear artifact references must be rejected. No chain-of-thought may be
stored or shown.

Skills (SET 6), the Permission Engine (SET 7) and identity verification
(SET 14) do not exist yet. Whatever SET 5 runs must be real.

## Decisions

### 1. A plan is data in the contract, and passes two gates

`PlanDraft` (`packages/contracts/src/plans.ts`) is exactly what a planning
model must return. It is a strict zod schema: an unknown field, such as a
`reasoning` field, is refused, not dropped. Core then runs `validatePlan`
(`packages/core/src/workflow/validate.ts`) for what a schema cannot express:

- duplicate steps, missing dependencies and cycles
- unknown or unavailable step types, and undeclared or unused `requiredSkills`
- permissions: any `requiredPermissions` means the plan cannot run, because
  nothing can grant a permission before SET 7
- timeouts: each step has a per-type minimum, and a worst case (every retry
  and wait) of at most 30 minutes
- inputs: required inputs present, unknown inputs refused
- artifact references: `{{step}}` must name a step that produces output and
  that this step depends on, directly or indirectly
- conditions: they must refer to a dependency, and never to the failure of a
  required step
- verification: at least one check of a required, unconditional step, with
  valid check parameters

A plan that fails either gate is stored in `mission_plan_rejections` with
every reason, published as `mission.plan_rejected`, and the Mission fails
with `PLAN_INVALID`. Nothing of it runs.

The planning model gets the step catalogue, the schema in words and the
request. It is asked for one JSON object with a short `rationale`, never for
its reasoning. Only the validated plan is stored. The request goes through
the same routing, network guard and key handling as Chat (`completeText`).
Structured-output mode is not used, because not every adapter supports it
(Anthropic's does not); the strict parse makes it unnecessary.

Alternative considered: accept loosely shaped output and repair it. Rejected:
it hides model errors and lets unreviewed structure reach the engine.

### 2. Step types come from a fixed catalogue until skills exist

`packages/core/src/workflow/catalogue.ts` lists what the engine can really
run:

| Step type             | Does                                                        | Output |
| --------------------- | ----------------------------------------------------------- | ------ |
| `model.generate`      | Sends a prompt to the configured chat model                 | text   |
| `text.compose`        | Fills a template with earlier outputs, locally              | text   |
| `checkpoint.approval` | Waits until the person approves or rejects                  | none   |
| `checkpoint.identity` | _Coming later_ (SET 14): marked unavailable, plans rejected | none   |

`missions.step-types` returns the catalogue. The Skill Framework (SET 6)
replaces it with installed skills, which use the same `skillId` field.

### 3. The workflow is a dependency graph, run by one loop per Mission

Steps start as soon as every step they depend on has ended, so independent
steps run in parallel, at most three at once per Mission. The loop:

1. Decides pending steps whose dependencies have ended:
   - skipped when their condition is not met (the branch was not taken)
   - skipped when a dependency did not complete, unless the condition is on
     that dependency's failure
   - otherwise ready
2. Stops everything else when a required step fails.
3. Pauses when a pause was requested and no step is running.
4. Starts ready steps and waits for one to end, or for Cancel, Pause or an
   approval.

When nothing is running and a checkpoint is waiting, the Mission moves to
WAITING_APPROVAL (the state machine gained RUNNING ⇄ WAITING_APPROVAL and
WAITING_IDENTITY). When everything has ended, verification runs.

- **Attempts, retries, timeouts.** Each attempt of a step has its own timeout
  and is recorded in `mission_step_attempts`: completed, failed, timed-out,
  cancelled or interrupted. A failed, retryable attempt is tried again after
  `backoffMs × multiplier^(n−2)`, up to `maxAttempts`, and each wait is
  published as `mission.step_retry_scheduled`. A timed-out attempt aborts its
  provider request (`STEP_TIMEOUT`). A step's own output check (for example
  `contains`) failing counts as a failed attempt.
- **Idempotency.** The step id is the idempotency key. A step's output is
  written in the same transaction that marks it COMPLETED, and a step whose
  output is already stored is never run again, including after a restart.
  Failed attempts write no output, so retries never duplicate one.
- **Verification.** The plan's `verificationPlan` checks run in VERIFYING, on
  the outputs of this execution. COMPLETED needs every check to pass, and
  every step to have completed or been left out by its condition.
  PARTIAL_SUCCESS is the same with an optional step that did not complete.
- **Cancel** aborts every running step at once. The steps are recorded as
  CANCELLED, pending ones as SKIPPED and a waiting checkpoint as CANCELLED.
- **Compensation.** No step type in this build changes anything outside
  Jupiter, so there is nothing to undo. The hook for it is a step type's
  executor, and SET 6/7 add compensating actions together with side-effecting
  skills.

Alternative considered: one step at a time (ADR 0005). Rejected: it cannot
run independent steps in parallel, which SET 5 requires.

### 4. State is durable and the engine continues after a crash

Every change (step status, attempt, output, event) is committed before the
engine acts on it. At start, `recover()` handles in-flight Missions:

- RUNNING or VERIFYING Missions with a plan continue:
  - steps that were running get an `interrupted` attempt and go back to
    PENDING
  - interrupted attempts do not count against the retry budget
  - `mission.recovered` is published and the loop resumes
- Planning that was cut off is marked FAILED (`MISSION_INTERRUPTED`), with
  Re-plan available.
- PAUSED and WAITING_APPROVAL Missions keep waiting: Resume or Approve starts
  the loop again.

The interface reads everything from Core, so a refresh shows exactly the
stored state.

### 5. Re-planning adds a revision; nothing is replaced

`missions.replan` (from any finished state) moves the Mission to PLANNING and
asks the planner again. The request carries three things:

- the previous plan's outline
- the failure (step and error code) of the last execution
- the person's corrections, e.g. a wrong assumption (optional)

The new plan is stored as revision n+1 with `previousPlanId`, and its
execution is linked to the previous one (`retryOf`, `planId`). Earlier plan
revisions, rejections and executions stay as they were (append-only
triggers). Retry runs the same plan again. It is not offered when there is no
plan (planning failed, or a SET 4 Mission). The planner's choice is per
request: the model planner (the default in the interface), or Jupiter's
answer plan, now expressed as a SET 5 plan (answer, optional summary, a
`non-empty` check).

### 6. The workflow engine is a Core service

`workflow-engine` is no longer _Coming later_. It is a Core service whose
start is a real self-check: the built-in answer plan must pass the
validator. Commands that plan or run a workflow require it. Mission reads do
not.

## Consequences

- Migration 5 adds:
  - `mission_plans`, `mission_plan_rejections` and `mission_step_attempts`
    (append-only)
  - `missions.current_plan_id`
- Migration 5 rebuilds `mission_executions` (plan id, WAITING) and
  `mission_steps` (key, dependencies, input, condition, verification,
  timeout, retry policy, attempts, waiting). SET 4 rows are converted:
  SUCCEEDED becomes COMPLETED, and each step depends on the one before it.
  Migrations can declare `rebuildsTables`: foreign keys are switched off for
  that migration only, and `PRAGMA foreign_key_check` must pass before it
  commits.
- Step statuses are PENDING, RUNNING, WAITING, COMPLETED, FAILED, SKIPPED
  and CANCELLED. Events stored by SET 4 with `SUCCEEDED` still read
  correctly.
- New capabilities: `missions.approve`, `missions.reject`, `missions.replan`
  and `missions.step-types`. `missions.create` takes `planner`: `template` is
  the default for API callers, so SET 4 behaviour is unchanged, while the
  interface defaults to `model`.
