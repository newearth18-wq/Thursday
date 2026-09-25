# SET 1 — Core architecture, IPC, events and database

- Status: **all 10 acceptance tests pass locally** (Linux x64 container, Xvfb).
  CI (Linux and Windows) runs on the pull request.
- SET 0 re-checked: green in CI before SET 1 started, and its 10 acceptance
  tests pass again on the SET 1 code (§12).
- Checkpoint tag once accepted: `jupiter-set-01-core-architecture`
- Environment of the recorded run: Node.js 22.22.2, npm 10.9.7, Electron 44.4.5
  (Chromium 152.0.7977.130, Node 24.21.0, SQLite 3.53.4).

## 1. Scope completed

Following the Master Prompt's SET 1 work list:

1. **Versioned schemas** (`packages/contracts`, contract v1): request envelopes
   for commands and queries, results, errors, progress, domain events, audit
   records, the capability catalogue, the gateway messages and the host↔Core
   protocol.
2. **Central validation**: the host gateway validates sender, size and envelope;
   the Core dispatcher validates the capability, actor, payload and output.
   Unknown or malformed messages are rejected with typed errors and audited.
3. **Correlation model**: `requestId` (= correlation id), `missionId`,
   `executionId`, actor (assigned by the receiving side), timestamps, and an
   `AbortSignal` for cancel, timeout and shutdown.
4. **Event bus**: per-stream gap-free sequences + global order, persistence
   inside the change's transaction, after-commit delivery, replay-safe
   subscriptions, reconnection by cursor, drop notification for failing
   subscribers.
5. **SQLite** (`packages/database`, `node:sqlite`): checksummed migrations,
   `BEGIN IMMEDIATE` transactions with savepoints, foreign keys, WAL,
   `synchronous=FULL`, verified online backups (also before every upgrade),
   repository interfaces.
6. **Tables**: `schema_migrations`, `settings`, `event_streams`, `events`,
   `audit_log`, `service_health`.
7. **Error categories**: validation, permission, identity, configuration,
   provider, timeout, cancellation, dependency, unsupported, internal.
8. **Startup, shutdown and crash isolation**: Jupiter Core runs in an Electron
   utility process, supervised by the host (ready deadline, heartbeat, restart
   with back-off, graceful stop then kill).
9. **Capability dispatcher**: deny-by-default authorization per actor type,
   timeouts, cancellation, audit. Host-privileged functions are dispatcher
   capabilities with `provider: host`.
10. **Diagnostics view**: build, host and Core process, every service with its
    error, database state (schema, migrations, integrity, counts, backups with a
    working _Back up now_), sanitized recent errors, a live event log, log
    location with _Open log folder_, and the dispatcher's capabilities.

Not built (later SETs, shown as _Coming later_): Mission Manager, Workflow
Engine, Skill Registry, Permission Engine with approvals, Identity Gateway,
Model Router, Artifact Manager, Agent/Browser/Plugin runtimes, editable
settings.

## 2. Files added or changed

| Area           | Files                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts      | `packages/contracts/src/{actor,request,progress,events,audit,settings,database,capabilities,gateway,core-protocol,channels}.ts` (v1; `ipc.ts` removed)                                                         |
| Core kernel    | `packages/core/src/{ports.ts,events/event-bus.ts,dispatch/dispatcher.ts,kernel/capabilities.ts,kernel/core-kernel.ts}`, `logging/logger.ts` (`forward`)                                                        |
| Database (new) | `packages/database/src/{jupiter-database,migrations,schema,transactions,rows}.ts`, `src/repositories/*`, `test/*` (6 integration suites, v1 fixture, crash writer), `README.md`                                |
| Host           | `apps/desktop/src/main/{index,gateway,core-process,core-launcher,host-capabilities,app-protocol,services,window}.ts` (`ipc.ts` removed), `src/shared/{bridge,csp}.ts`, `src/preload/index.ts`                  |
| Core entry     | `apps/desktop/src/core/index.ts`, `electron.vite.config.ts` (second main entry)                                                                                                                                |
| Renderer       | `api.ts`, `useRuntime.ts`, `useEventLog.ts`, `format.ts`, `App.tsx`, `views/{Home,Diagnostics,Settings}View.tsx`, i18n (en, th), styles                                                                        |
| Tests          | unit: `gateway`, `core-process`, `host-capabilities`, `app-protocol`, `event-bus`, `dispatcher`, contracts; E2E: `core-gateway.integration.test.ts` (new), `app.integration.test.ts`, build and packaged tests |
| Testing tools  | `packages/testing/src/packaged.ts` (`launchPackagedJupiter`)                                                                                                                                                   |
| Scripts        | `validate-package.mjs` (requires `core.js`), `dev-smoke.mjs` (v1 expectations + Core started)                                                                                                                  |
| Docs           | `docs/ARCHITECTURE.md`, ADR `0002`, `SECURITY.md`, `README.md`, `AGENTS.md`, this report                                                                                                                       |

