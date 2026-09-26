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
  unique idempotency key per Skill).
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
- **Permissions.** Granted by the invocation context: before SET 7 only
  low-risk read permissions. Resources (`context.use`) check that the Skill
  declared and was granted the permission; any other use fails the execution
  with `PERMISSION_DENIED`.
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

## Not in SET 6

The Permission Engine and approvals (SET 7), agents (SET 8), attachments through the Artifact Manager (SET 10),
plugins with their own runtime (SET 15), and everything after that. The five unfinished destinations are shown as
_Coming later_ in the app, and none of them is presented as working.
