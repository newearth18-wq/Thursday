# Jupiter architecture — after SET 6

This document describes what exists after SET 6 (Skill System) on top of
SET 5 (Planner and Workflow Engine), SET 4 (Mission System), SET 3 (AI providers, Model Router and Chat), SET 2 (product shell, design system and accessible
interface), SET 1 (Core architecture, IPC, events and
database) and the SET 0 foundation. Later SETs extend it;
each section says what is deliberately not here yet. Decisions and their
alternatives are in [docs/decisions/](decisions/).

## Monorepo

npm workspaces, one lockfile, strict TypeScript everywhere.

```text
apps/desktop          ── depends on ──▶ contracts, core, database, providers, security, ui   (bundled, nothing external at runtime)
packages/providers    ── depends on ──▶ contracts, core, zod   (adapters; installed only in the Core entry)
packages/database     ── depends on ──▶ contracts, core            (node:sqlite, built into Electron's Node.js)
packages/core         ── depends on ──▶ contracts, security, zod
packages/security     ── no dependencies (patterns file is dependency-free on purpose)
packages/contracts    ── depends on ──▶ zod
packages/ui           ── depends on ──▶ @fontsource fonts (React is a peer)
packages/testing      ── depends on ──▶ playwright            (tests only; also provider protocol test servers)
services/*, plugins/  placeholders: no code, labelled Coming later
legacy/thursday-browser                   separate npm project, own lockfile, not a workspace
```

Workspace packages are consumed as TypeScript source (`exports` point at
`src/*.ts`). electron-vite bundles them into four outputs — host main
(`out/main/index.js`), Jupiter Core (`out/main/core.js`), preload and
renderer — so a packaged Jupiter ships **no `node_modules`** and no native
modules (SQLite is `node:sqlite`, part of Electron's Node.js). The package
validator checks this.

Domain code (`contracts`, `core`, `database`) does not import Electron or
React. The Core bundle imports only `node:crypto`, `node:fs`, `node:path` and
`node:sqlite` — a build-output test enforces it.

## Process model

```text
┌─────────────────────────────────────────────┐
│ Renderer (React 19) — jupiter://app#/<view> │  sandboxed, contextIsolation, no Node.js,
│ 12 destinations: Home · Chat · Missions ·   │  strict CSP, validates every reply and push
│   AI Models · Settings · Diagnostics work;  │
│   6 are Coming later                        │
└───────────────────┬─────────────────────────┘
                    │ window.jupiter — 7 frozen functions (contract v1)
┌───────────────────┴─────────────────────────┐
│ Preload (sandboxed, CommonJS)               │  6 fixed invoke channels + 1 push channel
└───────────────────┬─────────────────────────┘
                    │ ipcRenderer.invoke / on   (jupiter:v1:*)
┌───────────────────┴─────────────────────────┐
│ Host — Electron main                        │
│  jupiter:// protocol · window · security    │
│  Host gateway (sender check, size, schema,  │
│    actor assignment, ownership, audit)      │
│  Host services: build-metadata, environment,│
│    storage, logging, secure-storage,        │
│    core (supervisor)                        │
│  Credential vault (safeStorage: DPAPI /     │
│    Keychain / Secret Service), host ops     │
│    host.credentials.* for Core only         │
│  Host capabilities (logs.reveal,            │
│    notifications.status/show) — run only    │
│    when Core's dispatcher asks              │
│  Window state (window-state.json)           │
└───────────────────┬─────────────────────────┘
                    │ MessagePort (utility process), versioned protocol,
                    │ schema-validated both ways, heartbeat
┌───────────────────┴─────────────────────────┐
│ Jupiter Core — Electron utility process     │
│  Capability dispatcher (validate, authorize │
│    deny-by-default, timeout, cancel, audit) │
│  Event bus (per-stream order, persistence,  │
│    replay-safe subscriptions)               │
│  Services: database · event-bus ·           │
│    model-router · mission-manager ·         │
│    capability-dispatcher                    │
│  Providers + router + chat; adapters reach  │
│    the network only via the guarded         │
│    transport (Local only, no redirects)     │
│  SQLite (WAL, FULL sync, FKs, STRICT tables,│
│    append-only events and audit, backups)   │
└─────────────────────────────────────────────┘
   Workflow Engine, Skill Registry, Permission Engine,
   Identity Gateway, Artifact Manager, Agent/Browser/Plugin
   runtimes: COMING_LATER (SET 5–15). They will register capabilities with
   the dispatcher and publish on the event bus; nothing reaches the host
   without going through the dispatcher.
```

Why Core is a separate process: a crash, a hang or a runaway query in Core
cannot take down the window or the host. The host reports it, fails pending
requests truthfully, and restarts Core (see _Crash isolation_).

## Contract v1 (`packages/contracts`)

All shapes crossing a process or trust boundary are zod schemas, validated on
both sides.

| Schema                             | Purpose                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequestEnvelope`                  | `v`, `requestId` (UUIDv7, chosen by the caller), `kind` (`command` \| `query`), `type` (capability id), `payload`, `missionId`, `executionId`, `sentAt`. Strict: unknown fields are rejected. |
| `ResultEnvelope`                   | `v`, `requestId`, `correlationId`, `ok`, `data` or `error` (`ErrorEnvelope`), `completedAt`                                                                                                   |
| `ErrorEnvelope`                    | code, category (validation, permission, identity, configuration, provider, timeout, cancellation, dependency, unsupported, internal), message, user action, retryable, reference              |
| `ProgressUpdate`                   | request id, stage, measured `completed`/`total` (both or neither), unit, message                                                                                                              |
| `DomainEvent`                      | discriminated by `type`, with per-type payload schemas; stream, stream and global sequence (persistent events only), correlation/causation ids, actor, Mission/execution ids                  |
| `AuditEvent`                       | actor, capability, target, decision (ALLOWED/DENIED/REJECTED), risk, outcome, redacted metadata                                                                                               |
| `Capabilities`                     | the catalogue: kind, input schema and output schema for each capability id                                                                                                                    |
| `GatewayStatus`, `RendererMessage` | what the host sends the renderer                                                                                                                                                              |
| `HostToCore`, `CoreToHost`         | the host↔Core protocol (versioned separately)                                                                                                                                                 |

The **correlation model**: the request id is the correlation id. The gateway
assigns the **actor** from the sender (never from the message); Core gives the
capability handler a context with request id, correlation id, Mission and
execution ids, actor, received time and an `AbortSignal` (cancel, timeout or
shutdown). Every log line, audit record and event produced by the request
carries the correlation id — across both processes.

## IPC surface (renderer ↔ host)

| Invoke channel              | Served by                         | Purpose                                              |
| --------------------------- | --------------------------------- | ---------------------------------------------------- |
| `jupiter:v1:request`        | Core dispatcher (via the gateway) | every command and query                              |
| `jupiter:v1:cancel`         | gateway → Core                    | cancel a request the same window started             |
| `jupiter:v1:subscribe`      | gateway → Core event bus          | live events with replay after a sequence             |
| `jupiter:v1:unsubscribe`    | gateway → Core                    | close a subscription the same window owns            |
| `jupiter:v1:gateway-status` | host                              | app info, runtime status, Core process state         |
| `jupiter:v1:retry-service`  | host (audited)                    | Retry on a failed service — must work with Core down |

Push channel `jupiter:v1:message` carries `gateway-status`, `event`,
`progress` and `subscription-ended` messages, each validated before sending
and only to the window that owns the request or subscription. No other channel
is registered, so any other name is unreachable.

For each call the gateway: checks the sender is the Jupiter window's top frame
on `jupiter://app`; limits size (256 KiB of plain data — functions and other
non-cloneable values cannot cross at all); validates the envelope; refuses
duplicate request ids and more than 64 in-flight requests per window; assigns
the actor; forwards to Core; audits every refusal. A window that reloads,
navigates, crashes or closes has its requests cancelled and subscriptions
closed.

