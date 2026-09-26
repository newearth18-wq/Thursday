# Jupiter

Jupiter is a Windows desktop AI agent, built in stages (SET 0–24). This
repository is the Jupiter monorepo.

**Current stage: SET 5 — Planner and Workflow Engine** (on top of SET 4,
Mission System; SET 3, AI providers, Model Router and Chat; SET 2, the product
shell; SET 1, Core architecture; and SET 0, the repository foundation). A
request becomes a **Mission**, and the **planner** (the AI model you set up
in _AI Models_) turns it into a plan: a goal, assumptions you can correct,
and steps with dependencies, conditions, time limits, retry policies and
checks. Jupiter checks every plan before anything runs, rejects invalid ones
with the reasons, and runs valid ones as a workflow: independent steps in
parallel, approvals where the plan asks for them, retries and timeouts per
step, and a workflow that continues after a restart. A failed Mission can be
re-planned with your corrections; every plan revision and attempt is kept.
Missions can be paused, resumed, cancelled, retried and archived. _Chat_
streams answers with Stop, Ask again and Edit. Home, Chat, Missions, AI
Models, Settings and Diagnostics work; the other six screens are labelled
_Coming later_ with the SET that builds them.

|                 |                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------ |
| Target platform | Windows 10/11 x64 (Linux is used for CI and development only)                              |
| Stack           | Electron 44 · React 19 · TypeScript 6 (strict) · Vite 7 / electron-vite 5 · npm workspaces |
| Node.js         | 22.12 or newer (see `.nvmrc`)                                                              |

## Quick start

```bash
npm ci          # install exactly what package-lock.json records
npm run dev     # start Jupiter in development mode (dev server + Electron)
```

Running as root in a container? Chromium's sandbox cannot start as root, so use
`npm run dev -w @jupiter/desktop -- --noSandbox`. Don't do this on a normal desktop.

## Scripts

| Script                            | What it does                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development mode: Vite dev server + Electron, development data folder, DevTools allowed                   |
| `npm run build`                   | Production build of main, preload and renderer into `apps/desktop/out/`                                   |
| `npm run start`                   | Launch the production build without packaging it                                                          |
| `npm test`                        | Unit tests, then build, then integration + Electron end-to-end tests                                      |
| `npm run test:unit`               | Unit tests only (fast, no Electron)                                                                       |
| `npm run test:integration`        | Build, then real-filesystem, secret-scan and Electron E2E tests (Linux: xvfb + a throwaway GNOME Keyring) |
| `npm run test:dev-smoke`          | Proves `npm run dev` really launches the app                                                              |
| `npm run lint`                    | ESLint with full type information, zero warnings allowed                                                  |
| `npm run typecheck`               | Strict TypeScript across every workspace                                                                  |
| `npm run format` / `format:check` | Prettier                                                                                                  |
| `npm run check:secrets`           | Scan the repository for hardcoded credentials                                                             |
| `npm run package:windows`         | Windows NSIS installer (on Windows, or anywhere with Wine)                                                |
| `npm run package:windows:dir`     | Unpacked Windows build (works on Linux)                                                                   |
| `npm run package:linux:dir`       | Unpacked Linux build (CI and development)                                                                 |
| `npm run package:validate`        | Validate the Windows package and write evidence to `test-results/`                                        |
| `npm run verify`                  | Every gate above, in order — run before opening a pull request                                            |

## Repository layout

```text
apps/desktop/            Jupiter desktop app: host (Electron main + gateway), Core utility process, preload, React renderer
packages/contracts/      Versioned zod schemas for every trust boundary
packages/core/           Core kernel: capability dispatcher, event bus, service supervisor, logger, IDs; model router, chat, adapter port; Mission Manager, planner and workflow engine
packages/providers/      Provider adapters (OpenAI-compatible, Anthropic), reached only through Core's guarded transport
packages/database/       SQLite (node:sqlite): migrations, transactions, backups, repositories
packages/security/       Secret patterns and redaction
packages/ui/             Visual Design Lock v1: design tokens, fonts, icons, the Jupiter mark
packages/testing/        Launch the real app with Playwright; credential-shaped test values; provider protocol test servers
services/agent-runtime/  Coming later (SET 8)
services/browser-runtime/ Coming later (SET 9)
services/plugin-runtime/ Coming later (SET 15)
plugins/                 Coming later (SET 15)
docs/                    Architecture, decisions, definition of done, SET reports
scripts/                 verify, secret scan, package validation, dev smoke test
legacy/thursday-browser/ The earlier Thursday Browser prototype, preserved and still tested
```

## Where Jupiter keeps its data

| Environment | Folder                                         |
| ----------- | ---------------------------------------------- |
| Production  | `%APPDATA%\Jupiter`                            |
| Development | `%APPDATA%\Jupiter (Development)`              |
| Test        | always an explicit temporary `--user-data-dir` |

Logs are JSON Lines in `<data folder>\logs\jupiter.log`, rotated at 5 MB with
five files kept, owner-only permissions, and credentials redacted before
anything is written. The database is `<data folder>\jupiter.db` (SQLite, WAL);
backups — including one taken automatically before any schema upgrade — are in
`<data folder>\backups\`. Jupiter never deletes files there other than its own
older backups (the newest ten are kept). Preferences (language, theme, text
size, motion, avatar, notifications), AI providers, models, routing settings,
conversations and Missions (with their full history) are stored in the database; `<data folder>\window-state.json`
remembers the window's size, position and last screen. API keys are **not** in
the database: each is a file in `<data folder>\credentials\` encrypted by the
operating system (DPAPI on Windows, the Keychain on macOS, the Secret Service
on Linux), readable only by your user account. On Linux without a running
Secret Service (GNOME Keyring or KWallet), Jupiter says so and does not store
keys; providers that need no key still work.

## Documentation

- [AGENTS.md](AGENTS.md) — rules for anyone (human or AI) changing this repository
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the foundation fits together
- [SECURITY.md](SECURITY.md) — security principles and their current enforcement
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, checks and conventions
- [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md) — when a SET is complete
- [docs/sets/SET-00-foundation.md](docs/sets/SET-00-foundation.md) — SET 0 report and acceptance results
- [docs/sets/SET-01-core-architecture.md](docs/sets/SET-01-core-architecture.md) — SET 1 report and acceptance results
- [docs/sets/SET-02-product-shell.md](docs/sets/SET-02-product-shell.md) — SET 2 report and acceptance results
- [docs/sets/SET-03-ai-providers-and-chat.md](docs/sets/SET-03-ai-providers-and-chat.md) — SET 3 report and acceptance results
- [docs/sets/SET-04-mission-system.md](docs/sets/SET-04-mission-system.md) — SET 4 report and acceptance results
- [docs/sets/SET-05-planner-and-workflow-engine.md](docs/sets/SET-05-planner-and-workflow-engine.md) — SET 5 report and acceptance results
- [docs/decisions/](docs/decisions/) — architecture decision records

## License

MIT
