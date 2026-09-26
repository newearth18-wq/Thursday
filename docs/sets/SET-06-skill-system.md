# SET 6 — Skill System

- Status: **all 10 acceptance tests pass**, locally on Linux with
  `npm run verify` (13/13 steps) and in CI on Linux and Windows (`63e539e`,
  run 36229785047). See §7. Tagged `jupiter-set-06-skill-system`.
- SET 5 was re-checked first: green in CI on Linux and Windows (`8d21447`,
  run 36226415156) and tagged `jupiter-set-05-planner-and-workflow-engine`.
  Its suites pass again on the SET 6 code (§12).
- Environment of the recorded run: Node.js 22.22.2, npm 10.9.7, Electron
  44.4.5, Xvfb, and GNOME Keyring in a private, throwaway D-Bus session.

## 1. Scope completed

- **Skill definition** (`packages/contracts/src/skills.ts`): skillId, name,
  description, version, inputSchema, outputSchema, permissions, timeout,
  category, provider and compatible runtime. Input and output use a strict
  JSON Schema subset.
- **Invocation:** executionId, skillId, missionId, input, permissions,
  timeout, idempotencyKey and signal. The permissions are decided by Core,
  never by the caller.
- **Result:** executionId, status, output, error, artifacts, startedAt,
  completedAt and verificationHints. Status is one of SUCCESS, FAILED,
  CANCELLED, TIMEOUT, WAITING_APPROVAL or WAITING_IDENTITY.
- **Registry:** register, unregister, get, search, enable, disable,
  healthCheck, invoke, cancel and listVersions. Run as the Core service
  `skill-registry`.
- **Internal Skills:** `echo_text`, `get_app_version`, `get_system_time`,
  `list_available_skills`.
- **Rules:**
  - Metadata, input, output, permissions, timeout and result are all
    validated, and strict schemas reject undeclared fields.
  - Permissions are granted by the invocation context.
  - Resources are checked against the permissions a Skill both declared and
    was granted.
  - Disabled, unhealthy, incompatible or missing Skills do not run.
  - Timeout and cancel terminate the Skill's worker thread.
  - Broken Skills return a structured failure, and Core carries on.
  - History keeps shape and size only, never content.
- **Skill Center:**
  - Each Skill shows provider, category, enabled state, permissions (risk,
    grantable), version(s), health with detail, last check and duration,
    and runtime compatibility.
  - Search, with filters by category, provider and health.
  - Health can be checked on demand, and a Skill can be enabled or disabled.
  - Low-risk internal Skills have a safe test form: a real invocation, with
    Cancel.
  - Recent runs are listed. English and Thai.
- **Workflow link:**
  - Registered Skills are SET 5 step types: the planner offers them, the
    validator checks them, and the engine runs them through the registry.
  - The Missions detail and the Home Mission card show real Skills where
    they used to say _Coming later_.

## 2. Files added or changed

| Area      | Files                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts | `skills.ts` (new); `plans.ts` (`SkillId` accepts `echo_text`); `events.ts` (5 `skill.*` events, stream `skill`); `capabilities.ts` (9 capabilities; diagnostics list bound raised to 128); `contracts.test.ts`                                         |
| Core      | `skills/{schema-check,sandbox,builtin,registry}.ts` (new); `node/worker-sandbox.ts` (new); `workflow/{catalogue,validate,planner}.ts` (Skills as step types); `missions/manager.ts`; `kernel/{core-kernel,capabilities}.ts`; `ports.ts`; `index.ts`    |
| Database  | `schema.ts` (migration 6); `repositories/skills.ts` (new); `jupiter-database.ts`; `test/skills.integration.test.ts` (new)                                                                                                                              |
| Host      | `main/services.ts` (Skill Registry no longer planned); `core/index.ts` (sandbox, and test fixtures in the test environment)                                                                                                                            |
| Renderer  | `views/SkillsView.tsx`, `useSkills.ts`, `skillText.ts` (new); `App.tsx`, `destinations.ts`, `FeatureViews.tsx`, `MissionsView.tsx`, `HomeView.tsx`, `ActivityTimeline.tsx`, `missionText.ts`, `errorText.ts`, `styles.css`, `i18n/{en,th}.ts` (+ test) |
| Tests     | `skills.integration.test.ts` and `skills-core.integration.test.ts` (new); `worker-sandbox.integration.test.ts`, `schema-check.test.ts` (new); SET 1–5 suites updated                                                                                   |
| Docs      | ADR `0007`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `AGENTS.md`, this report, `docs/sets/set-06/*.png`                                                                                                                                     |

## 3. Architecture decisions

Recorded in [ADR 0007](../decisions/0007-skill-registry-and-sandbox.md):