## Capability dispatcher (Core)

Every command and query — including host-privileged ones — is a registered
capability with: kind, input and output schemas, allowed actor types, risk
level, required services, timeout, audit policy and provider (`core` or
`host`). Dispatch order: envelope → known capability → kind matches →
**actor allowed (deny by default)** → not a duplicate → capacity → payload
schema → required services available → run with timeout and cancellation →
output schema. It never throws; every outcome is a typed `ResultEnvelope`.
Denials and rejections are always audited. Capabilities that change state or
reach the host (`settings.update`, `database.backup`, `host.logs.reveal`,
`runtime.report-host-status`) are audited on every call with their outcome;
read-only queries are audited only when refused.

Capabilities: `diagnostics.snapshot`, `diagnostics.report-renderer-error`,
`settings.list`, `settings.update`, `events.list`, `audit.list`,
`database.backup`, `host.logs.reveal`, `host.notifications.status` and
`host.notifications.show` (host provider; the last two added in SET 2), and
`runtime.report-host-status` (host actor only). There is no capability that
reads files, credentials or runs commands.

## Event bus

- **Streams and order.** Each event belongs to a stream (`system/core`,
  `settings/<key>`, `mission/<id>`, …). Persistent events get a gap-free stream
  sequence and a global sequence in the same transaction, so order within one
  Mission is total and stable, also after restarts.
- **Persistence.** Persistent events are appended inside the caller's
  transaction and delivered only after it commits; a rolled-back transaction
  publishes nothing. Transient events are delivered immediately and never
  stored. `events` and `audit_log` are append-only (triggers refuse UPDATE and
  DELETE).
- **Subscriptions.** A subscriber asks for events after a sequence (or the
  latest N); replay and live delivery are joined without gaps or duplicates
  (per-subscriber high-water mark). If the requested sequence is too old the
  receipt says `truncated` and the client resets. A subscriber that keeps
  failing is dropped and told so.
- **Reconnection.** The renderer keys events by global sequence and resumes
  after the last one it saw — after a Core restart, or from the latest events
  after a page reload (the old subscription is released by the gateway).

## Persistence (`packages/database`)

- `node:sqlite` with `journal_mode=WAL`, `synchronous=FULL`, foreign keys on
  (verified at open), `STRICT` tables and CHECK constraints.
- Tables: `schema_migrations`, `settings`, `event_streams`, `events`,
  `audit_log`, `service_health`; since migration 3 (SET 3) `ai_providers`
  (credential id and fingerprint only — never a key), `ai_models`,
  `chat_conversations` and `chat_messages`; since migration 4 (SET 4)
  `missions`, `mission_executions`, `mission_steps` and the append-only
  `mission_transitions`, `mission_errors`, `mission_verifications` and
  `mission_artifacts`; since migration 5 (SET 5) the append-only
  `mission_plans`, `mission_plan_rejections` and `mission_step_attempts`,
  with `mission_executions` and `mission_steps` rebuilt for workflows (a
  migration that rebuilds tables runs with foreign keys off and must pass
  `PRAGMA foreign_key_check` before it commits); since migration 6 (SET 6)
  `skills` (definition, enabled state, last health check per version) and
  `skill_executions` (shape and size of input and output only, never content;
  unique idempotency key per Skill); later SETs add their own tables (see
  each SET's section; migration 11, SET 11: `memories`, `memory_embeddings`,
  `memory_decisions`).
