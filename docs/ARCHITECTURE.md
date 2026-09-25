# Jupiter architecture — SET 0 foundation

This document describes what exists after SET 0. Later SETs extend it; each
section says what is deliberately not here yet.

## Monorepo

npm workspaces, one lockfile, strict TypeScript everywhere.

```text
apps/desktop          ── depends on ──▶ contracts, core, security, ui   (bundled, nothing external at runtime)
packages/core         ── depends on ──▶ contracts, security
packages/security     ── no dependencies (patterns file is dependency-free on purpose)
packages/contracts    ── depends on ──▶ zod
packages/ui           ── depends on ──▶ @fontsource fonts (React is a peer)
packages/testing      ── depends on ──▶ playwright            (tests only)
packages/database, services/*, plugins/   placeholders: no code, labelled Coming later
legacy/thursday-browser                   separate npm project, own lockfile, not a workspace
```

Workspace packages are consumed as TypeScript source (`exports` point at
`src/*.ts`). electron-vite bundles them into the main, preload and renderer
outputs, so a packaged Jupiter ships **no `node_modules`** — the package
validator checks this.

Domain code (`contracts`, `core`, `security`) does not import Electron or React.
Node-specific code in `core` lives behind the `@jupiter/core/node` subpath so it
can never be bundled into the renderer (lint enforces this too).

## Process model

```text
┌───────────────────────────────────────────┐
│ Renderer (React 19)                       │  sandboxed, contextIsolation, no Node.js,
│ Home · Diagnostics · Settings             │  strict CSP, validates every reply
└──────────────────┬────────────────────────┘
                   │ window.jupiter — 5 frozen functions
┌──────────────────┴────────────────────────┐
│ Preload (sandboxed, CommonJS, ~1 kB)      │  fixed channel names only
└──────────────────┬────────────────────────┘
                   │ ipcRenderer.invoke / on   (jupiter:v0:* channels)
┌──────────────────┴────────────────────────┐
│ Main process                              │
│  environment → logging → security →       │
│  IPC gateway → window → ServiceSupervisor │
│   ├─ build-metadata   (real check)        │
│   ├─ environment      (real check)        │
│   ├─ storage          (write probe)       │
│   ├─ logging          (opens log file)    │
│   └─ database, agent-, browser-, plugin-runtime: COMING_LATER │
└───────────────────────────────────────────┘
```

## Startup sequence (crash-safe)

1. **Before `ready`** — resolve the environment (`development`, `test`,
   `production`), give it its own data folder, create the logger (console +
   buffered rotating file sink), take the single-instance lock, enable the
   sandbox, install web-contents hardening and process-level error handlers.
   Any exception here shows a native error box with the real reason and the log
   folder, then exits with code 1.
2. **On `ready`** — harden the session (deny permissions and downloads),
   register services and the IPC gateway, create the window (shown on
   `ready-to-show`), then start services one by one.
3. **Each service** reports the outcome of a real check. A thrown error becomes
   a FAILED service with an `ErrorEnvelope` (code, category, message, next
   step, reference) and startup continues. The UI receives every status change
   as an event and shows a recovery notice with a working **Retry**.
4. **Renderer failures** — a React error boundary shows the real error, logs
   it through IPC and offers Reload. If the renderer process dies it is
   reloaded automatically up to twice a minute; after that the person is asked.
   A failed page load shows the real Chromium error with Try again / Quit.

## IPC (SET 0 surface)

| Channel                                     | Input                 | Output              |
| ------------------------------------------- | --------------------- | ------------------- |
| `jupiter:v0:app:get-info`                   | none                  | `AppInfo`           |
| `jupiter:v0:runtime:get-status`             | none                  | `RuntimeStatus`     |
| `jupiter:v0:runtime:retry-service`          | `{ serviceId }`       | `RuntimeStatus`     |
| `jupiter:v0:renderer:report-error`          | `RendererErrorReport` | `{ correlationId }` |
| `jupiter:v0:runtime:status-changed` (event) | —                     | `RuntimeStatus`     |

Every reply is `{ ok: true, correlationId, data }` or
`{ ok: false, correlationId, error: ErrorEnvelope }`. The gateway checks the
sender, validates the input, runs the handler, validates the output (an invalid
output is never sent) and logs the request with its correlation ID. SET 1
replaces this minimal surface with the full versioned command/event contract.

## Environments

|                 | development                                           | test                       | production                             |
| --------------- | ----------------------------------------------------- | -------------------------- | -------------------------------------- |
| Chosen when     | unpackaged + dev server, or `JUPITER_ENV=development` | `JUPITER_ENV=test`         | packaged or previewed builds (default) |
| Data folder     | `Jupiter (Development)`                               | explicit `--user-data-dir` | `Jupiter`                              |
| Log level       | debug                                                 | debug                      | info                                   |
| Console format  | readable                                              | JSON                       | JSON                                   |
| DevTools        | allowed                                               | no                         | no                                     |
| Renderer source | loopback dev server                                   | built files                | built files                            |

A packaged build refuses `JUPITER_ENV=development`, and never loads a dev
server URL; the Environment service reports any ignored setting as DEGRADED.

## Build metadata

`apps/desktop/scripts/build-metadata.ts` runs at build time: version from
`apps/desktop/package.json`, channel from `JUPITER_BUILD_CHANNEL` or the
version's pre-release tag (`dev` for the dev server), commit from `GITHUB_SHA`
or git, `builtAt` from `SOURCE_DATE_EPOCH` or now, and a build ID. The result
is validated against `BuildMetadata` and injected into the **main** bundle only.
At runtime the build-metadata service validates it again and checks it against
`app.getVersion()`; the renderer receives it only through `get-info`.

## Logging

- JSON Lines, one `LogEntry` per line: `ts`, `level`, `event`, `message`,
  `component`, `sessionId` (one per run), `correlationId` (one per unit of
  work — each IPC request, each service start), optional redacted `data`.
- Redaction before any sink: values under credential-named keys, and
  credential formats anywhere in text (API keys, tokens, JWTs, bearer
  credentials, private keys, URL credentials).
- Rotation: 5 MB per file, 5 files, synchronous writes, owner-only permissions.
- Entries logged before the file opens (or while it is broken) are buffered
  (bounded), written on recovery, and any loss is reported with a count.

## Not in SET 0

Database, event bus, capability dispatcher, versioned command contract (SET 1);
full design system, navigation state, language switch (SET 2); providers and
credentials (SET 3); everything after that. None of these appear as working in
the app.