- definitions as data, with a strict JSON Schema subset
- one worker thread per invocation, with the code in a `vm` context;
  terminating the thread is what makes timeout and cancel real
- permissions granted by the invocation context, and checked on every
  resource use
- the registry decides what may run and validates the result
- history by shape only
- Skills as workflow step types
- test fixtures only in the test environment

No IPC channel or bridge function was added.

How conflicts with later SETs were resolved:

- **Permission Engine (SET 7).** Until it exists, Core grants only three
  low-risk read permissions (`app.version.read`, `system.time.read`,
  `skills.read`). Any other permission is refused with a reason that names
  SET 7. The status values WAITING_APPROVAL and WAITING_IDENTITY exist in
  the contract, but no Skill in this build leads to them.
- **Registering Skills.** This is a Core-internal API, used by Core and by
  tests. Registering third-party code comes with the plugin runtime
  (SET 15), so the interface has no Register button.

## 4. Database migrations

Migration 6 `0006_skills` adds two tables and a unique index:

- **`skills`** (key: `skill_id, version`) holds the definition, the enabled
  state, the last health check (status, detail, time, duration), and when
  the Skill was registered and unregistered.
- **`skill_executions`** holds each run:
  - Skill and version, Mission, actor, status and error code
  - the permissions it was granted
  - the input and output summary (shape and size)
  - the idempotency key, start and end time
  - a foreign key to `skills`
- **The index** is a partial unique index on `(skill_id, idempotency_key)`.

An existing database is backed up before the upgrade (the SET 1
mechanism).

## 5. Security implications

- **Isolation.** Skill code runs in a worker thread. Inside it, the code
  runs in a `vm` context with no `require`, `process`, timers or
  environment variables, with a memory limit, and with string code
  generation turned off. Timeout and cancel terminate the thread. This
  isolates faults and stops work, but it is not a hardened boundary against
  hostile code; that is what the plugin runtime (SET 15) is for.
- **Permissions.** Neither the Skill nor the caller can grant itself
  anything. Any use of a resource the Skill did not declare, or was not
  granted, fails the execution (`PERMISSION_DENIED`).
- **Validation.** Metadata, input and output must pass strict schemas.
  Invalid output fails the execution.
- **History.** Only shape and size are kept, never content, and Skill error
  text is redacted. A test checks that the typed text is nowhere in the
  database.
- **Audit.** Every enable, disable, health check, invocation and cancel is
  an audited capability.

## 6. Commands actually run

```bash
npm run verify     # 13/13 steps PASS (see §7)
npx vitest run --project integration packages/core/src/node/worker-sandbox.integration.test.ts   # 6/6
npx vitest run --project integration apps/desktop/test/skills-core.integration.test.ts          # 12/12
node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/skills.integration.test.ts   # 7/7
```

## 7. Automated test results

`npm run verify` on the final SET 6 working tree passed **13/13 steps**:
format, lint, typecheck, unit, build, integration and E2E, secret scan, dev
smoke, Windows and Linux unpacked builds and their validation, and the
packaged launch.

| Suite                                           | Result                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| Unit (25 files)                                 | **242 passed**, 0 failed                                                    |
| Integration (25 files)                          | **191 passed**, 0 failed, 3 skipped (packaged tests, run as their own step) |
| — SET 6 E2E, real app (`skills.integration`)    | **7 passed**                                                                |
| — SET 6 Core in process (`skills-core`)         | **12 passed**                                                               |
| — worker sandbox (`worker-sandbox.integration`) | **6 passed**                                                                |
| — database (`skills.integration`)               | **2 passed**                                                                |
| Packaged app launch (Linux unpacked)            | **3 passed**                                                                |
| Secret scan (sources and build output)          | **368 files**, 0 findings                                                   |

The first full run failed on two SET 1 guard tests, and both were real:

- **Build output.** A comment in the sandbox bootstrap contained the text
  `require(`. That made the Core bundler inject a `node:module` shim (the
  same pitfall as in SET 4). The comment was reworded, and the test now
  lists the new, legitimate external `node:worker_threads`.
- **Gateway AT10.** `skills.executions` matched the "no exec capability"
  pattern. It only reads run history, and the test now names it with that
  reason.

### CI evidence (commit `63e539e`, run 36229785047)

| Job                                                                                                                                  | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Linux — format, lint, typecheck, unit, build, integration + E2E (incl. the SET 6 E2E tests), secret scan, dev smoke, packages        | success |
| Windows — unit, integration and E2E (incl. the SET 6 sandbox, in-process and E2E suites), NSIS installer, package validation, launch | success |
| Legacy Thursday — build and acceptance checks                                                                                        | success |

## 8. Manual tests

The E2E suite drives the real app through the interface; its screenshots were
reviewed:

| Screenshot                                             | What it shows                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| [Skill Center](set-06/01-skill-center.png)             | Every Skill with health; test fixtures labelled                     |
| [Unhealthy Skill](set-06/02-unhealthy-skill.png)       | Health detail, last check, "cannot run now", no test form           |
| [echo_text](set-06/03-echo-text.png)                   | Exact output of a real run, verification hint, history row by shape |
| [Disabled](set-06/04-disabled-skill.png)               | Disabled Skill refused with `SKILL_DISABLED`                        |
| [Timeout and cancel](set-06/05-timeout-and-cancel.png) | History of the slow fixture: CANCELLED and TIMEOUT                  |

The review found and fixed one bug: the Enabled switch did not move until
Core replied, so it looked as if it had ignored the click (the same pattern
as SET 3). It now shows the requested state (_Saving…_) right away, and
Core's reply replaces it.

## 9. Known limitations

- The sandbox isolates faults and stops work, but it is not a security
  boundary for hostile code. Third-party Skills wait for the plugin runtime
  (SET 15).
- A Skill that runs out of memory takes about 25 s to be stopped, because
  V8 tries garbage collection before giving up. Its timeout still applies.
- Only three low-risk read permissions can be granted until SET 7.
- Workflow steps can use Skills whose inputs are all text; plan inputs are
  text.
- Skills are registered by Core. There is no install or upload yet.

## 10. How to run

```bash
npm ci && npm run dev
```

Open _Skills_, then:

1. Filter or search the list.
2. Open `echo_text`, type some text and press Run.
3. Try Disable, and press _Check health now_.

## 11. Evidence and artifact paths

- `test-results/set-06/*.png` (written by the E2E suite; uploaded by CI)
- `docs/sets/set-06/*.png`

## 12. Acceptance tests

| #   | Test                                  | Status   | Evidence                                                                                                                                                                                                      |
| --- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Register valid Skill                  | **PASS** | In-process: a new Skill is registered, listed and runs (`reverse_text` → `retipuJ`); new versions are registered and listed newest first; the four internal Skills are registered at start                    |
| 2   | Reject invalid Skill                  | **PASS** | In-process: bad version, bad id, unknown permission, required field missing from properties, timeout out of range, no code, unknown metadata field → `SKILL_INVALID` with reasons, not listed; contract tests |
| 3   | Execute `echo_text` and verify output | **PASS** | In-process: exact output for Thai, emoji and spaces; E2E: typed in the Skill Center, output equal; history holds shape only and the database does not contain the text                                        |
| 4   | Timeout is handled                    | **PASS** | Sandbox: a busy loop is terminated at 300 ms; in-process + E2E: `fixture_slow` → TIMEOUT (`SKILL_TIMEOUT`) within the limit, no active runs left, Core answers the next call                                  |
| 5   | Cancellation is handled               | **PASS** | Sandbox: cancel stops a never-ending Skill; in-process + E2E: `skills.cancel` → CANCELLED, history CANCELLED, a second cancel returns false                                                                   |
| 6   | Disabled Skill cannot execute         | **PASS** | In-process: disabled → FAILED `SKILL_DISABLED`, state survives a restart; E2E: switched off in the Skill Center, run refused, shown as disabled; also after an app restart                                    |
| 7   | Undeclared permission is denied       | **PASS** | In-process: a Skill using `system.time` without declaring it → FAILED `PERMISSION_DENIED` (output discarded); a Skill needing `files.write` → `PERMISSION_NOT_GRANTED` naming SET 7                           |
| 8   | Broken Skill does not crash Core      | **PASS** | Sandbox: out of memory → crashed, sandbox still works; in-process: throws, not a function, syntax error, circular output, unhealthy → structured FAILED; `skill-registry` still HEALTHY, next run succeeds    |
| 9   | Invalid output converts to failure    | **PASS** | In-process: `{ text: 42, extra }` against a strict schema → FAILED `SKILL_OUTPUT_INVALID` with each problem named, output not returned                                                                        |
| 10  | Skill health appears accurately in UI | **PASS** | E2E: every item's health in the Skill Center equals `skills.list`; the broken fixture shows Unhealthy with Core's detail; _Check health now_ updates the last-check time to the one Core recorded             |

### SET 0–5 re-check (on the SET 6 code)

All earlier suites pass: `app`, `core-gateway`, `shell`, `build-output`,
`ai`, `ai-core`, `missions`, `missions-core`, `workflow`, `workflow-core` and
`packaged`. They were updated only where SET 6 changed facts:

- Skills is no longer _Coming later_ (5 unfinished screens instead of 6).
- `skill-registry` is a running Core service.
- `missions.step-types` also lists the registered Skills.
- `node:worker_threads` is an expected Core external.
- `skills.executions` is named in the capability guard.