- **Migrations** are ordered, checksummed (sha256 of version, name and SQL) and
  each applied atomically. Opening refuses a database newer than the app, a
  modified or missing migration, and runs `quick_check` first (a corrupt file
  is reported and never changed). An existing database is backed up before it
  is migrated.
- **Transactions**: `BEGIN IMMEDIATE`, nested work as savepoints, after-commit
  hooks, rollback on any error; a crash mid-transaction leaves the last
  committed state (WAL).
- **Backups**: online SQLite backup to a `.partial` file with progress,
  integrity and schema check of the copy, then an atomic rename. Only Jupiter's
  own `jupiter-<time>-<reason>.db` files are ever pruned (10 kept).
- Repository interfaces (`EventStore`, `SettingsStore`, `AuditStore`,
  `ServiceHealthStore`, `TransactionRunner`) live in `packages/core/src/ports.ts`;
  Core depends on those, not on SQLite.

## Crash isolation, startup and shutdown

- **Startup**: host services start in order (build metadata, environment,
  storage, logging, core). The `core` service forks the utility process, sends
  `init`, and waits (30 s) for `ready`. Inside Core the database, event bus and
  dispatcher start under their own supervisor. A failed service is FAILED with a
  real `ErrorEnvelope` and a working Retry; everything that does not need it
  keeps working (`DEPENDENCY_UNAVAILABLE` for the rest).
- **Crash of Core**: pending requests are answered with `CORE_UNAVAILABLE`,
  subscriptions end, the `core` service becomes FAILED `CORE_CRASHED` and the
  window stays up. Core is restarted automatically after 1 s, 3 s and 10 s; a
  fourth crash within five minutes waits for Retry. The new Core records
  `core.crashed` and an `error.recorded` event. A Core that stops answering the
  15 s heartbeat within 10 s is ended and handled the same way.
- **Shutdown**: `shutdown` message → Core stops services, checkpoints and closes
  the database → exits; killed after 8 s if it does not. The whole app quits
  within 12 s.

## Environments

|                 | development                                           | test                       | production                                   |
| --------------- | ----------------------------------------------------- | -------------------------- | -------------------------------------------- |
| Chosen when     | unpackaged + dev server, or `JUPITER_ENV=development` | `JUPITER_ENV=test`         | packaged or previewed builds (default)       |
| Data folder     | `Jupiter (Development)`                               | explicit `--user-data-dir` | `Jupiter`                                    |
| Log level       | debug                                                 | debug                      | info (the `logging.level` setting overrides) |
| DevTools        | allowed                                               | no                         | no                                           |
| Renderer source | loopback dev server                                   | `jupiter://app`            | `jupiter://app`                              |

The database lives at `<data folder>/jupiter.db`, backups in
`<data folder>/backups/`.

## Logging

JSON Lines as in SET 0 (`ts`, `level`, `event`, `message`, `component`,
`sessionId`, `correlationId`, redacted `data`), rotated at 5 MB × 5 files. Core
sends its entries to the host over the Core port; the host re-redacts them and
owns the files, so one file holds both processes under one session id.

## Product shell (SET 2)

Decisions and alternatives: [ADR 0003](decisions/0003-product-shell-preferences-and-window-state.md).

- **Destinations.** Twelve screens, each at its own address
  (`#/home`, `#/chat`, … `#/diagnostics`); an unknown address opens Home.
  `destinations.ts` states for each one whether it works and which SET builds
  it. Home (Command Center), Chat, AI Models (since SET 3), Missions (since
  SET 4), Skills (since SET 6), Settings and Diagnostics work. Memory, Files,
  Automations, Devices and Plugins open a screen labelled _Coming later_ with its SET, and
  have no enabled controls, progress or motion.
- **Command Center.** The Jupiter stage (mark + status) is driven only by
  Core's real state as the host reports it: idle, attention (a service
  degraded or failed), starting, connecting, or unavailable (Core stopped). It
  never shows "thinking" or "working". Next to it: the chat composer
  (working since SET 3 when a model is set up; otherwise disabled and says why), the current-Mission card (says no Mission is running),
  recent activity from the event bus, and System health.
- **Shell.** Skip link; a sidebar that collapses to icons (compact mode or
  Ctrl+B); a top bar with the Jupiter menu (keyboard shortcuts, About), the
  network indicator (as Chromium sees it) and the Core indicator. F6 moves
  between sidebar, top bar and content. Ctrl+1…9, Ctrl+, and Ctrl+Shift+D
  open screens, and F1 or Ctrl+/ lists the shortcuts. Shortcuts are ignored
  while a dialog is open. On each screen change, focus moves to the screen's
  heading and the window title names the screen.
- **Components** (`apps/desktop/src/renderer/src/components`): modal dialog
  (native `<dialog>`, focus trapped and restored), menu button, tabs,
  radio/switch/select form controls, toasts, determinate and indeterminate
  progress (numbers only when both amounts are known), state messages (empty,
  loading, offline, unavailable, error with retry), timeline, the permission
  and identity-check dialog shells (identity check says _Unavailable_ and
  offers only Cancel), and the Mission card.
