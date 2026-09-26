# Contributing to Jupiter

Read [AGENTS.md](AGENTS.md) first: it holds the rules every change must follow.

## Setup

```bash
nvm use            # Node.js 22 (see .nvmrc); 22.12 or newer is required
npm ci             # always install from the lockfile
npm run dev        # Jupiter in development mode
```

Electron downloads its binary the first time it is launched (for example by
`npm run dev` or the first E2E test), not during `npm ci`.

On Linux the Electron tests need a display; `scripts/with-display.mjs` wraps
them in `xvfb-run` when `$DISPLAY` is not set (`sudo apt-get install xvfb`).

## Workflow

1. Branch from `main`.
2. Make the change within the current SET's scope only.
3. Add or update tests with the behaviour: unit tests beside the code
   (`*.test.ts`), integration tests as `*.integration.test.ts`, and an E2E test
   in `apps/desktop/test/` for anything a person can see or do.
4. Run `npm run verify`. It stops at the first failure and says which gate failed.
5. Open a pull request. CI runs the same gates on Linux, builds and launches
   the real Windows installer build on Windows, and runs the legacy Thursday
   suite.

## Quality gates

| Gate              | Command                                                   | Rule                                                                                                                       |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Format            | `npm run format:check`                                    | Prettier, no diffs                                                                                                         |
| Lint              | `npm run lint`                                            | typescript-eslint strict + stylistic with type information, zero warnings; the renderer may not import Node.js or Electron |
| Types             | `npm run typecheck`                                       | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` in every workspace              |
| Unit              | `npm run test:unit`                                       | Vitest                                                                                                                     |
| Integration / E2E | `npm run test:integration`                                | real filesystem, real child processes, real Electron app                                                                   |
| Secrets           | `npm run check:secrets`                                   | no credential-shaped strings in tracked or new files                                                                       |
| Dev mode          | `npm run test:dev-smoke`                                  | `npm run dev` must really launch the app                                                                                   |
| Package           | `npm run package:windows:dir && npm run package:validate` | Windows build is well-formed and self-contained                                                                            |

## Conventions

- TypeScript everywhere; ESM modules; no default exports in library code.
- Schemas first: new data that crosses a boundary gets a zod schema in
  `packages/contracts`, and the TypeScript type is inferred from it.
- IDs are UUIDv7 (`uuidv7()`); timestamps are UTC ISO strings.
- Log with `logger.<level>(event, message, data)`, where `event` is a stable
  dotted name (`service.start.failed`). Never log prompts, document contents,
  screenshots, audio, biometrics or secrets.
- UI copy lives in `apps/desktop/src/renderer/src/i18n/{en,th}.ts`; both
  languages must define every key (a unit test checks).
- Commit messages: imperative mood, explain _why_ in the body.

## Versioning and releases

The app version lives only in `apps/desktop/package.json`. Build metadata
(channel, commit, build ID, build time) is generated at build time; nothing in
the UI hardcodes a version. Each completed SET is tagged
`jupiter-set-NN-<name>`.
