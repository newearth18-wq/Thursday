# SET 7 — Permission and Security Engine

- Status: **all 10 acceptance tests pass**, locally on Linux with
  `npm run verify` (13/13 steps) and in CI on Linux and Windows (`f6ec992`,
  run 36231978700). See §7. Tagged `jupiter-set-07-permission-and-security-engine`.
- SET 6 was re-checked first: green in CI on Linux and Windows (`63e539e`,
  run 36229785047) and tagged `jupiter-set-06-skill-system`. Its suites pass
  again on the SET 7 code; the changes are listed in §12.
- Environment of the recorded run:
  - Node.js 22.22.2, npm 10.9.7, Electron 44.4.5
  - Xvfb
  - GNOME Keyring, in a private, throwaway D-Bus session

## 1. Scope completed

### Capability catalogue

`PERMISSION_CATALOGUE` (`packages/contracts/src/permissions.ts`) holds 26
capabilities, including every one SET 7 names:

- `computer.open_app`, `computer.type`, `computer.read_screen`,
  `computer.manage_window`, `computer.delete_file`
- `browser.navigate`, `browser.download`, `browser.upload`,
  `browser.submit_form`
- `camera.read`, `microphone.listen`
- `memory.read`, `memory.write`
- `email.send`, `plugin.install`, `shell.execute`

The CRITICAL examples are capabilities of their own:

- bulk delete (`files.delete_bulk`)
- purchase (`payment.make`)
- install (`plugin.install`)
- system configuration (`system.configure`)
- private upload (`browser.upload`)
- shell (`shell.execute`)
- credential changes (`credentials.change`)

Each capability has:

- a risk level: LOW, MEDIUM, HIGH or CRITICAL
- a summary
- a consequence
- whether it can be undone
- what leaves the computer

### Answers

The person can answer ALLOW_ONCE, ALLOW_SESSION, ALWAYS_ALLOW or DENY. A
CRITICAL request offers only ALLOW_ONCE and DENY.

### Request

Each request records:

- what (capability and summary) and why (the reason)
- the exact target, and the scope (Mission, session)
- the risk
- the Mission, step and Skill; the requester (subject) and who started it
  (actor)
- data leaving the device
- the consequence, and whether it can be undone
- the answers offered, and its status

### Policy

- **Deny by default.** A grant matches on:
  - capability
  - requester (kind and id)
  - exact target (or a `*` prefix)
  - Mission
  - session
  - expiry
- **Grant lifetimes.**
  - ALLOW_ONCE is used up in the transaction that allows the action.
  - Session grants expire when Core starts in a new process.
  - Grants that last are listed and can be revoked.
- **Audit.** Every policy change and every decision is audited.
- **Only the person decides.** Only the person can answer or revoke, so
  content cannot create grants and plugins cannot elevate themselves.
- **Checkpoint.** An automation's HIGH actions need a fresh ALLOW_ONCE every
  time.
- **Jupiter's defaults.** Jupiter's own defaults are visible grants that can
  be revoked. A revoked default is never created again.

### Skills and Missions

- **Every use is checked.** A Skill's `context.use` goes through the engine
  every time.
- **Waiting.** A missing grant ends the run as `WAITING_APPROVAL` with a
  request.
- **Mission steps.**
  - A Mission step waits for the answer.
  - On allow, it runs again.
  - On deny, it fails with `PERMISSION_DENIED`.
  - After a Core restart, it asks again.
- **Approval checkpoints are separate.** They answer only
  `checkpoint.approval` steps.

### Interface

- **Global permission dialog.**
  - It shows every fact of the request.
  - It offers only the answers the request offers.
  - Deny has the first focus. There is no close button, and Escape does not
    answer.
  - It says when more requests are waiting.
- **Settings › Permissions.**
  - Pending requests.
  - Grants, with Revoke behind a confirmation, and a switch to show ended
    grants.
  - The audit trail.
- **Missions.** A notice for a step that is waiting for permission, and step
  text that says so.
- **Skill Center.** Shows "granted to its runs" or "asks for permission when
  used".
- **Activity feed.** Shows permission events.
- **Languages.** English and Thai.

## 2. Files added or changed

**Contracts**

- `permissions.ts` (new)
- `skills.ts`: `SkillPermissionInfo.granted`; `SKILL_PERMISSIONS` removed
- `plans.ts`: `PermissionName` pattern
- `events.ts`: 3 `permission.*` events, and the stream `permission`
- `capabilities.ts`: 6 `permissions.*` capabilities
- `missions.ts` (comment)
- `index.ts`, `contracts.test.ts`