- **Preferences** are Core settings (`ui.language`, `ui.theme`,
  `ui.textScale`, `ui.compact`, `ui.reduceMotion`, `ui.avatar`,
  `notifications.desktop`), validated on write and on read. The interface sets
  `lang`, `data-theme`, `data-compact`, `data-motion` and `data-avatar` on
  `<html>` and the root font size (100–200%), so a change takes effect at once
  with no restart. If the database is down, a change is applied for the
  session, shown as not saved, and saved when the database is back.
- **Window state.** The host keeps size, position, maximized state and the
  last screen in `<data folder>/window-state.json` (validated, written
  atomically), fits them to the current displays, and opens the window at the
  last screen. The title bar is the native Windows one, dark.
- **Design tokens** in `packages/ui/src/tokens.ts` (mirrored as CSS custom
  properties in `tokens.css`, tested equal). Everything is sized in `rem` with
  container queries, so text size and Windows scaling from 100% to 200% keep
  the layout usable from 720×480 (the smallest window) up to 4K. Reduce Motion
  (Follow Windows / On / Off) sets every transition and animation to none;
  Static and Hidden Avatar stop or remove the mark and keep the status text.
  High contrast and Windows forced colours are supported.
- **Copy.** Every string comes from the English or Thai catalogue. Both
  catalogues have the same keys and placeholders, and a unit test parses the
  renderer and fails on literal copy in components.

## AI providers, Model Router and Chat (SET 3)

Decisions and alternatives: [ADR 0004](decisions/0004-providers-router-credentials-and-chat.md).

- **Adapter port.** `packages/core/src/ai/adapter.ts` defines what an adapter
  does (describe itself, list models, stream chat, optionally embed) and the
  provider error codes. `@jupiter/providers` implements the OpenAI-compatible
  and Anthropic protocols. `apps/desktop/src/core/adapters.ts` is the only
  place that lists them; Core never names a provider.
- **Network guard.** `ai/transport.ts` is the only way adapters reach the
  network: locality from the address (loopback = this device), Local only
  blocks cloud addresses before connecting, redirects are refused, and a key
  is never sent over plain `http` off this computer.
- **Router.** `ai/router.ts` (pure) picks a model by capability, mode (Auto,
  Cloud, Hybrid, Local only), conversation pin, preferences and cost/latency,
  with fallbacks only as the policy allows (`never`, `same-locality`,
  `allowed-by-mode`). `ai.route.preview` shows the result in the interface.
- **Keys.** The host `CredentialVault` encrypts each key with `safeStorage`
  into `<data folder>/credentials/<id>.bin` (0600) and refuses to store keys
  without OS protection. Core reads keys through host operations for the Core
  actor only; the renderer only ever sees a fingerprint.
- **Chat.** `ai/chat.ts` stores the question and a `streaming` answer, streams
  text as transient `chat.message.delta` events (40 ms batches, with offsets),
  and stores the finished answer once as complete, cancelled or failed.
  Stop aborts the provider request; retry and edit supersede, never delete;
  answers interrupted by a Core stop are marked failed at the next start.
- **Interface.** _AI Models_ (providers, keys, models, routing and a live
  route preview per capability) and _Chat_ (conversations, streaming, Stop,
  Ask again, Edit, per-conversation mode and model, the model shown on every
  answer, tool calls shown and never run). The Home composer sends into a new
  conversation. With no usable model, composers are disabled and say _Not
  configured_ or _Unavailable_ with the reason and a link to AI Models.

## Missions (SET 4)

Decisions and alternatives: [ADR 0005](decisions/0005-mission-state-machine-and-executions.md).

- **State machine.** `MISSION_TRANSITIONS` (contracts) is the table of
  allowed changes between the 13 statuses. `MissionManager.transition` (Core)
  is the only code that changes a status: accepted changes are stored and
  published, others are stored as rejected, published, refused with
  `INVALID_MISSION_TRANSITION` and audited. COMPLETED also needs a passed
  verification and every required step succeeded.
- **Executions.** Each run is an attempt with its own steps; Retry adds a
  linked attempt and never changes an earlier one. History tables are
  append-only.
- **Runner.** Replaced in SET 5 by the Workflow Engine (below): a failed
  required step ends the attempt as FAILED, a failed optional one allows
  PARTIAL_SUCCESS.
- **Timeline.** Persistent events on `mission/<id>`, turned into plain
  language by the interface; rebuilt identically after a restart.
- **Interface.** _Missions_ lists Missions and shows one in detail (request,
  status, progress by finished steps, current and next step, elapsed time,
  model, steps, results, verification, attempts, recovery actions and the
  timeline). Home's Mission card and stage follow the current Mission.

## Planner and Workflow Engine (SET 5)

Decisions and alternatives: [ADR 0006](decisions/0006-planner-and-workflow-engine.md).

- **Plans.** `PlanDraft`/`Plan` (contracts): goal, assumptions, a short
  rationale, steps (id, title, description, step type, dependencies, input,
  condition, timeout, retry policy, output check, required), required skills
  and permissions, expected artifacts and a verification plan. Revisions are
  kept; a re-plan adds one linked to the previous.
- **Planner** (`packages/core/src/workflow/`). The chat model is asked for one
  JSON plan (never its reasoning), through the same guarded path as Chat. Its
  output must pass the strict schema and `validatePlan` (cycles, missing
  dependencies, unknown/unavailable step types, undeclared skills, any
  permission, timeouts, inputs, `{{step}}` references, conditions,
  verification); otherwise it is stored as a rejection with its reasons and
  nothing runs. Jupiter's answer plan is available as a template plan.
- **Step types.** A built-in catalogue, plus every registered Skill whose inputs are text (SET 6):
  `model.generate`, `text.compose`, `checkpoint.approval`, and
  `checkpoint.identity` marked unavailable (SET 14).