## 3. Architecture decisions

Recorded in [ADR 0002](../decisions/0002-core-process-gateway-and-sqlite.md)
and described in [ARCHITECTURE.md](../ARCHITECTURE.md):

- Core in a **utility process** (crash and hang isolation; Core has no window,
  renderer or shell access — its bundle imports four Node.js built-ins only).
- **One gateway, six channels**; all commands and queries go through one
  `request` channel to the Core dispatcher. `gateway-status` and
  `retry-service` are served by the host because they must work while Core is
  down; retry is audited.
- Interface served from **`jupiter://app`** instead of `file://`.
- **`node:sqlite`**: no native module to build, rebuild or sign.
- Events: **per-stream sequences, commit-then-deliver, cursor reconnect**.

## 4. Database migrations

| Version | Name                            | Creates                                                                              |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| 1       | `0001_settings_and_events`      | `settings`, `event_streams`, `events` (+ foreign key, append-only triggers, indexes) |
| 2       | `0002_audit_and_service_health` | `audit_log` (+ append-only triggers), `service_health`                               |

`schema_migrations` records version, name, sha256 checksum and time. A
database from a newer build, with a modified migration, or failing
`quick_check` is refused and left untouched. An existing database is backed up
(`backups/jupiter-<time>-pre-migration.db`) before an upgrade.

## 5. Security implications

- The renderer's reach is exactly seven frozen bridge functions over six
  channels. It cannot choose its actor, cannot name a host function directly,
  cannot send code (functions do not cross the bridge; payloads are plain data
  under 256 KiB), cannot read files (`file://` blocked, protocol handler serves
  only the interface folder) and receives no secrets.
