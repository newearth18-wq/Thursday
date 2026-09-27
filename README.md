# Jupiter

Jupiter is a Windows desktop AI agent, built in stages (SET 0–24). This
repository is the Jupiter monorepo.

**Current stage: SET 10 — File, Document, Office and Artifact System** (on top
of SET 9, Browser Agent; SET 8, Windows Computer Agent; SET 7, Permission and
Security Engine; SET 6, Skill System; SET 5, Planner and Workflow Engine; SET
4, Mission System; SET 3, AI providers, Model Router and Chat; SET 2, the
product shell; SET 1, Core architecture; and SET 0, the repository
foundation). The new **Files** screen finds, sorts and reads documents in the
folders Jupiter may use (Downloads, Documents, Desktop and its own workspace):
TXT, Markdown, CSV, JSON, PDF, Word, PowerPoint and Excel, parsed in a process
of its own. Missions can read the newest PDF in Downloads and save what they
produce as TXT, Markdown, CSV, JSON, DOCX, PPTX, XLSX or PDF; every file is
written without overwriting anything, checked, and recorded as an
**artifact** with where it came from, its version, SHA-256 and each check,
with Open, Show in folder, Copy path, Save a copy, Keep and Delete (to the
Recycle Bin, with a CRITICAL permission for that exact file). Paths that
leave the approved folders, and links, are refused. The **Browser Agent**
uses the web through an installed Edge, Chrome or Chromium in an isolated
session, and on Windows the **Computer Agent** uses real applications through
UI Automation. Everything a page or document says is untrusted data. Nothing
Jupiter does with an effect happens without a **permission** that matches
exactly what, who, which target and for how long; _Settings › Permissions_
lists them and the audit trail. **Files**, **Skills**, **Missions** planned by
your model, _Chat_, _AI Models_, _Settings_ and _Diagnostics_ work; the other
four screens are labelled _Coming later_ with the SET that builds them.

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
packages/core/           Core kernel: capability dispatcher, event bus, service supervisor, logger, IDs; model router, chat, adapter port; Mission Manager, planner and workflow engine; Skill Registry and sandbox; Permission Engine; Computer Agent; Browser Agent; File Agent and Artifact Manager
packages/providers/      Provider adapters (OpenAI-compatible, Anthropic), reached only through Core's guarded transport
packages/database/       SQLite (node:sqlite): migrations, transactions, backups, repositories
packages/security/       Secret patterns and redaction
packages/ui/             Visual Design Lock v1: design tokens, fonts, icons, the Jupiter mark
packages/testing/        Launch the real app with Playwright; credential-shaped test values; provider protocol test servers; test websites; document fixtures and independent Office checks
services/agent-runtime/  Windows UI Automation runtime (PowerShell) behind a validated JSON-lines RPC; its Node client
services/browser-runtime/ Browser runtime: playwright-core bundled into one file, in its own process; its Node client
services/document-runtime/ Document runtime: readers, OOXML writers and validators in their own process; its Node client
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

The Browser Agent keeps its files in `<data folder>\browser\`: `quarantine\`
(downloads waiting to be checked), `downloads\` (downloads that passed),
`uploads\` (the only files it may upload) and, only if you turn on the
persistent profile, `profile\`. Screenshots and page snapshots go to
`<data folder>\browser-evidence\`. It never uses your own browser profile.

Files Jupiter makes go to `<data folder>\workspace\`, one folder per Mission
(`workspace\<Mission id>\`). A copy you save goes to Downloads, Documents or
Desktop under a free name. Jupiter never overwrites a file; deleting moves it
to the Recycle Bin, and cleaning up a finished Mission never removes a file you
chose to keep.

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
- [docs/sets/SET-06-skill-system.md](docs/sets/SET-06-skill-system.md) — SET 6 report and acceptance results
- [docs/sets/SET-07-permission-and-security-engine.md](docs/sets/SET-07-permission-and-security-engine.md) — SET 7 report and acceptance results
- [docs/sets/SET-08-windows-computer-agent.md](docs/sets/SET-08-windows-computer-agent.md) — SET 8 report and acceptance results
- [docs/sets/SET-09-browser-agent.md](docs/sets/SET-09-browser-agent.md) — SET 9 report and acceptance results
- [docs/sets/SET-10-file-document-office-and-artifacts.md](docs/sets/SET-10-file-document-office-and-artifacts.md) — SET 10 report and acceptance results
- [docs/decisions/](docs/decisions/) — architecture decision records

## License

MIT