- **Engine** (`MissionManager.runWorkflow`). Runs the dependency graph:
  independent steps in parallel (at most 3), conditions, per-attempt
  timeouts, bounded retries with growing waits, outputs passed as `{{step}}`,
  approval checkpoints (Mission WAITING_APPROVAL), Pause when no step runs,
  Cancel aborting every running step. Each attempt is recorded; a step's
  output is stored once, with its completion, and never produced again (the
  step id is the idempotency key). The verification plan runs in VERIFYING.
- **Recovery.** After a restart, running workflows continue from the stored
  state: cut-off attempts are recorded as interrupted and run again;
  completed steps are not. Paused and waiting Missions keep waiting.
- **Service.** `workflow-engine` is a Core service with a real self-check;
  commands that plan or run workflows require it.
- **Interface.** The Mission screen shows the plan (source, revision, goal,
  assumptions, rationale, expected results, checks, revisions, rejections
  with reasons), the workflow by stages (status, current step, dependencies,
  conditions, attempts and their outcomes, time limit, waiting), approval
  with Approve/Reject, and _Correct and re-plan_ with corrections and a
  planner choice. New Missions choose the planner or the answer plan.

## Skill System (SET 6)

Decisions and alternatives: [ADR 0007](decisions/0007-skill-registry-and-sandbox.md).

- **Definitions.** `SkillDefinition` (contracts): id, name, description,
  version, input and output schemas (a strict JSON Schema subset), permissions,
  timeout, category, provider and compatible runtime. Invalid metadata is
  refused at registration with every reason.
- **Registry** (`packages/core/src/skills/registry.ts`, Core service
  `skill-registry`): register, unregister, get, search, enable, disable,
  health check, invoke, cancel, list versions. Built-in Skills: `echo_text`,
  `get_app_version`, `get_system_time`, `list_available_skills`.
- **Sandbox** (`WorkerSkillSandbox`, `@jupiter/core/node`): a worker thread
  per invocation, the Skill's code in a `vm` context with no `require`,
  `process`, timers or environment; timeout and cancel terminate the thread.
  A broken Skill ends as a structured failure; Core carries on.
- **Permissions.** A Skill may use only the resources it declared; each
  resource fixes its capability and exact target, and every use is decided
  by the Permission Engine (SET 7). An undeclared use fails the execution
  with `PERMISSION_DENIED`; a declared one without a grant ends the run as
  `WAITING_APPROVAL` and asks the person.
- **Validation.** Disabled, unhealthy, incompatible or unknown Skills do not
  run; input and output are checked against the schemas; invalid output fails
  the execution.
- **Workflows.** Registered Skills are step types: the planner offers them,
  the validator checks them, the engine runs them through the registry.
- **Interface.** The Skill Center lists Skills with search and filters
  (category, provider, health) and shows provider, category, enabled state,
  permissions with risk, version(s), health with detail and last check,
  runtime, schemas and recent runs; low-risk internal Skills can be tried
  through a real invocation with Cancel.

## Permission Engine (SET 7)

Decisions and alternatives: [ADR 0008](decisions/0008-permission-engine.md).

- **Catalogue.** `PERMISSION_CATALOGUE` (contracts): every capability with its
  risk (LOW, MEDIUM, HIGH, CRITICAL), summary, consequence, reversibility and
  what leaves the computer. Unknown capabilities are always denied.
- **Engine** (`packages/core/src/permissions/engine.ts`, Core service
  `permission-engine`): `check` at the moment of use — deny by default; a
  grant must match capability, requester (kind and id), exact target (or a
  `*` prefix), Mission, session and expiry. Otherwise a request is put to
  the person. ALLOW_ONCE is used up in the same transaction; ALLOW_SESSION
  ends with the Core process; ALWAYS_ALLOW until revoked; CRITICAL (and HIGH
  started by an automation) accept only a fresh ALLOW_ONCE.
- **Who decides.** Only the `user-interface` actor may answer or revoke
  (dispatcher policy and the engine). Jupiter's defaults are visible grants
  made once by `core`, revocable, never recreated after revocation.
- **Missions.** A Skill step without a grant waits (step WAITING, Mission
  WAITING_APPROVAL); allow runs it again, deny fails it with
  `PERMISSION_DENIED`. After a Core restart the request has expired and the
  step asks again.
- **Storage.** Migration 7: `permission_requests`, `permission_grants`
  (ended, never deleted) and the append-only `permission_audit` (redacted).
- **Interface.** A global permission dialog (all facts of the request, only
  the offered answers, Deny focused first, no close button); Settings ›
  Permissions (pending requests, grants with Revoke, audit trail); Mission
  notice for a step waiting for permission; the Skill Center shows granted
  permissions.

## Windows Computer Agent (SET 8)

Decisions and alternatives: [ADR 0009](decisions/0009-windows-computer-agent.md).

- **Actions** (`ComputerAction`, contracts): OPEN_APP, CLOSE_APP,
  FOCUS_WINDOW, MANAGE_WINDOW, LIST_WINDOWS, WAIT_FOR_WINDOW, READ_UI_TREE,
  CLICK_ELEMENT, TYPE_TEXT, PRESS_KEYS, SCROLL, SELECT_ELEMENT, SCREENSHOT,
  SAVE_FILE and the opt-in CLICK_POINT. Each returns action, target, success,
  method (UI Automation, keyboard, coordinate, system), observation,
  evidence, error, started and completed.
