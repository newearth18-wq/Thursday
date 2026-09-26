# ADR 0008 — One Permission Engine: deny by default, grants only from the person, an append-only audit trail

- Status: accepted (SET 7). Replaces ADR 0007 §3 (permissions granted by
  the invocation context).
- Date: 2026-09-26

## Context

SET 7 asks for a central, capability-based Permission Engine. It has risk
levels LOW, MEDIUM, HIGH and CRITICAL, and four answers: ALLOW_ONCE,
ALLOW_SESSION, ALWAYS_ALLOW and DENY.

**What a request shows.** Every request tells the person:

- what the action is and why it is needed
- the exact target and scope
- the risk
- the Mission, step and Skill involved, and who is acting
- what data leaves the computer
- the consequence, and whether it can be undone

**Policy rules.**

- Deny by default.
- A grant matches on capability, requester, target, Mission, session,
  expiry and constraints.
- ALLOW_ONCE is used exactly once.
- A session grant ends with the process.
- Persisted grants can be seen and revoked.
- Policy changes are audited.
- Content (a web page, a document) can never create a grant.
- Plugins cannot elevate themselves.
- CRITICAL actions ask every time and never offer ALWAYS_ALLOW. Examples:
  bulk delete, purchase, install, system configuration, private upload,
  shell and credential changes.

Before SET 7, Core granted a fixed set of low-risk read permissions to
Skills (ADR 0007 §3), and any other permission was refused outright.

## Decisions

### 1. The capability catalogue is data in the contracts

`PERMISSION_CATALOGUE` in `packages/contracts/src/permissions.ts` lists
every capability Jupiter knows. Each entry has:

- its risk
- a plain summary
- the consequence
- whether it can be undone
- what leaves the computer, if anything

The catalogue covers the capabilities SET 7 names:

- `computer.*`
- `browser.*`
- `camera.read` and `microphone.listen`
- `memory.*`
- `email.send`
- `plugin.install`
- `shell.execute`

It also covers the CRITICAL examples as their own capabilities:
`files.delete_bulk`, `payment.make`, `system.configure` and
`credentials.change`.

A capability that is not in the catalogue is always denied, without asking
anyone (`PERMISSION_UNKNOWN`). A plan that names one is rejected by the
validator.

Alternative considered: capabilities declared by whoever uses them.
Rejected, because a Skill or plugin could then invent a harmless-looking
low-risk name for a dangerous action.

### 2. One engine decides, at the moment of use

`PermissionEngine.check()` (`packages/core/src/permissions/engine.ts`) is
the only place that decides whether an action with an effect may happen.
The Skill Registry calls it every time a Skill uses a resource
(`context.use`).

The resource, not the Skill, fixes both the capability and the exact
target. A Skill cannot choose its own target.

An action is allowed only by an ACTIVE grant that matches all of these:

- the capability
- the requester: its kind (skill, plugin, automation, core) and its id
- the target: an exact match, or a grant target ending in `*` that is a
  prefix of the action's target
- the Mission, when the grant is tied to one
- the session, for ALLOW_SESSION
- the expiry

Without a matching grant, the use is refused. The engine then creates a
request the person answers. If the same request is already waiting, that
request is reused.

When several grants match, a standing grant is preferred, so an unused
ALLOW_ONCE is kept for the time it is the only one.

Health checks only look (`evaluateOnly`). They never ask the person and
never use up a single-use grant.

### 3. The four answers, and the checkpoint

| Answer        | Lifetime                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| ALLOW_ONCE    | Used up by the first action it allows, in the same transaction. Tied to the request's Mission.                |
| ALLOW_SESSION | Tied to the Core session id. A new id is made per Core process; at start, grants of any other session expire. |
| ALWAYS_ALLOW  | Stays until the person revokes it.                                                                            |
| DENY          | Creates nothing. The action does not happen.                                                                  |

**CRITICAL.** A CRITICAL request offers only ALLOW_ONCE and DENY
(`offeredDecisions`). Any other answer is refused
(`PERMISSION_DECISION_NOT_OFFERED`). Even a standing grant stored for a
CRITICAL capability never matches it.

