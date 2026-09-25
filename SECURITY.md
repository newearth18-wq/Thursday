# Security

## Reporting a vulnerability

Please report security problems privately to the repository owner through
GitHub's private vulnerability reporting, not in a public issue.

## Principles

These come from the Jupiter Global Contract and apply to every SET.

1. **Deny by default.** Nothing is granted unless a central policy grants it.
2. **The renderer is untrusted UI.** It has no Node.js, filesystem, shell,
   credential or unrestricted IPC access.
3. **Every trust boundary is validated** with typed schemas, in both directions.
4. **External content is data, never instructions** — web pages, documents,
   plugin output and model output cannot grant permissions or change policy.
5. **Secrets live only in OS-backed secure storage.** Never in source, plaintext
   files, databases, logs, the renderer, crash reports or error messages.
6. **Privileged actions go through one Permission Engine** with exact targets,
   risk levels and audit records.
7. **Third-party code never runs in the Electron main process.**
8. **Failures are reported truthfully**, sanitized, with a way to recover.

## What is enforced today (SET 0 + SET 1)

| Control                                                                                                                                  | Where                                                       | Verified by                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `contextIsolation`, `sandbox`, no `nodeIntegration` (also in workers and subframes), no `<webview>`                                      | `apps/desktop/src/main/window.ts`                           | E2E reads the live web preferences                                     |
| `app.enableSandbox()` for every renderer (skipped only with an explicit `--no-sandbox`, shown in Diagnostics)                            | `apps/desktop/src/main/index.ts`                            | E2E + Diagnostics                                                      |
| No `remote` module: removed from Electron, `@electron/remote` not a dependency; no `require`, `process` or `ipcRenderer` in the page     | `package-lock.json`, preload                                | E2E checks the page globals                                            |
| Preload exposes seven fixed functions, frozen; no generic `invoke`, no `ipcRenderer`                                                     | `apps/desktop/src/preload/index.ts`                         | E2E checks the exact bridge keys and that it cannot be modified        |
| Exactly six invoke channels are registered; any other channel is unreachable                                                             | `apps/desktop/src/main/gateway.ts`                          | unit test + E2E reads Electron's handler table                         |
| Sender check on every channel: the Jupiter window, top frame, `jupiter://app` origin — otherwise denied and audited as `unverified`      | `apps/desktop/src/main/gateway.ts`                          | E2E: a second renderer with the same preload is denied on all channels |
| Actor assigned by the gateway, never read from the message; capability authorization deny-by-default per actor type                      | `gateway.ts`, `packages/core/src/dispatch/dispatcher.ts`    | unit tests + E2E (`runtime.report-host-status` denied to the UI)       |
| Strict request envelopes and per-capability payload and output schemas; 256 KiB size limit; functions cannot cross the bridge            | `packages/contracts`, gateway, dispatcher                   | unit tests + E2E (AT2)                                                 |
| Privileged host functions only through the Core dispatcher (`provider: host`); the one host-served action (`retry-service`) is audited   | `apps/desktop/src/main/host-capabilities.ts`, ADR 0002      | unit tests + E2E audit check                                           |
| Every refusal and every state-changing or host capability call is written to the append-only audit log                                   | `packages/database` (`audit_log` triggers)                  | integration + E2E                                                      |
| Interface served from `jupiter://app` only: GET, no traversal (plain or encoded), no symlinks, other hosts refused; CSP sent as a header | `apps/desktop/src/main/app-protocol.ts`                     | unit tests + E2E probes the live handler                               |
| Strict CSP: no inline or evaluated script, no remote content, `connect-src 'none'`, no frames or workers                                 | `apps/desktop/src/shared/csp.ts`                            | build-output test + E2E inline-script violation                        |
| The page cannot read local files: `fetch`, XHR and `window.open` of `file://` fail; no capability reads files or credentials             | CSP, protocol handler, capability catalogue                 | E2E (AT10)                                                             |
| Nothing returned to the renderer contains a secret from the environment                                                                  | contracts carry no secret fields                            | E2E launches with credential-shaped variables and scans every reply    |
| Navigation, redirects, new windows, webviews, downloads and permission requests blocked                                                  | `apps/desktop/src/main/security.ts`                         | E2E navigation and window.open tests                                   |
| Jupiter Core isolated in a utility process with no Electron window or shell access; crashes contained and reported                       | `apps/desktop/src/core`, `core-process.ts`                  | build-output test + unit tests + E2E (AT9)                             |
| Dev server URL honoured only for unpackaged development on loopback                                                                      | `packages/core/src/environment.ts`                          | unit tests                                                             |
| DevTools only in development                                                                                                             | environment profiles                                        | packaged-app test                                                      |
| Renderer cannot import Node.js or Electron                                                                                               | `eslint.config.js` (`no-restricted-imports`)                | lint + build-output test                                               |
| Log redaction (credential key names + credential formats) in both processes, bounded sizes, owner-only log files                         | `packages/security`, `packages/core`                        | unit, integration and E2E tests                                        |
| No hardcoded credentials in sources, build output or the packaged app                                                                    | `scripts/check-secrets.mjs`, `scripts/validate-package.mjs` | integration test + package validation                                  |

## Not yet in place (by design, later SETs)

Permission Engine with user approvals (SET 7 — SET 1's dispatcher only
authorizes by actor type), secure credential storage (SET 3), identity (SET 14),
plugin isolation (SET 15), signed updates (SET 21), code signing and installer
hardening (SET 20), Electron fuses and full threat model (SET 23). The legacy
Thursday Browser in `legacy/` does **not** meet these principles (for example it
can store API keys unencrypted when no OS keychain exists, and it pins Electron
38 with known advisories); it is kept only as a reference and is not part of
Jupiter.