- **Core** (`packages/core/src/computer/`, service `computer-agent`): asks for
  every permission before acting, runs actions one at a time, checks each
  effect (text read back, file read back, window state), re-resolves stale
  windows, cancels at the next boundary, stores tasks (migration 8) and
  publishes `computer.*` events. Adapters: Generic Windows, Notepad, File
  Explorer.
- **Host** (`computer-host.ts`, host operation `host.computer.call`, Core
  only): the only place that knows executables, the save folder (Desktop) and
  the evidence folder; verifies saved files.
- **Agent runtime** (`services/agent-runtime`, host service `agent-runtime`):
  PowerShell with the .NET UI Automation client, one JSON-lines call at a
  time, deadlines, crash reporting and restart.
- **Missions**: step type `computer.notepad_write` (unavailable where the
  host has no agent).
- **Interface**: Diagnostics › Computer Agent (availability, runtime,
  screen, save folder, recent tasks with per-action method and observation);
  permission requests in the global dialog.

## Browser Agent (SET 9)

Decisions and alternatives: [ADR 0010](decisions/0010-browser-agent.md).

- **Actions** (`BrowserAction`, contracts): NAVIGATE, NEW_TAB, SWITCH_TAB,
  CLOSE_TAB, CLICK, TYPE, FILL_FORM, SELECT_OPTION, PRESS_KEYS, SUBMIT,
  WAIT_FOR, READ_PAGE, EXTRACT, SCREENSHOT, SNAPSHOT_HTML, DOWNLOAD, UPLOAD
  and the opt-in CLICK_POINT. Controls are found by `Locator`: role and
  accessible name first, then label, placeholder, text or test id; a CSS
  selector only when the task names one. Each action returns its address,
  origin, title, method, observation, untrusted content, labelled
  instructions, evidence and error.
- **Core** (`packages/core/src/browser/`, service `browser-agent`): asks for
  every permission (per action, per exact origin) before anything runs, checks
  each again when it runs, keeps the task on its approved origins
  (`SAFETY_STOP` otherwise), labels page text that tries to direct it
  (`injection.ts`), cancels, stores tasks (migration 9) and publishes
  `browser.*` events.
- **Host** (`browser-host.ts`, host operation `host.browser.call`, Core
  only): finds the browser (Edge, Chrome or Chromium), owns the profile,
  quarantine, downloads, uploads and evidence folders, checks every download
  before keeping it, and runs the browser runtime.
- **Browser runtime** (`services/browser-runtime`, host service
  `browser-runtime`): `playwright-core` bundled into `browser-runtime.cjs`, in
  its own process on Electron's Node.js; isolated contexts; one validated call
  at a time with deadlines, crash reporting and restart.
- **Missions**: step type `browser.read_page` (navigate, read, screenshot);
  its output reaches later steps only as fenced, labelled untrusted page text.
  The Mission detail shows the agents a plan uses and each permission with
  the person's answer.
- **Setting**: `browser.persistentProfile` (off by default).
- **Interface**: Diagnostics › Browser Agent (availability, browser, profile
  kind, recent tasks with per-action method, observation, untrusted-content
  and labelled-instruction badges, safety stops); Settings › Permissions ›
  persistent profile; permission requests in the global dialog.

## Files, documents and artifacts (SET 10)

Decisions and alternatives: [ADR 0011](decisions/0011-file-agent-and-artifacts.md).

- **Contracts** (`packages/contracts/src/files.ts`): approved roots
  (`downloads`, `documents`, `desktop`, `workspace`), `FileLocation` (a root
  and a relative path that cannot be absolute, contain `..` or a reserved
  name), `FileQuery`, `DocumentContent` with metadata, `DocumentSpec` for each
  format Jupiter creates, and `Artifact` (lineage, version, size, SHA-256,
  verification status and checks, kept, deleted).
- **Core** (`packages/core/src/files/`, service
  `artifact-manager`): `FileAgent` checks `files.list`, `files.read`,
  `files.write`, `files.open`, `files.delete` (CRITICAL) or
  `artifacts.create` for the exact resolved file when each operation runs,
  labels document text that tries to direct the agent, creates, versions,
  verifies, shares, keeps and deletes artifacts, cleans up finished Missions'
  workspaces (never kept files), stores artifacts (migration 10, never
  deleted) and publishes `file.operation`, `artifact.created` and
  `artifact.changed` events.
- **Host** (`file-host.ts`, host operation `host.files.call`, Core only):
  owns the approved folders, resolves every path segment by segment (links,
  junctions and anything outside the root refused), lists and sorts by real
  modified time, copies and moves without overwriting, writes atomically
  (temporary file, validate, link to a free name), prints PDF with Electron
  in a script-less, offline window, opens only allow-listed file types, and
  moves deleted files to the Recycle Bin.
- **Document runtime** (`services/document-runtime`, host service
  `document-runtime`): readers, OOXML writers and validators bundled into
  `document-runtime.mjs`, in its own process on Electron's Node.js, with a
  memory limit, deadlines, size, part and zip-bomb limits, crash reporting
  and restart.
- **Missions**: step types `document.read_newest`, `document.read` and
  `document.create` (runner `files`); document text reaches later steps only
  fenced as untrusted data; a Mission's detail lists its artifacts.
- **Interface**: the Files screen (approved folders, find and sort, read with
  metadata and untrusted-content label, open, show in folder, delete) and
  artifact lists in the Files screen and each Mission (verification checks,
  hash, Open, Show in folder, Copy path, Save a copy, Check again, Keep,
  Delete); permission requests in the global dialog.

