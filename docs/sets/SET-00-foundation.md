# SET 0 — Repository foundation and delivery contract

- Status: **all 10 acceptance tests pass**, locally on Linux and in CI on
  Linux and Windows (commit `918579f`, run 36128645246).
- Checkpoint tag: `jupiter-set-00-foundation` on `918579f` — created as an
  annotated tag in the development environment; publishing it
  (`git push origin jupiter-set-00-foundation`) is left to the repository owner,
  because that environment could push branches only.
- Environment of the recorded run: Linux x64 container (root, Xvfb), Node.js
  22.22.2, npm 10.9.7, Electron 44.4.5 (Chromium 152.0.7977.130, Node 24.21.0).

## 1. Scope completed

- Baseline inspection. The repository held _Thursday Browser Alpha_ (Electron 38,
  React 18, 11.8k lines). It installed, built and passed its 32-check suite, but
  had no lint, unit tests or formatter, no log redaction or rotation, and
  Electron 38 carries 19 published advisories. It was moved unchanged to
  `legacy/thursday-browser/` with its own lockfile and CI job, and still passes
  24/24 + 8/8 ([ADR 0001](../decisions/0001-monorepo-and-legacy-thursday.md)).
- npm-workspaces monorepo: `apps/desktop`, `packages/{contracts,core,security,ui,testing,database}`,
  `services/{agent,browser,plugin}-runtime`, `plugins`, `docs`, `scripts`.
- Tooling: Prettier, ESLint (typescript-eslint strict + stylistic with type
  information), strict TypeScript 6, Vitest 5 (unit + integration projects),
  Playwright-driven Electron E2E, electron-builder packaging.
- Environments `development` / `test` / `production`, each with its own data
  folder, log level and DevTools policy.
- Build metadata (name, version, channel, commit, dirty flag, build ID, build
  time) generated at build time, validated, injected into main only.
- Structured JSON logs with redaction, 5 MB × 5 rotation, owner-only files,
  session and correlation IDs, buffering with loss accounting.
- Crash-safe startup, service supervisor with truthful FAILED/DEGRADED states
  and working Retry, React error boundary, renderer crash/load-failure recovery.
- Desktop shell: Home (name, version, channel, environment, runtime status,
  recovery notices, planned services), Diagnostics, read-only Settings; the
  eight unbuilt destinations are labelled _Coming later_; English and Thai.
- Security baseline: context isolation, sandbox, no Node in the renderer, a
  five-function frozen bridge, allowlisted and validated IPC with sender
  checks, strict CSP, navigation/window/webview/download/permission blocking.
- Documentation (README, AGENTS.md, CONTRIBUTING, SECURITY, architecture,
  definition of done, ADR) and CI (Linux gates, Windows installer + E2E,
  legacy suite).

Not started: anything from SET 1 onward (database, event bus, capability
dispatcher, design-system screens, providers, …). They appear only as
_Coming later_.

## 2. Files added or changed

Added: root `package.json`, `package-lock.json`, `tsconfig.base.json`,
`tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`,
`.prettierignore`, `.editorconfig`, `.nvmrc`, `README.md`, `AGENTS.md`,
`CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`; `apps/desktop/**`;
`packages/{contracts,core,security,ui,testing}/**`; placeholder
`packages/database`, `services/*`, `plugins/README.md`; `docs/ARCHITECTURE.md`,
`docs/DEFINITION_OF_DONE.md`, `docs/decisions/0001-…`, this report and
`docs/sets/set-00/*.png`; `scripts/{verify,check-secrets,validate-package,with-display,dev-smoke}.mjs`.

Changed: `.github/workflows/ci.yml` (three jobs), `.gitignore`.

Moved (content unchanged except a banner in its README): the whole Thursday
Browser into `legacy/thursday-browser/`.

## 3. Architecture decisions

- Keep the existing stack family (Electron + React + TypeScript + electron-vite
  - npm), upgraded to supported versions with 0 known vulnerabilities.
