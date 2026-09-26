# ADR 0007 — Skills: typed definitions as data, one isolated worker per invocation, permissions granted by the context

- Status: accepted (SET 6). Extends ADR 0006 §2: registered Skills are workflow step types.
- Date: 2026-09-26

## Context

SET 6 asks for an executable Skill Registry. A Skill is a typed,
cancellable, permission-declared capability, not a prompt snippet. It has
metadata, input and output schemas, permissions, a timeout, a category and
a provider.

Every invocation and result must be validated. Timeout and cancellation
must terminate or isolate the work, not merely hide it. A broken Skill must
fail in a structured way without crashing Core. The invocation context, not
the Skill, grants capabilities. History must never hold secrets.

The Permission Engine (SET 7) and the plugin runtime (SET 15) do not exist
yet.

## Decisions

### 1. A Skill definition is data, with a JSON Schema subset for input and output

`SkillDefinition` and `SkillSchema` are defined in `packages/contracts/src/skills.ts`.
Both are strict: unknown fields are refused, never dropped. The schema
subset covers:

- types: object, string, number, integer, boolean, array
- `properties`, `required` and `additionalProperties`
- `items`, `enum`, length limits, numeric bounds and `maxItems`

Core enforces every keyword (`skills/schema-check.ts`).

Registration checks four things:

- the metadata matches the contract
- the schemas are consistent (required fields exist, limits suit their types, nesting depth is bounded)
- every permission is one Jupiter knows
- the Skill has code

Invalid Skills are refused with every reason (`SKILL_INVALID`).

Because definitions are data, they can be stored, shown in the Skill
Center, turned into a test form, and used as workflow step types.

Alternative considered: zod schemas inside the Skill's code. Rejected,
because they cannot be stored, displayed or checked without running the
code.

### 2. Each invocation runs in its own worker thread, inside a separate `vm` context

`WorkerSkillSandbox` (`@jupiter/core/node`) starts a worker thread for every
invocation, and a `vm` context inside it.

What the Skill gets:

- no environment variables
- no `require`, `process`, timers or network
- a memory limit
- string code generation disabled

The only way out is `context.use(resource, args)`. Values cross the
boundary as JSON copies, so the Skill never holds a reference to anything
outside.

How the work ends:

- Timeout or cancel terminates the thread. That stops the Skill's code even
  in a busy loop, so the work is really stopped, not just hidden.
- A Skill that throws, returns something that isn't JSON, is not a
  function, or exhausts its memory produces a `failed` or `crashed`
  outcome. The registry turns it into a structured failure, and Core
  carries on.

This isolates faults and stops work. It is not a hardened boundary against
hostile code. Built-in Skills are Jupiter's own code. Third-party code
waits for the plugin runtime (SET 15).

Alternatives considered:

- **In-process `async` functions with an `AbortSignal`.** Cancellation would
  only be cooperative, and a busy loop would freeze Core.
- **A child process per invocation.** Much slower to start. Nothing the
  built-in Skills do needs a separate process.

### 3. The invocation context grants permissions; resources check them on every use

Permissions are listed in `SKILL_PERMISSIONS` with their risk. Before SET 7,
Core grants only low-risk read permissions:

- `app.version.read`
- `system.time.read`
- `skills.read`

A Skill that declares any other permission (for example `files.write`) is
refused before it runs (`PERMISSION_NOT_GRANTED`, naming SET 7).

At run time each resource has a required permission:

- `app.version` needs `app.version.read`
- `system.time` needs `system.time.read`
- `skills.list` needs `skills.read`

A `use` is allowed only if the Skill declared the permission and the
invocation was granted it. Any other attempt is denied, and the execution
fails with `PERMISSION_DENIED`, whatever the Skill returns. The caller of
`skills.invoke` names the execution but cannot pass permissions.

### 4. The registry decides what may run, and validates the result

An invocation is refused, with a stored FAILED record, when the Skill is:

- disabled (`SKILL_DISABLED`)
- built for another runtime (`SKILL_INCOMPATIBLE`)
- unhealthy (`SKILL_UNHEALTHY`)
- needing an ungrantable permission (`PERMISSION_NOT_GRANTED`)
- given input that does not match its input schema (`SKILL_INPUT_INVALID`)

After a run, output that does not match the output schema turns the
execution into a failure (`SKILL_OUTPUT_INVALID`). The result carries:

- `status`: SUCCESS, FAILED, CANCELLED, TIMEOUT, WAITING_APPROVAL or WAITING_IDENTITY
- `output`
- a sanitized `error`
- `artifacts`
- `startedAt` and `completedAt`
- `verificationHints`

A repeated idempotency key is refused (`SKILL_DUPLICATE_INVOCATION`), so the
same request never runs twice.

**Health** is a real check: runtime compatibility, grantable permissions,
and a test run with the Skill's health input. The output must be valid, and
must equal the expected output where one is given. Every Skill is checked
when the registry starts, and on demand. Each check is stored with its time
and duration.

### 5. History keeps shape and size, never content

`skill_executions` (migration 6) stores for each invocation:

- the Skill and version
- the Mission (if any)
- the actor
- the status and error code
- the granted permissions
- the idempotency key
- the times

Input and output are stored only as a `ValueSummary`: type, size and field
names. A secret typed into a Skill therefore cannot end up in the database.
Error messages pass through the redactor.

Enabled state and last health check live in `skills` and survive restarts.
Invocations that a Core stop cut off are marked `SKILL_INTERRUPTED` at the
next start.

### 6. Registered Skills are workflow step types

The step catalogue of ADR 0006 now includes every registered Skill whose
inputs are all text. The planner offers them. The validator checks their
required inputs and declared permissions. The engine runs such a step
through `registry.invoke`, with:

- the Mission id
- the step attempt as the idempotency key
- the step's own timeout
- its cancel signal

The rule "any permission makes a plan unrunnable" is narrowed: permissions
Core can grant are allowed, and all others still wait for SET 7.

### 7. Test fixtures only in the test environment

Two Skills with known faults are provided for automated tests:

- `fixture_broken_health`, which always fails
- `fixture_slow`, which never finishes

They are registered only when the environment is `test` and
`JUPITER_TEST_SKILL_FIXTURES=1`. Their provider is `test-fixture`, and the
interface labels them as such.

## Consequences

- Migration 6 adds `skills` and `skill_executions`, with a partial unique
  index on `(skill_id, idempotency_key)`.
- New capabilities:
  - `skills.list`, `get`, `versions`
  - `enable`, `disable`, `health-check`
  - `invoke`, `cancel`, `executions`

  All changes and invocations are audited.

- `skill-registry` is a running Core service.
- The Skills screen is built, and no longer _Coming later_.
- `SkillId` now also accepts ids like `echo_text`.
