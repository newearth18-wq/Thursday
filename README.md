# Jupiter

Jupiter is a Windows desktop AI agent, built in stages (SET 0–24). This
repository is the Jupiter monorepo.

**Current stage: SET 11 — Memory System and Obsidian Knowledge Base** (on
top of SET 10, File, Document, Office and Artifact System; SET 9, Browser
Agent; SET 8, Windows Computer Agent; SET 7, Permission and Security Engine;
SET 6, Skill System; SET 5, Planner and Workflow Engine; SET 4, Mission
System; SET 3, AI providers, Model Router and Chat; SET 2, the product shell;
SET 1, Core architecture; and SET 0, the repository foundation). The new
**Memory** screen shows what Jupiter remembers and why. Every candidate gets
a decision from a fixed memory policy — _Saved_, _Not saved_ or _Waiting for
you_ — with its reasons: passwords, keys and tokens are never kept;
financial, health, biometric, identity and other people's private details
wait for your answer, and if you keep one it is sealed by the operating
system's secure storage and hidden until you press _Reveal_. You can search
by kind and tags, keywords, relationships or (if you turn it on) meaning,
correct, forget, restore, export and delete (for good, with a HIGH
permission). Semantic search uses an embedding model chosen by your routing
mode; under _Local only_ no memory leaves the computer. In chat, "remember
that…" proposes a memory. **Obsidian:** connect a vault you choose (or create
a _Jupiter Brain_ folder), search and read notes, and create notes with valid
frontmatter, links and backlinks; Jupiter never overwrites a note, keeps a
copy before it changes one, keeps its frontmatter, BOM and line endings, and
adds the suggested folders only when you ask. The **File Agent** reads and
writes documents in the folders Jupiter may use, the **Browser Agent** uses
the web in an isolated session, and on Windows the **Computer Agent** uses
real applications. Everything a page, document or note says is untrusted
data. Nothing Jupiter does with an effect happens without a **permission**
that matches exactly what, who, which target and for how long; _Settings ›
Permissions_ lists them and the audit trail. **Memory**, **Files**,
**Skills**, **Missions** planned by your model, _Chat_, _AI Models_,
_Settings_ and _Diagnostics_ work; the other three screens are labelled
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
packages/core/           Core kernel: capability dispatcher, event bus, service supervisor, logger, IDs; model router, chat, adapter port; Mission Manager, planner and workflow engine; Skill Registry and sandbox; Permission Engine; Computer Agent; Browser Agent; File Agent and Artifact Manager; Memory System and Notes agent
packages/providers/      Provider adapters (OpenAI-compatible, Anthropic), reached only through Core's guarded transport
packages/database/       SQLite (node:sqlite): migrations, transactions, backups, repositories
packages/security/       Secret patterns and redaction
packages/ui/             Visual Design Lock v1: design tokens, fonts, icons, the Jupiter mark
packages/testing/        Launch the real app with Playwright; credential-shaped test values; provider protocol test servers; test websites; document fixtures and independent Office and Markdown checks
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

Long-term memories are in the database (`memories`, with the policy's
decisions in `memory_decisions`, never their content). A sensitive memory you
keep is stored only sealed by the operating system, like an API key. Memories
kept for this session only, and those waiting for your answer, are never
written to disk (waiting ones are discarded after 24 hours). Deleting a memory
erases it from the database files too. The Obsidian vault you connect is
remembered in `<data folder>\notes-vault.json`; before Jupiter changes a note
it keeps a copy in `<data folder>\notes-backups\`. Jupiter never deletes a
note.

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
- [docs/sets/SET-11-memory-and-obsidian.md](docs/sets/SET-11-memory-and-obsidian.md) — SET 11 report and acceptance results
- [docs/decisions/](docs/decisions/) — architecture decision records

## License

MIT