- Preserve Thursday as a separate, non-workspace legacy project (ADR 0001).
- Workspace packages are TypeScript source bundled into the app; the packaged
  app contains no `node_modules`.
- Schemas first (zod 4): every boundary type is inferred from a schema in
  `packages/contracts`. Appendix A `ErrorEnvelope` and `ServiceHealth` are used
  as specified.
- Minimal SET 0 IPC surface (`jupiter:v0:*`, 4 invokes + 1 event), to be
  replaced by SET 1's versioned command/event contract.
- UUIDv7 IDs and UTC ISO timestamps everywhere.
- A static Jupiter mark (core, two orbital rings, eyes of light) following the
  Visual Design Lock; no animation until SET 16 can drive it from real state.

## 4. Database migrations

None. SET 0 has no database (SET 1).

## 5. Security implications

See [SECURITY.md](../../SECURITY.md) for the enforced controls. Notes:

- Tests in containers/CI pass `--no-sandbox` because Chromium's OS sandbox
  cannot run as root or under Ubuntu's user-namespace restriction; Jupiter then
  skips `app.enableSandbox()` and Diagnostics shows "Disabled by --no-sandbox".
  Renderer isolation is unaffected and verified.
- The E2E test reads effective web preferences through Electron's internal
  `getLastWebPreferences()` accessor (not in public typings); behavioural
  checks (no `require`/`process`/`module` in the page) back it up.
- No credentials exist anywhere yet; the credential store is SET 3.

## 6. Commands actually run

```bash
# baseline (before any change)
npm ci && npm run build && xvfb-run -a npm run test:acceptance         # Thursday: 24/24 + 8/8
npm audit                                                              # 19 Electron advisories (legacy)
# final, from a clean tree (node_modules, out/, dist/ deleted)
npm ci                                                                 # 0 vulnerabilities
npm run verify                                                         # 13/13 steps PASS
npm run check:secrets                                                  # 205 files, 0 findings
git log -p --all | findSecrets                                         # full history, 0 findings
cd legacy/thursday-browser && npm ci && npm run build && xvfb-run -a npm run test:acceptance   # 24/24 + 8/8
npm run package:windows                                                # fails on Linux: needs Wine (see test 4)
```

`npm run verify` runs: format:check, lint, typecheck, test:unit, build,
integration + E2E (under xvfb), secret scan incl. build output, dev-mode smoke
test, Windows unpacked build + validation, Linux unpacked build + validation,
packaged-app launch test.

## 7. Automated test results

| Suite                                      | Result                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Unit (Vitest, 12 files)                    | **107 passed**, 0 failed                                                                                        |
| Integration (5 files)                      | **22 passed**, 0 failed, 2 skipped — the packaged-app tests, which run only when a packaged executable is given |
| Packaged-app launch (Linux unpacked build) | **2 passed**, 0 failed                                                                                          |
| Development-mode smoke                     | **4/4 checks** passed                                                                                           |
| Windows package validation                 | **6/6 checks** passed (unpacked build)                                                                          |
| Linux package validation                   | **5/5 checks** passed                                                                                           |
| Legacy Thursday acceptance                 | **24/24 + 8/8** passed                                                                                          |

The integration project includes 9 real-Electron E2E tests (healthy start,
build-metadata version, Diagnostics/Settings links, renderer isolation,
navigation blocking, IPC rejection, redacted logs, service-failure recovery,
Thai UI), 5 build-output checks, 6 real-filesystem log tests and 2 secret-scan
tests.

### CI evidence (commit `918579f`)

| Job                                                                                                                                                                                                                                      | Result  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Linux — gates, tests, package validation                                                                                                                                                                                                 | success |
| Windows — unit 107/107, integration 21 passed + 3 skipped (POSIX-only permission test; packaged tests run later), NSIS installer `Jupiter-Setup-0.1.0-alpha.0-x64.exe` (106.4 MB) built and validated, packaged `Jupiter.exe` launch 2/2 | success |
| Legacy Thursday — build and 24 + 8 acceptance checks                                                                                                                                                                                     | success |

