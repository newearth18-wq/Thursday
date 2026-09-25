# ADR 0002 — Jupiter Core in a utility process, one host gateway, SQLite through `node:sqlite`

- Status: accepted (SET 1)
- Date: 2026-09-25

## Context

SET 1 asks for Jupiter Core as the trusted coordination layer, separated from
the UI, from privileged host capabilities and from isolated runtimes; a
validated, limited IPC surface; an event bus with per-Mission ordering and safe
reconnection; SQLite persistence; crash isolation; and a capability dispatcher
that nothing may bypass to reach privileged host functionality.

The SET 0 shell had five ad-hoc IPC channels served by the Electron main
process, and loaded the interface from `file://`.

## Decisions

### 1. Core runs in an Electron `utilityProcess`

Core (dispatcher, event bus, database, and later the Mission Manager, Workflow
Engine, …) runs in its own process, forked by the host from
`out/main/core.js` and talking only over the utility process's message port
with a versioned, schema-validated protocol (`HostToCore` / `CoreToHost`).

- A crash, hang or blocking query in Core cannot freeze or kill the window or
  the host. The host detects exit (and missed heartbeats), answers pending
  requests with `CORE_UNAVAILABLE`, reports `CORE_CRASHED`, and restarts Core
  with back-off (1 s, 3 s, 10 s; then Retry).
- Core never touches windows, the renderer, `shell`, or other Electron APIs —
  the Core bundle imports only four Node.js built-ins (checked by a build test).
- Alternatives considered: Core inside the main process (no isolation — a
  synchronous SQLite call or a crash would take the window down); a
  `child_process` running system Node (would need a second runtime on the
  user's machine); a worker thread (shares the main process's fate on
  crashes and memory exhaustion).

### 2. One host gateway, six channels, and the dispatcher behind it

The renderer reaches Jupiter through six invoke channels and one push channel
(`jupiter:v1:*`). All commands and queries go through a single `request`
channel to Core's **capability dispatcher**, which validates, authorizes
(deny by default, per actor type), enforces timeouts and cancellation and
audits. The gateway only checks the sender, limits size, validates the
envelope, assigns the actor and tracks which window owns which request and
subscription.

Host-privileged functions (SET 1: `host.logs.reveal`) are capabilities with
provider `host`: the dispatcher authorizes and audits them, then asks the host
over the Core port. The renderer has no path to them that skips the dispatcher.

**Exception, on purpose:** `gateway-status` and `retry-service` are served by
the host itself, because they must work while Core is down — the person has to
be able to see that Core crashed and press Retry on it. Both accept only
validated input from the trusted window; `retry-service` is audited
(`gateway.service-retry`, buffered and delivered once Core is back) and can only
restart a known, retryable service.

- Alternatives considered: one channel per capability (grows the preload
  surface with every SET, and spreads validation); the dispatcher in the host
  (then Core-side features would need a second authorization path).

### 3. The interface is served from `jupiter://app`

A privileged, standard, secure custom scheme with a handler that serves only
the built renderer folder (GET only, no traversal, no symlinks) and sends the
CSP as a header. The page gets a real origin that sender validation and the
CSP can name; `file://` would give every page an opaque origin with access to
other local files.

### 4. SQLite through `node:sqlite`

`node:sqlite` ships inside Electron 44's Node.js 24, so there is no native
module to compile, rebuild per Electron version or sign, and nothing extra in
the installer. It is synchronous, which is acceptable because it runs in Core's
own process, never on the UI or host thread.

- Settings: WAL, `synchronous=FULL` (durability over write speed — the event and
  audit logs are records), foreign keys verified on open, `STRICT` tables,
  append-only triggers on `events` and `audit_log`.
- Migrations are checksummed; the app refuses a database that is newer than it,
  whose applied migrations were modified, or that fails `quick_check` — and does
  not touch such a file. Existing databases are backed up before migrating.
- Alternatives considered: `better-sqlite3` (native module, rebuild per Electron
  ABI, extra packaging and signing work); an ORM (hides the SQL that the
  integrity guarantees depend on).
- Risk: `node:sqlite` is not yet marked stable in Node.js 24 (under Electron
  44.4.5 it loads without a warning; if a Node.js version prints one, the host
  logs it at debug level). The API used is small (`DatabaseSync`, prepared
  statements, `backup`) and wrapped by `packages/database`, so a switch later
  would stay inside that package.

### 5. Events: per-stream sequences, commit-then-deliver, cursor-based reconnect

Each persistent event gets a gap-free stream sequence and a global sequence
inside the same transaction as the change it describes, and is delivered only
after that transaction commits. Subscribers resume after a global sequence;
the renderer keys its view by that sequence. This gives stable order within a
Mission (its own stream), no phantom events after a rollback, and no duplicates
after a reload or a Core restart.

## Consequences

- The IPC surface stays at six channels as later SETs add capabilities; each
  new capability is one catalogue entry (schemas + policy) and one handler.
- Packaged builds contain two entry points (`out/main/index.js`,
  `out/main/core.js`); the package validator requires both.
- Playwright's `_electron.launch` cannot hold back a packaged app's startup, and
  racing the first `jupiter://` navigation made it hang intermittently. The
  packaged E2E test therefore launches the executable itself, waits for
  Jupiter's own `window.shown` log line, and attaches over CDP and the Node
  inspector (`launchPackagedJupiter` in `packages/testing`).