**Core**

- `permissions/engine.ts` (new)
- `skills/registry.ts`: every use is checked, and a missing grant means waiting
- `skills/builtin.ts`: two fixture Skills and `createFixtureResources`
- `missions/manager.ts`:
  - permission waits
  - `permissionAnswered`
  - renewal at start
  - approve only for checkpoints
- `workflow/{catalogue,validate}.ts`
- `kernel/{core-kernel,capabilities}.ts`: service, default grants,
  handlers, `extraResources`
- `dispatch/dispatcher.ts` (comment)
- `ports.ts`, `index.ts`

**Database**

- `schema.ts` (migration 7)
- `repositories/permissions.ts` (new)
- `jupiter-database.ts`
- `test/permissions.integration.test.ts` (new)

**Desktop**

- `core/index.ts`: fixture resources in the test environment
- `main/services.ts`: `permission-engine` is no longer planned
- `main/security.ts` (comment)

**Renderer**

- New: `components/PermissionPrompt.tsx`, `views/PermissionsPanel.tsx`,
  `usePermissions.ts`, `permissionText.ts`
- `components/SecurityDialogs.tsx`: the request dialog, rebuilt
- `App.tsx`
- `views/{SettingsView,SkillsView,MissionWorkflow}.tsx`
- `components/ActivityTimeline.tsx`
- `errorText.ts`
- `i18n/{en,th}.ts`
- `styles.css`
- `components/components.test.tsx`

**Tests**

- New: `apps/desktop/test/permissions-core.integration.test.ts`,
  `apps/desktop/test/permissions.integration.test.ts`
- Updated: `core-harness.ts`, `skills-core`, `skills`, `workflow-core`,
  `workflow`, `core-gateway`, `shell`, and `packages/core/src/workflow/validate.test.ts`

**Docs**

- ADR 0008 (new)
- This report and `docs/sets/set-07/*.png`
- `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`

## 3. Architecture decisions

Recorded in [ADR 0008](../decisions/0008-permission-engine.md):

- **The catalogue is contract data.** Unknown capabilities are always denied.
- **One engine decides at the moment of use.** The resource, not the Skill,
  fixes the capability and the exact target.
- **The four answers have exact lifetimes.**
  - CRITICAL, and an automation's HIGH actions, only ever match a fresh
    ALLOW_ONCE.
  - A standing grant is preferred, so an unused ALLOW_ONCE is kept.
- **Only `user-interface` answers or revokes.** This is checked by the
  dispatcher and again by the engine. Defaults are visible grants.
- **Missions wait, and do not fail, for a missing permission.** A permission
  wait and an approval checkpoint cannot answer each other.
- **Grants end and are never deleted.** The audit trail is append-only and
  redacted. A target that contains a secret is stored redacted and never
  matches a grant (fail closed).

## 4. Database migrations

Migration 7 (`0007_permissions`) adds three tables:

- **`permission_requests`:** status and decision are checked; the session id
  is kept so that requests from earlier sessions can be expired.
- **`permission_grants`:** kind and state are checked, and a session grant
  requires a session id.
- **`permission_audit`:** entries in JSON; triggers refuse UPDATE and DELETE.

Existing data is untouched. The migration pipeline takes a backup before
migrating, as for every migration since SET 1.

## 5. Security implications

- **Deny by default.** Nothing with an effect happens without a matching
  grant.
  - Unknown capabilities are denied without asking.
  - A resource a Skill did not declare is denied without asking.
- **Content cannot change policy.** Instructions in a model answer, Skill
  input or other content have no path to the engine. Tested: a model answer
  naming the request id and "ALWAYS_ALLOW" changed nothing, and a Skill has
  no `permissions.*` resource.
- **Only the person decides.** Plugins, automations, runtimes, Core and the
  host cannot answer or revoke. A plugin with the same id as a Skill does not
  get the Skill's grant.
- **Critical actions are always asked**, with no Always allow.
- **No secrets are stored.** The reason and the audit entries are redacted,
  and a target with a secret is stored redacted. Tested: no secret in the
  audit trail, requests, grants or logs.
- **What is not built yet.** No capability with an effect outside Jupiter
  exists yet. Files, browser, computer control and email arrive in later
  SETs; the engine and the catalogue already govern them.