## Memory System and Obsidian (SET 11)

Decisions and alternatives: [ADR 0012](decisions/0012-memory-system-and-obsidian.md).

- **Contracts** (`packages/contracts/src/memory.ts`, `notes.ts`): the ten
  memory types, layers, sensitivity and sensitive kinds, retention, source,
  relationships, `MemoryEntry` (content hidden for sensitive memories until
  revealed), the policy decision with reason codes, `MemoryQuery` and search
  results, the policy log record; `Vault`, `NoteEntry`, `Note`, `RawNote`
  (text, BOM, line endings, hash), `NoteWriteResult` and the host call
  `NoteCall`.
- **Core** (`packages/core/src/memory/`, `packages/core/src/notes/`, service
  `memory`): the policy (`policy.ts`, deterministic, English and Thai),
  `MemoryService` (session memory and waiting candidates in RAM, long-term
  memory in the database, sealing through the host, metadata, keyword,
  relationship and semantic search with the embedding model the router
  allows, correct, forget, restore, delete, export, `memory.decided`,
  `memory.saved`, `memory.changed` events without content) and `NotesAgent`
  (checks `notes.read` and `notes.write` for the exact file, builds
  frontmatter, resolves links as Obsidian does, adds backlinks once,
  publishes `notes.changed`). Chat proposes a memory only for "remember
  that…".
- **Database**: migration 11 adds `memories` (a CHECK allows either content
  or a sealed form, never both), `memory_embeddings` (normal memories only,
  by trigger) and the append-only `memory_decisions`;
  `PRAGMA secure_delete = ON` and a WAL checkpoint after a delete or a
  correction.
- **Host**: `host.vault.status/seal/unseal` (Core only) seal sensitive
  memories with `safeStorage`; `NotesHost` (`notes-host.ts`, host operation
  `host.notes.call`, Core only) keeps the chosen vault, resolves paths with
  the shared `safe-path.ts`, creates notes atomically under a free name,
  changes a note only with the expected hash after a backup, keeps BOM and
  line endings, and creates the Jupiter Brain subfolders only on request.
- **Missions**: step types `memory.recall` (runner `memory`) and
  `notes.search`, `notes.read`, `notes.create` (runner `notes`); recalled
  memories are fenced `BEGIN/END MEMORY`, note text
  `BEGIN/END UNTRUSTED NOTE TEXT`.