- Every refusal is audited; so is every state-changing or host capability call.
- A second renderer given the same preload is denied on every channel (sender
  must be the Jupiter window's top frame on `jupiter://app`).
- CSP: `default-src 'none'`, `script-src 'self'`, `connect-src 'none'`, no
  frames or workers — as header and meta tag.
- No remote module (removed from Electron; `@electron/remote` not installed).
- Table of controls and their tests: [SECURITY.md](../../SECURITY.md).
- Still missing by design: user approvals (Permission Engine, SET 7), secure
  credential storage (SET 3), Electron fuses (SET 23).

## 6. Commands actually run

Baseline, before any SET 1 change: the SET 0 commit `918579f` was green in CI
on all three jobs (Linux gates, tests and packages; Windows installer, E2E and
packaged launch; legacy Thursday), run 36128645246, and the working tree was
clean.

```bash
# final, from a clean tree (node_modules, out/, dist/, test-results/ deleted)
npm ci                                                    # 0 vulnerabilities
npm audit                                                 # found 0 vulnerabilities
npm run verify                                            # 13/13 steps PASS
cd legacy/thursday-browser && npm ci && npm run build && xvfb-run -a npm run test:acceptance   # 24/24 + 8/8
# repeated runs to rule out flakiness in the new tests
for i in 1..6: vitest run apps/desktop/test/packaged.integration.test.ts   # 6/6 PASS
```

## 7. Automated test results

| Suite                                      | Result                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Unit (Vitest, 18 files)                    | **156 passed**, 0 failed                                                                 |
| Integration (12 files)                     | **56 passed**, 0 failed, 3 skipped — the packaged-app tests, run in their own step below |
| Packaged-app launch (Linux unpacked build) | **3 passed**, 0 failed                                                                   |
| Development-mode smoke                     | **5/5 checks** passed (includes "Jupiter Core started in its utility process")           |
| Secret scan (sources + build output)       | **261 files**, 0 findings                                                                |
| Windows package validation                 | **6/6 checks** passed (unpacked build; `app.asar` has `out/main/index.js` and `core.js`) |
| Linux package validation                   | **5/5 checks** passed                                                                    |
| Legacy Thursday acceptance                 | **24/24 + 8/8** passed (unchanged code, own lockfile)                                    |

New in SET 1: 8 real-Electron E2E tests in `core-gateway.integration.test.ts`
(AT1–AT4, AT6, AT10, Core crash policy, database failure), 25 database
integration tests on real SQLite files (including two that SIGKILL a writer
process), unit tests for the gateway (9), Core process supervision (11), host
capabilities (3), event bus, dispatcher and contracts.

## 8. Manual tests

Screenshots of the built app under Xvfb at 1366×768:
[Home](set-01/home-en.png), [Diagnostics](set-01/diagnostics-en.png),
[database panel after _Back up now_](set-01/diagnostics-database-en.png),
[Core crash reported while the window keeps working](set-01/core-crashed-en.png),
[recent errors and live events after the restart](set-01/diagnostics-after-crash-en.png),
[database cannot be opened (Thai)](set-01/database-failed-th.png).

Found and fixed through these: switching views kept the previous view's scroll
position, so after scrolling Diagnostics the crash notice on Home was off-screen
(now reset, with an E2E assertion).

## 9. Known limitations

- Service error messages (the text inside an `ErrorEnvelope`) are English in
  both languages; the surrounding interface is translated. Localised error
  text belongs with the language work of SET 2.
- Settings are still read-only in the interface (SET 2). `settings.update`
  exists as a capability and is tested, for `logging.level` only.
- Authorization is by actor type (user interface, host, core, …); per-action
  user approval is the Permission Engine (SET 7).
- `node:sqlite` is not yet marked stable in Node.js 24; it is wrapped by
  `packages/database` (ADR 0002).
- The NSIS installer is built and launched by the Windows CI job, not locally
  (electron-builder needs Wine on Linux).
- The checkpoint tags could not be pushed from the development environment
  (branch pushes only); see the final report.

## 10. How to run

```bash
npm ci
npm run dev                  # development
npm run build && npm start   # production build, unpackaged
npm run verify               # all gates
```

To see crash isolation: open Diagnostics, note the Core process id, end that
process (Task Manager on Windows, `kill -9 <pid>` elsewhere). The window stays
up, Home shows _Jupiter Core — Failed_ with the reason, and Core is back within
seconds; Diagnostics lists the crash under recent errors.

To see a database failure: quit Jupiter, create a **folder** named `jupiter.db`
in the data folder, start Jupiter (Database — Failed, everything else works),
remove the folder and press **Retry**.

## 11. Evidence and artifact paths

- `test-results/package-validation-win.json`, `test-results/package-validation-linux.json`
- `apps/desktop/dist/win-unpacked/Jupiter.exe`, `apps/desktop/dist/linux-unpacked/jupiter`
- `docs/sets/set-01/*.png`
- CI artifacts on the pull request: `jupiter-windows-installer`, `jupiter-linux-evidence`

## 12. Acceptance tests

### SET 1

| #   | Test                                                                    | Status   | Evidence                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Valid typed IPC request returns a correlated result                     | **PASS** | E2E AT1: `requestId` = `correlationId` in the reply; output matches its schema; the command's audit record and event carry the same id; host `gateway.request`/`response` and Core `capability.succeeded` log lines share it             |
| 2   | Invalid schema is rejected                                              | **PASS** | E2E AT2: 10 malformed requests (version, id, extra field, non-object, bad id, kind, payload type, unknown setting, extra payload field, 300 KiB) each get their typed code; a function payload cannot be sent; state unchanged           |
| 3   | Unknown channel is inaccessible                                         | **PASS** | E2E AT3: Electron's handler table holds exactly the six `jupiter:v1:*` channels (plus Electron internals); no listeners; the bridge has 7 frozen keys and cannot be altered; unknown capabilities → `UNKNOWN_CAPABILITY`                 |
| 4   | Unauthorized renderer request is denied                                 | **PASS** | E2E AT4: the UI asking for host-only `runtime.report-host-status` → `PERMISSION_DENIED`; a second renderer with the same preload → `IPC_UNTRUSTED_SENDER` on 4 channels; all 5 denials in the audit log                                  |
| 5   | Event ordering is stable within one Mission                             | **PASS** | DB integration: 3 Missions × 60 events from interleaved concurrent publishers are gap-free and in order, live and after reopening; a disconnected subscriber resumes without gaps or duplicates                                          |
| 6   | UI refresh reconnects without duplicating persistent events             | **PASS** | E2E AT6: two reloads on Diagnostics; an event created afterwards appears exactly once; no duplicate sequences; one active subscription; stored log unique and ordered; old subscriptions released                                        |
| 7   | Migration runs on a new database and upgrades a previous schema fixture | **PASS** | DB integration: new database → v2 in WAL with foreign keys; committed v1 fixture → backed up, migrated to v2, every row kept; newer, modified, failing and non-database files refused and untouched                                      |
| 8   | Interrupted transaction does not corrupt the database                   | **PASS** | DB integration: a separate process is SIGKILLed inside a transaction and half-way through a migration; the file passes `integrity_check`, committed data is intact, nothing partial remains, the migration completes on next start       |
| 9   | Service crash is reported without crashing the entire app               | **PASS** | E2E: Core SIGKILLed 4 times → FAILED `CORE_CRASHED` with next step, window alive, requests fail fast with `CORE_UNAVAILABLE`, automatic restart ×3, then Retry; crashes persisted. Database failure → FAILED, rest works, Retry recovers |
| 10  | Renderer cannot read OS credentials or arbitrary files                  | **PASS** | E2E AT10: `fetch`/XHR/`window.open` of `file://` blocked; traversal on `jupiter://` → 404; no file or credential capability exists; credential-shaped environment variables appear in no reply                                           |

### SET 0 re-check (on the SET 1 code)

| #   | Test                                                        | Status   | Evidence                                                               |
| --- | ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| 1   | Clean install from lockfile                                 | **PASS** | `npm ci` from a deleted `node_modules`; `npm audit`: 0 vulnerabilities |
| 2   | Development mode launches the app                           | **PASS** | `npm run test:dev-smoke` 5/5                                           |
| 3   | Production build succeeds                                   | **PASS** | `npm run build`; 6 build-output tests                                  |
| 4   | Windows installer or validated unpacked build               | **PASS** | `validate-package --platform win` 6/6; installer on Windows CI         |
| 5   | Lint and strict typecheck                                   | **PASS** | 0 errors, 0 warnings                                                   |
| 6   | Test runner passes a real smoke test                        | **PASS** | 156 unit + 56 integration + 3 packaged                                 |
| 7   | Renderer has no direct Node integration                     | **PASS** | E2E globals, web preferences, CSP; lint rule; build-output scan        |
| 8   | No hardcoded secrets                                        | **PASS** | sources, build output and both packaged apps: 0 findings               |
| 9   | Version from build metadata                                 | **PASS** | E2E compares UI, gateway status and main with `package.json`           |
| 10  | Service startup failure gives a truthful, recoverable error | **PASS** | E2E: blocked log folder → FAILED with the real error, Retry recovers   |