The first CI run (`2997aa5`) failed only in the package validator on Windows:
`@electron/asar` looks up archive paths with the native separator, so
`out/main/index.js` was not found. Fixed in `918579f`.

## 8. Manual tests

- Launched the built app under Xvfb and inspected screenshots at 1366×768:
  [home (English)](set-00/home-en.png), [home (Thai)](set-00/home-th.png),
  [service failure with Retry](set-00/service-failure-en.png),
  [Diagnostics](set-00/diagnostics-en.png). Thai text renders with Noto Sans
  Thai, marks not clipped. These screenshots come from a build of uncommitted
  work, so Diagnostics truthfully shows "(uncommitted changes)".
- The screenshots found a defect that the tests had not: the failure message
  repeated its cause. Fixed in `describeError`, with a unit test.

## 9. Known limitations

- The NSIS installer is built on Windows only (electron-builder needs Wine on
  Linux); the `jupiter-windows` CI job builds, validates and launches it.
- The installer was built and launched on a Windows Server CI runner, not yet
  installed by hand on a Windows 10/11 desktop.
- Installer is unsigned and uses the default Electron icon (SET 20).
- Language follows the OS; there is no in-app switch yet (SET 2).
- Settings are read-only (SET 2). Diagnostics shows SET 0 data only; database
  state and recent errors arrive in SET 1.
- Electron downloads its binary on first launch, not during `npm ci`.

## 10. How to run

```bash
npm ci
npm run dev                  # development
npm run build && npm start   # production build, unpackaged
npm run verify               # all gates
npm run package:windows      # installer (on Windows)
```

To see the recovery flow: create a file named `logs` inside the data folder
(for example `%APPDATA%\Jupiter (Development)\logs`), start Jupiter, then
delete the file and press **Retry**.

## 11. Evidence and artifact paths

- `test-results/package-validation-win.json`, `test-results/package-validation-linux.json`
  (SHA-256 of `Jupiter.exe`, `app.asar`, and the installer when present)
- `apps/desktop/dist/win-unpacked/Jupiter.exe`, `apps/desktop/dist/linux-unpacked/jupiter`
- `docs/sets/set-00/*.png`
- CI artifacts: `jupiter-windows-installer` (installer + evidence),
  `jupiter-linux-evidence`

## 12. Acceptance tests

| #   | Test                                                                                | Status                     | Evidence                                                                                     |
| --- | ----------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Clean install from lockfile succeeds                                                | **PASS**                   | `npm ci` from a deleted `node_modules`: 0 vulnerabilities                                    |
| 2   | Development mode launches the Electron app                                          | **PASS**                   | `npm run test:dev-smoke`: dev environment, UI from dev server, IPC round trip, runtime ready |
| 3   | Production build succeeds                                                           | **PASS**                   | `npm run build`; build-output tests                                                          |
| 4   | Windows package produces an installer, or a validated unpacked build on non-Windows | **PASS** (unpacked, Linux) | `validate-package --platform win` 6/6; installer on Windows CI                               |
| 5   | Lint and strict typecheck pass                                                      | **PASS**                   | 0 errors, 0 warnings                                                                         |
| 6   | Test runner passes a real smoke test                                                | **PASS**                   | 107 unit + 22 integration + 2 packaged                                                       |
| 7   | Renderer has no direct Node integration                                             | **PASS**                   | E2E globals + web preferences + CSP; lint rule; build-output scan                            |
| 8   | No hardcoded secrets or credentials                                                 | **PASS**                   | sources, build output, packaged asar and git history: 0 findings                             |
| 9   | App version comes from build metadata, not the UI                                   | **PASS**                   | E2E compares UI, IPC and main with `package.json`; renderer bundle has no version string     |
| 10  | A service startup failure gives a truthful recoverable error                        | **PASS**                   | E2E: blocked log folder → FAILED + real `EEXIST` + next step + Retry; recovers once fixed    |