**Automations.** The same applies to HIGH actions started by an
automation: this is the checkpoint for sensitive automated actions.

**Unanswered requests.** Requests left unanswered when Core stops expire at the next start; a
Mission step that was waiting for one runs again and so asks again.

### 4. Only the person can change policy

`decide` and `revoke` are allowed for the `user-interface` actor only.
This is enforced twice:

- by the dispatcher's capability policy
- by the engine itself (`PERMISSION_POLICY_LOCKED`)

These actors are all refused: plugins, automations, runtimes, Core and the
host.

Content never reaches the engine as an actor:

- A model's answer is text in a step's output.
- A Skill has no `permissions.*` resource.
- A request's `reason` is untrusted text, stored redacted and shown only as
  text.

So instructions in a page, a document or a model answer cannot create a
grant. They cannot answer or cancel a request either.

**Jupiter's defaults.** Jupiter's own default policy is a set of visible
grants, not an exception in code. Each built-in Skill may use the one
low-risk, read-only resource it exists for, and nothing more. These grants
are created once, by `core`. They are listed in Settings › Permissions and
can be revoked. A revoked default is never created again: the engine
checks whether that grant was ever given.

### 5. Missions wait for the person

A Skill step whose Skill needs a permission does not fail. Instead:

1. The Skill's run ends with `WAITING_APPROVAL` and a `PERMISSION_REQUIRED`
   envelope. The envelope carries the request id; nothing the Skill
   produced is used.
2. The step becomes WAITING (waiting for approval, detail "needs
   permission"). No attempt is counted.
3. When the other steps are done, the Mission moves to WAITING_APPROVAL.

The request names the Mission and the step.

**When the person answers:**

- **Allow:** the step returns to PENDING and runs again as a new attempt,
  which the new grant covers.
- **Deny:** the step fails with `PERMISSION_DENIED`, which is not
  retryable. A required step then ends the Mission.

**Keeping the two waits apart.** The approval checkpoint (`missions.approve`
and `missions.reject`) answers only `checkpoint.approval` steps. A
permission wait can be answered only through the permission request.

### 6. Storage and the audit trail

Migration 7 adds three tables:

- `permission_requests`
- `permission_grants`
- `permission_audit`

**Grants.** A grant ends as USED, EXPIRED or REVOKED, and is never
deleted, so its history stays visible.

**The audit trail.** It is append-only: SQLite triggers refuse UPDATE and
DELETE. It records every step of the process:

- evaluations: allowed, denied, asked
- requests
- answers
- grants created, used, expired or revoked
- expired requests
- refusals

Targets, reasons and details are passed through the redactor.

A target that contains a secret is stored and shown redacted. A grant for
it can then never equal the real target, so such an action asks every time
(fail closed).

## Consequences

- **Capabilities:**
  - `permissions.catalogue`, `permissions.requests`, `permissions.grants`
    and `permissions.audit` are reads.
  - `permissions.decide` and `permissions.revoke` are HIGH-risk, always
    audited, and allowed for the person only.
- **Events:** `permission.requested`, `permission.decided` and
  `permission.grant_ended`, on the streams `permission/requests` and
  `permission/grants`.
- **Service:** `permission-engine` is a running Core service. The Skill
  Registry needs it.
- **Interface:**
  - The person answers requests in a dialog that appears wherever they are.
    It shows every fact of the request, offers only the offered answers,
    has no close button, and gives Deny the first focus.
  - Settings › Permissions lists pending requests and grants (with Revoke),
    and the audit trail.
  - The Skill Center shows which permissions a standing grant covers.
- `SkillPermissionInfo.grantable` became `granted`. A Skill that declares a
  permission is no longer refused before it runs: it is asked for when it
  uses one.
- The test environment (`JUPITER_TEST_SKILL_FIXTURES=1`) adds two fixture
  Skills with a real, observable effect on an in-memory list:
  - `fixture_note_writer` (`memory.write`, MEDIUM)
  - `fixture_notes_clearer` (`files.delete_bulk`, CRITICAL)
