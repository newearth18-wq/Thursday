# Jupiter

Jupiter is a Windows desktop AI agent, built in stages (SET 0–24). This
repository is the Jupiter monorepo.

**Current stage: SET 0 — Repository foundation and delivery contract.** Jupiter
opens as a real desktop app showing its name, the version from build metadata
and the real status of its foundation services. It **cannot do any AI work
yet**: every capability that isn't built is labelled _Coming later_ in the app,
and none of them is presented as working.

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

| Script                            | What it does                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`                     | Development mode: Vite dev server + Electron, development data folder, DevTools allowed |
| `npm run build`                   | Production build of main, preload and renderer into `apps/desktop/out/`                 |
| `npm run start`                   | Launch the production build without packaging it                                        |
| `npm test`                        | Unit tests, then build, then integration + Electron end-to-end tests                    |
| `npm run test:unit`               | Unit tests only (fast, no Electron)                                                     |
| `npm run test:integration`        | Build, then real-filesystem, secret-scan and Electron E2E tests (uses xvfb on Linux)    |
| `npm run test:dev-smoke`          | Proves `npm run dev` really launches the app                                            |
| `npm run lint`                    | ESLint with full type information, zero warnings allowed                                |
| `npm run typecheck`               | Strict TypeScript across every workspace                                                |
| `npm run format` / `format:check` | Prettier                                                                                |
| `npm run check:secrets`           | Scan the repository for hardcoded credentials                                           |
| `npm run package:windows`         | Windows NSIS installer (on Windows, or anywhere with Wine)                              |
| `npm run package:windows:dir`     | Unpacked Windows build (works on Linux)                                                 |
| `npm run package:validate`        | Validate the Windows package and write evidence to `test-results/`                      |
| `npm run verify`                  | Every gate above, in order — run before opening a pull request                          |

## Repository layout

```text
apps/desktop/            Jupiter desktop shell (Electron main, sandboxed preload, React renderer)
packages/contracts/      Versioned zod schemas for every trust boundary
packages/core/           IDs, environments, redacting structured logger, service supervisor
packages/security/       Secret patterns and redaction
packages/ui/             Visual Design Lock v1 tokens, fonts, the Jupiter mark
packages/testing/        Launch the real app with Playwright; credential-shaped test values
packages/database/       Coming later (SET 1)
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
anything is written.

## Documentation

- [AGENTS.md](AGENTS.md) — rules for anyone (human or AI) changing this repository
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the foundation fits together
- [SECURITY.md](SECURITY.md) — security principles and their current enforcement
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, checks and conventions
- [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md) — when a SET is complete
- [docs/sets/SET-00-foundation.md](docs/sets/SET-00-foundation.md) — SET 0 report and acceptance results
- [docs/decisions/](docs/decisions/) — architecture decision records

## License

MIT
