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

## What SET 0 enforces today

| Control                                                                                                            | Where                                                       | Verified by                                     |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------- |
| `contextIsolation`, `sandbox`, no `nodeIntegration` (also in workers and subframes), no `<webview>`                | `apps/desktop/src/main/window.ts`                           | E2E reads the live web preferences              |
| `app.enableSandbox()` for every renderer (skipped only with an explicit `--no-sandbox`, shown in Diagnostics)      | `apps/desktop/src/main/index.ts`                            | E2E + Diagnostics                               |
| Preload exposes five fixed functions, frozen; no generic `invoke`, no `ipcRenderer`                                | `apps/desktop/src/preload/index.ts`                         | E2E checks the exact bridge keys                |
| IPC allowlist, sender check (main window, top frame, app URL), input and output schema validation, correlation IDs | `apps/desktop/src/main/ipc.ts`                              | E2E sends malformed and unknown requests        |
| Strict CSP: no inline or evaluated script, no remote content, no network                                           | `apps/desktop/electron.vite.config.ts`                      | build-output test + E2E inline-script violation |
| Navigation, redirects, new windows, webviews, downloads and permission requests blocked                            | `apps/desktop/src/main/security.ts`                         | E2E navigation and window.open tests            |
| Dev server URL honoured only for unpackaged development on loopback                                                | `packages/core/src/environment.ts`                          | unit tests                                      |
| DevTools only in development                                                                                       | environment profiles                                        | packaged-app test                               |
| Renderer cannot import Node.js or Electron                                                                         | `eslint.config.js` (`no-restricted-imports`)                | lint                                            |
| Log redaction (credential key names + credential formats), bounded sizes, owner-only log files                     | `packages/security`, `packages/core`                        | unit, integration and E2E tests                 |
| No hardcoded credentials in sources, build output or the packaged app                                              | `scripts/check-secrets.mjs`, `scripts/validate-package.mjs` | integration test + package validation           |
| No known vulnerable dependencies at the time of SET 0                                                              | `npm audit` (0 vulnerabilities)                             | manual, recorded in the SET 0 report            |

## Not yet in place (by design, later SETs)

Permission Engine (SET 7), secure credential storage (SET 3), identity (SET 14),
plugin isolation (SET 15), signed updates (SET 21), code signing and installer
hardening (SET 20), Electron fuses and full threat model (SET 23). The legacy
Thursday Browser in `legacy/` does **not** meet these principles (for example it
can store API keys unencrypted when no OS keychain exists, and it pins Electron
38 with known advisories); it is kept only as a reference and is not part of
Jupiter.