## 6. Commands actually run

```bash
npx tsc -p packages/core --noEmit
npm run typecheck && npm run lint
npx vitest run --project unit
npx vitest run --project integration apps/desktop/test/permissions-core.integration.test.ts
npx vitest run --project integration packages/database/test/permissions.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/permissions.integration.test.ts …
npm run test:integration
npm run verify
```

## 7. Automated test results

`npm run verify`: **13/13 steps PASS**:

- formatting, lint, strict typecheck
- unit tests: 25 files, 245 tests
- production build
- integration and Electron E2E: 28 files passed, 1 skipped (the Windows
  installer check on Linux); 214 tests passed, 3 skipped
- secret scan: 381 files, no credentials
- development-mode launch
- Windows and Linux unpacked builds, and their package validation
- packaged-app launch

The SET 7 suites within that run:

| Suite                                                    | Tests | What it runs                                                                                             |
| -------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/permissions-core.integration.test.ts` | 13    | Real kernel, dispatcher, SQLite, worker sandbox: AT1–AT10, plus Mission allow, deny and restart          |
| `apps/desktop/test/permissions.integration.test.ts`      | 6     | The real Electron app: dialog, answers, critical request, Settings › Permissions, revoke, audit, restart |
| `packages/database/test/permissions.integration.test.ts` | 4     | Store round-trip, sessions, grants end without deletion, audit trail cannot change                       |
| `components.test.tsx` (unit)                             | 2     | Dialog facts, focus and Escape; a critical request offers only Deny and Allow once                       |

### Fixed during the SET

- **Mission recovery.** The first full run showed that a Mission step waiting
  for a permission would stay waiting forever after a Core restart, because
  its request had expired. Recovery now runs such steps again, so they ask
  again. A test covers this.
- **Lint.** It found non-null assertions in the new tests; they were
  replaced with a checked helper.

### CI evidence (commit `f6ec992`, run 36231978700)

| Job                                                                                                                         | Result  |
| --------------------------------------------------------------------------------------------------------------------------- | ------- |
| Linux — format, lint, typecheck, unit, build, integration + E2E (incl. the SET 7 suites), secret scan, dev smoke, packages  | success |
| Windows — unit, integration and E2E (incl. the SET 7 in-process and E2E suites), NSIS installer, package validation, launch | success |
| Legacy Thursday — build and acceptance checks                                                                               | success |

## 8. Manual tests

The E2E suite drives the real app through the interface. Its screenshots
were reviewed:

| Screenshot                                                         | Shows                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Permission request](set-07/01-permission-request.png)             | Every fact of a MEDIUM request (what, target, risk, reason, requester, starter, Mission, step, consequence, undo, data), four answers |
| [Critical request](set-07/02-critical-request.png)                 | CRITICAL, cannot be undone, only Deny and Allow once, the "asked every time" note                                                     |
| [Settings › Permissions](set-07/03-permissions-settings.png)       | The person's grant and Jupiter's default grants, each with Revoke                                                                     |
| [Revoke confirmation](set-07/04-revoke-confirm.png)                | Revoke asks first, naming the requester, capability and target                                                                        |
| [Audit trail](set-07/05-audit-trail.png)                           | Checked, asked, answered, given, used and revoked entries, newest first                                                               |
| [Asks again after restart](set-07/06-asks-again-after-restart.png) | After an app restart the session permission has ended and the request is shown again                                                  |

While reviewing, the audit trail was first a seven-column table. It was
unreadable in the Settings column, so it became a list.

## 9. Known limitations

- **No real-world effects yet.** No capability acts outside Jupiter yet.
  Files, browser, computer control, camera, microphone, email and plugins
  come in later SETs. The only resources with an effect are the test
  fixtures' in-memory notes.
- **Expiry dates are not used yet.** Grants have an expiry field, but no
  answer sets one yet.
- **Waiting runs are not resumed.** A Skill run that needs a permission
  ends; it is not paused. Missions run the step again after the answer. A
  direct run (the Skill Center or `skills.invoke`) is run again by the
  person.
- **The Mission notice has no E2E test.** It is covered by the in-process
  Mission tests, but it is not screenshotted, because a Skill step that
  needs a permission requires a model-planned Mission.
- **Catalogue text is English.** The capability summaries and consequences
  come from Core as data, like Skill descriptions, and are shown in English
  in both languages.

## 10. How to run

```bash
npm ci && npm run dev
```

1. Open _Settings › Permissions_ to see Jupiter's default grants.
2. Revoke the one for _Get system time_.
3. Run that Skill from the Skill Center: Jupiter asks for permission.

To try the fixture Skills, set `JUPITER_ENV=test` and
`JUPITER_TEST_SKILL_FIXTURES=1`.

## 11. Evidence and artifact paths

- `test-results/set-07/*.png`: written by the E2E suite and uploaded by CI
- `docs/sets/set-07/*.png`

## 12. Acceptance tests

| #   | Test                                                | Status   | Evidence                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Undeclared capability is denied                     | **PASS** | In-process: an undeclared resource → FAILED `PERMISSION_DENIED`, nothing written, nobody asked; unknown capability → `PERMISSION_UNKNOWN`, nobody asked; declared but not granted → `WAITING_APPROVAL`, nothing written, one request with every field. E2E: the run waits and the dialog shows the request                    |
| 2   | Plugin cannot bypass                                | **PASS** | In-process: `permissions.decide`/`revoke` from plugin, automation, runtime, core and host actors → `PERMISSION_DENIED`, request still pending; the engine refuses a plugin actor directly; a plugin with a Skill's id does not get the Skill's grant                                                                          |
| 3   | DENY blocks                                         | **PASS** | In-process: DENY creates no grant, the next run asks again, nothing written, and the answered request cannot be answered again. E2E: Deny → request DENIED, no new grant                                                                                                                                                      |
| 4   | ALLOW_ONCE expires after use                        | **PASS** | In-process + E2E: first run SUCCESS (count 1), second run asks again; the grant is USED with `usedAt`                                                                                                                                                                                                                         |
| 5   | Session grant expires after restart                 | **PASS** | In-process: Core restart → session grant EXPIRED, pending request EXPIRED, next run asks. E2E: app restart → grant shown as Expired, the dialog asks again                                                                                                                                                                    |
| 6   | CRITICAL always prompts, no Always Allow            | **PASS** | In-process: offered `[ALLOW_ONCE, DENY]`; ALWAYS_ALLOW and ALLOW_SESSION refused (`PERMISSION_DECISION_NOT_OFFERED`); after one allowed run it asks again; standing grants never match; an automation's HIGH action needs a fresh ALLOW_ONCE each time. E2E: only Deny and Allow once, with the critical note                 |
| 7   | Persisted permission can be revoked                 | **PASS** | In-process: revoke → REVOKED, the next run asks; a revoked default (`get_system_time`) stays revoked and is not recreated after restart; a second revoke is refused. E2E: Revoke in Settings with confirmation, the grant disappears from the active list, and the next run asks                                              |
| 8   | Web/document instructions cannot change permissions | **PASS** | In-process: a model answer containing the pending request id and "ALWAYS_ALLOW" passed through a model step and a Skill step; requests and grants were unchanged. A Skill trying `context.use("permissions.decide")` → FAILED, request unchanged                                                                              |
| 9   | Target mismatch invalidates the grant               | **PASS** | In-process: a grant for `/home/me/summary.txt` does not allow `summary.txt.bak`, `other.txt` or the folder, nor another requester on the same target; a single-use grant for Mission A does not work in Mission B                                                                                                             |
| 10  | Every decision is in a sanitized audit trail        | **PASS** | In-process: evaluated, requested, decided, grant-created, grant-used and grant-revoked entries, newest first; a credential in the target and reason is absent from the audit trail, requests, grants and logs (`[REDACTED…]`); database test: UPDATE and DELETE on the trail are refused. E2E: the trail is shown in Settings |

### SET 0–6 re-check (on the SET 7 code)

All earlier suites pass in the same `npm run verify`. They were updated only
where SET 7 changed facts:

- **SET 6 AT7:** a Skill that declares `files.write` is no longer refused
  before it runs. It is asked for when it uses the permission.
  `grantable` became `granted`.
- **SET 5 AT10 and SET 6 workflow:** a plan is rejected for an _unknown_
  capability (`files.teleport`). Known capabilities are asked for at run
  time.
- **Skill lists:** the Skill lists include the two new test fixtures, whose
  health is UNKNOWN until a permission is given.
- **SET 1 AT6:** the page holds two live subscriptions, the event log and the
  permission prompt.
- **SET 2 AT5:** the Settings tabs include _Permissions_ (arrow-key order).
