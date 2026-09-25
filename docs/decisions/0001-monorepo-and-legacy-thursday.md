# ADR 0001 — Jupiter monorepo, and preserving Thursday Browser as legacy

- Status: accepted (SET 0)
- Date: 2026-09-25

## Context

The repository contained _Thursday Browser Alpha_: a working Electron 38 +
React 18 app (browser tabs, AI providers, plugin engine, missions, workflows)
with a passing 32-check acceptance suite. SET 0 asks for a Jupiter monorepo
foundation and a shell that shows only real, available functionality.

Thursday's features overlap SETs 1, 3, 4, 5, 6, 9 and 15 but do not follow the
Jupiter contracts. For example, API keys fall back to plaintext when no OS
keychain exists (Global Contract 12), mission states differ from SET 4, and its
Electron 38 has 19 published advisories (fixed in 44.x). Showing those features
in Jupiter's SET 0 shell would present work from later SETs as done, against
contracts it does not meet.

## Decision

1. Move Thursday unchanged (with `git mv`, keeping its history) to
   `legacy/thursday-browser/`, with its own `package.json`, lockfile and CI job.
   It is **not** an npm workspace, so its old toolchain never affects Jupiter's
   dependency graph, and its user data folder (`thursday-browser`) is untouched.
2. Build the Jupiter monorepo at the root on the same kind of stack
   (Electron + React + strict TypeScript + electron-vite + npm), upgraded to
   supported, patched versions: Electron 44, React 19, TypeScript 6, Vite 7,
   electron-vite 5, zod 4, Vitest 5, ESLint 10.
3. Later SETs may port Thursday modules (provider adapters, the out-of-process
   plugin host, JSON Schema validation) into Jupiter packages, but only after
   rewriting them against Jupiter's contracts and tests.

## Consequences

- Existing working code and its tests are preserved and still run in CI.
- Jupiter starts from a clean, reproducible, auditable foundation with 0 known
  dependency vulnerabilities at the time of SET 0.
- Two Electron versions are downloaded in CI (one per project).
- Legacy code is excluded from Jupiter lint/format; it is included in the
  repository secret scan.