- **Interface**: the Memory screen — status (counts, secure storage, the
  semantic search switch and the model it would use), Memories (search,
  reveal, correct, forget, related, delete, export), Add (the decision and
  its reasons), Waiting (keep or don't keep), Policy log and Obsidian
  (connect, Jupiter Brain, suggested folders, search, recent notes, preview
  with the untrusted label, new note with backlinks).

## Not in SET 11

Automatic extraction of memories from ordinary conversation (only an explicit
"remember that…" is proposed), deleting or moving notes, editing a note's
existing text, syncing a vault, email and calendar (later SETs), device
integrations (SET 12–13), identity verification (SET 14), plugins with their
own runtime (SET 15), and everything after that. The three unfinished
destinations are shown as _Coming later_ in the app, and none of them is
presented as working.

## Voice Interface (SET 12)

Decisions and alternatives: [ADR 0013](decisions/0013-voice-interface.md).

- **Contracts** (`packages/contracts/src/voice.ts`): the eight voice
  states, engine and microphone status, `VoiceStatus` with the last
  exchange, listening sessions, PCM chunks (16 kHz mono, base64), stop
  reasons, utterances and playback reports, the system voice calls and the
  microphone gate. `ModelCapability` gains `transcription` and `speech`;
  settings `voice.*` and the preferred speech models; events
  `voice.state_changed` and `voice.utterance_ready` (transient) and
  `voice.session` (persistent, no content).
- **Core** (`packages/core/src/voice/`, service `voice`): `VoiceService`
  (state machine, sessions, the microphone gate, Push-to-Talk and wake word,
  speech to text, the voice answer from the chat model, text to speech with
  the system voice or a speech model, interruption, recovery), the voice
  activity detector (`vad.ts`), WAV helpers (`audio.ts`) and the wake word,
  stop and language helpers (`phrases.ts`, English and Thai). Engines come
  from the router (`transcription`, `speech`).
- **Providers**: the OpenAI-compatible adapter implements `transcribe`
  (`/v1/audio/transcriptions`, multipart) and `synthesize`
  (`/v1/audio/speech`, WAV); the transport accepts byte bodies.
- **Host**: `SpeechHost` (`speech-host.ts`; Windows SAPI, espeak-ng
  elsewhere; host operations `host.speech.voices` and
  `host.speech.synthesize`, Core only) and `MicrophoneGate`
  (`host.microphone.gate`, Core only), which the session's permission
  handlers consult.
- **Interface**: the Devices screen (voice status, engines and where they
  run, Push-to-Talk, wake word, last exchange, microphone and speaker, voice,
  language, speaking rate, interruption sensitivity, _Test voice_; the
  camera stays _Coming later_), the _Microphone on_ indicator and voice
  controls in the top bar, Ctrl+Shift+Space and Escape, audio capture
  (`voice/capture.ts`) and playback (`voice/playback.ts`) with Web Audio, and
  the preferred speech models in AI Models.

## Not in SET 12

Streaming speech to text (the transcription endpoint takes a whole
recording), speaking an answer before it is complete, voice inside
Missions, voice conversation history, speaker identification, the camera
and vision (SET 13), identity verification (SET 14), plugins with their own
runtime (SET 15), and everything after that. The two unfinished
destinations are shown as _Coming later_ in the app, and none of them is
presented as working.

## Vision and Camera (SET 13)

Decisions and alternatives: [ADR 0014](decisions/0014-vision-and-camera.md).

- **Contracts** (`packages/contracts/src/vision.ts`): sources (screen,
  active window, region, camera, upload), PNG image references held in
  memory, OCR lines with confidences, elements, QR codes, the analysis, the
  observation schema (`untrusted: true`, `privacyHandling`), comparisons,
  camera states and sessions, and the host shapes. Capabilities
  `vision.*` and `camera.*`; host operations `host.vision.*` and
  `host.camera.gate`; events `vision.observed` and `camera.session`
  (persistent, no content) and `camera.state_changed` (transient); settings
  `vision.cameraDevice` and `vision.redactSecrets`; the Computer Agent's
  `CHECK_SCREEN` action and interaction method `vision`.
- **Core** (`packages/core/src/vision/`, service `vision`): `VisionService`
  (captures, uploads in parts, analysis — text and QR codes on this
  computer, description and elements by the routed vision model after
  secrets are blacked out — comparison, the confidence rule `decide`, the
  camera's states and sessions, the Computer Agent's visual check),
  `ImageStore` (memory only) and `analysis.ts` (prompts, the strict answer
  schema, finding text). `completeText` takes `capability: 'vision'` so the
  router picks a vision model.
- **Host**: `VisionHost` (`vision-host.ts`; capture through
  `desktopCapturer` (`screen-capture.ts`), Tesseract, jsQR, blacking out,
  comparison; Core only), the PNG codec (`png.ts`), and the camera gate
  (`MicrophoneGate`, `host.camera.gate`, Core only) that the session's
  permission handlers consult for video.
- **Interface**: the Devices screen has three tabs — _Voice_, _Vision_
  (engines and where they run, capture with a delay and a region, choosing
  an image, analysis with the observation and its privacy handling,
  comparison) and _Camera_ (device, start, preview on a canvas, capture,
  pause, close); the _Camera on_ indicator in the top bar; the camera
  controller (`vision/CameraProvider.tsx`) for the whole interface.

## Not in SET 13

Keeping a capture as a file (an artifact), Windows OCR (Tesseract is used:
it reports confidences), capturing another application's active window on
Linux, video recording, face detection and recognition and identity
verification (SET 14), plugins with their own runtime (SET 15), and
everything after that. The two unfinished destinations are shown as
_Coming later_ in the app, and none of them is presented as working.

## Identity (SET 14)

Decisions and alternatives: [ADR 0015](decisions/0015-identity.md).

- **Contracts** (`packages/contracts/src/identity.ts`): the levels
  (`UNKNOWN` < `RECOGNIZED` < `VERIFIED` < `STRONG_VERIFIED`), the methods
  (Windows Hello, face, voice) and the most each can prove, the
  requirements (`requiredIdentityLevel`: CRITICAL needs `STRONG_VERIFIED`,
  the `IDENTITY_REQUIREMENTS` list needs `VERIFIED`), assurance, the
  liveness check, method status, enrollment and verification inputs, and
  the host shapes. Capabilities `identity.*` (status, face enroll and
  verify, Windows Hello, voice sessions, enable, delete, protection, forget,
  and the host-only `identity.security-event`); host operations
  `host.identity.engines`, `host.identity.face`, `host.identity.hello`;
  events `identity.verification`, `identity.enrollment`,
  `identity.protection_changed` (persistent, no scores) and
  `identity.assurance_changed` (transient); setting
  `identity.timeoutMinutes`.
- **Core** (`packages/core/src/identity/`, service `identity`):
  `IdentityService` (enrollment from camera frames with consent, sealed
  templates, verification, assurance in memory with its timer, security
  events, rate limiting kept in the database, voice sessions through the
  microphone gate, protection), `face.ts` (matching and the liveness check),
  `voice.ts` (MFCC features). The Permission Engine asks the identity gate
  (`useIdentity`) before any grant; a shortfall is `IDENTITY_REQUIRED`.
- **Database**: migration 12 (`identity_methods` with sealed templates
  only, `identity_attempts`, `identity_state`), `SqliteIdentityStore`.
- **Identity runtime** (`services/identity-runtime`): face-api 1.7.15 on
  TensorFlow.js with the WebAssembly backend, in its own process
  (`ELECTRON_RUN_AS_NODE`, 1 GB memory limit), models and `.wasm` files
  copied next to the bundle; one validated call at a time (`describe` →
  faces with boxes and 128-number descriptors).
- **Host**: `IdentityHost` (`identity-host.ts`; PNG decode and downscale,
  the runtime, Windows Hello through `UserConsentVerifier` in Windows
  PowerShell; Core only) and `powerMonitor` lock, unlock, suspend, resume
  and shutdown reported to Core as `identity.security-event`.
- **Interface**: Settings → _Identity_: the level and why, until when, the
  liveness checks and their limitation, ending the verification,
  protection and the timeout with what each action needs, and a card per
  method (availability, what it can prove, consent, camera preview, set up,
  check, turn off, delete with confirmation, lockout). Identity events in
  the activity timeline.

## Not in SET 14

A Mission step that pauses for identity (protected steps check identity
when they run instead), face detection in Vision (faces are used only by
Face Identity), device identity beyond the Windows account, presentation
attack detection beyond the Experimental liveness check, a speaker
verification model, plugins with their own runtime (SET 15), and
everything after that. The two unfinished destinations are shown as
_Coming later_ in the app, and none of them is presented as working.
