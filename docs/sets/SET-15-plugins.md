# SET 15 — Plugin Engine and Isolated Runtime

- Status: **all 10 acceptance tests pass**, in-process (real Core, real
  SQLite, Permission Engine and Skill Registry, the real plugin host on
  temporary folders, plugin code in the real plugin runtime — its own
  process under Node's permission model) and in the real Electron
  application (E2E with screenshots, and the packaged build). Local
  `npm run verify`: 13/13 steps PASS (on `63af524`). CI: green on Linux,
  Windows and Legacy (`07bb0f0`, run 36981805616). Evidence: §7 and §12.
- SET 14 was checked first: green in CI and merged (PR #11, `396050e`).
- Choices the person made for this SET:
  - **Source**: plugins that ship with Jupiter (`demo-tools`) and a local
    folder picked in the system dialog, copied into Jupiter after it is
    checked.
  - **Integrity**: the SHA-256 of every file, listed in the manifest; the
    publisher is shown as _Unverified_ (signing is SET 21).
  - **Network**: none for plugins.

## 1. Scope completed

### Manifest and validation

- `manifest.json` fields: `id`, `name`, `version`, `entrypoint`,
  `minimumJupiterVersion`, `permissions`, `skills`, `capabilities`,
  `publisher`, `integrity` (plus `manifestVersion`, `description`).
- Checked before anything runs, and again at every load: the plugin id
  (lower case, 3–40 characters), semantic versions, an entrypoint `.js`
  inside the folder, permissions only from those available to plugins,
  capabilities (handles) only from `PLUGIN_HANDLES`, every permission used
  by a declared handle and every handle's permission declared, each
  Skill's permissions within the plugin's, unique Skill ids, Skill
  metadata and input/output schemas (the SET 6 subset), compatibility
  (`minimumJupiterVersion`), integrity (every file's SHA-256: a missing,
  changed or unlisted file refuses the plugin) and the install source
  (bundled, or Jupiter's own copy of a folder the person picked; never a
  path from a request).

### Plugin Manager

| Operation      | How                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover       | The host lists the bundled plugins and Jupiter's copies, and hashes every file itself                                                          |
| Validate       | `checkPackage`: manifest, rules, Skills, integrity, compatibility                                                                              |
| Install        | Bundled or from a folder (staged, checked, `plugin.install` CRITICAL asked every time, then moved into place)                                  |
| Load / Enable  | Checked again (a file changed on disk is `PLUGIN_TAMPERED`), Skills registered as `<plugin>.<skill>` (runtime `plugin@1`), each health-checked |
| Disable/Unload | Skills unregistered; history kept                                                                                                              |
| Health         | Each Skill's health check in the runtime; `DEGRADED` and `recovered` published when it changes                                                 |
| Update         | Same id, newer, compatible and intact, `plugin.install` asked; the installed version keeps running until it is accepted                        |
| Permissions    | Shown with their risk; each handle is checked by the Permission Engine when used                                                               |
| Skills         | Listed with registration and health; they appear in the Skill Center like any Skill                                                            |
| Uninstall      | Skills unregistered, Jupiter's copy removed (bundled plugins stay available to install again), storage and history kept                        |

States: `INSTALLED`, `DISABLED`, `ENABLED`, `RUNNING` (a run in progress),
`DEGRADED` (a Skill's health check failed), `FAILED` (a load failed, with
its reason), `INCOMPATIBLE` (this Jupiter is older than the plugin needs).

### Isolated runtime

- Plugin code runs only in the plugin runtime: a **new process for each
  run** (Electron as Node) with `--permission` (Node's permission model: no
  file system beyond its own entry script, no child processes, worker
  threads or add-ons), a memory limit, a fixed stack,
  `--disallow-code-generation-from-strings`, an environment of one
  variable (`ELECTRON_RUN_AS_NODE`; on Windows libuv also passes the system
  variables every program needs, such as `SYSTEMROOT` and `PATH`) and no
  stdin or stdout.
- Inside it, the plugin's code runs in a `vm` context with no `require`,
  `process`, `Buffer`, `console`, timers, `fetch`, `WebSocket` or
  `WebAssembly`, and code generation from strings off. Only strings cross
  the boundary; the plugin's only way out is `context.use(handle, args)`.
- Handles: `app.version` (`app.version.read`), `system.time`
  (`system.time.read`), `storage.read` and `storage.list`
  (`plugin.storage.read`, LOW), `storage.write` (`plugin.storage.write`,
  MEDIUM). Each is a Skill resource with a fixed capability and exact
  target, checked when used. An undeclared or unknown handle fails the run
  and discards its output.
- Plugin storage: `<data>/plugin-data/<id>/`; paths checked in Core and
  resolved again by the host (no `..`, absolute paths or links); 200 files,
  1 MB each, 5 MB in all; a write never replaces a file (`name (2).md`).
- Timeout and cancel kill the process; running out of memory is a crash of
  that run only; RPC traffic is validated both ways (1.1 MB limit).
- No network: plugin code has no network API in its sandbox (see §9 for
  the process-level limit of Node 24).

### demo-tools

`plugins/demo-tools/` (`manifest.json`, `index.js`, `README.md`): ships
with Jupiter, publisher _Jupiter Project (Unverified)_.

- `echo_text` — returns the text it is given.
- `get_app_version` — Jupiter's version and channel (`app.version`).
- `save_note` — saves a Markdown note in the plugin's own storage only
  (`storage.write`); never replaces a note.

### Interface

The _Plugins_ screen (no longer _Coming later_): the runtime and its
isolation, the plugins that ship with Jupiter (install), _Install from a
folder…_, and a card per installed plugin — state and reason, version,
publisher _Unverified_, source, integrity (files and when checked),
minimum Jupiter, storage use, permissions with their risk, Skills with
registration and health; enable, disable, check health, update from a
folder, uninstall with confirmation. Refusals are shown with their reasons
and next step. Plugin events are in the activity timeline. English and
Thai.

## 2. Files added or changed

- **Contracts:** `packages/contracts/src/plugins.ts` and its test (new);
  `capabilities.ts` (`plugins.*`), `host-operations.ts`
  (`host.plugins.*`), `events.ts` (`plugin.changed`, stream `plugin`),
  `permissions.ts` (`plugin.storage.read`, `plugin.storage.write`),
  `skills.ts` (provider `plugin`), `core-protocol.ts` (room for more host
  operations, §7), `index.ts`.
- **Plugin runtime:** `services/plugin-runtime/` (was a placeholder:
  runtime, sandbox, bundler, integration test).
- **Core:** `packages/core/src/plugins/` (new: `validate.ts`,
  `manager.ts`); `skills/registry.ts` (sandbox chosen by runtime, targets
  that depend on the caller), `skills/sandbox.ts`, `skills/builtin.ts`
  (`handler`); `kernel/core-kernel.ts` (service `plugin-manager`),
  `kernel/capabilities.ts`, `ports.ts`, `index.ts`.
- **Database:** migration 13 `0013_plugins`, `repositories/plugins.ts`
  (new), `jupiter-database.ts`.
- **Host:** `apps/desktop/src/main/plugin-host.ts` (new);
  `host-capabilities.ts` and its test, `index.ts` (folders, dialog,
  `JUPITER_TEST_PLUGIN_CHOICE` in the test environment), `services.ts` (the
  planned `plugin-runtime` entry removed); `src/core/index.ts` (the
  plugin sandbox); `electron.vite.config.ts` (bundles the runtime, copies
  `plugins/`), `package.json`.
- **Renderer:** `views/PluginsView.tsx`, `pluginText.ts` (new); `App.tsx`,
  `destinations.ts` (Plugins built), `components/ActivityTimeline.tsx`,
  `errorText.ts`, `i18n/en.ts`, `i18n/th.ts`, `i18n/i18n.test.ts`,
  `styles.css`.
- **Plugins:** `plugins/demo-tools/` (new), `plugins/README.md`;
  `scripts/plugin-integrity.mjs` (new); `.gitattributes` (plugin files
  byte-exact).
- **Testing:** `packages/testing/src/plugins.ts` (new: demo-tools copies
  and test plugins with computed integrity).
- **Tests:** `apps/desktop/test/plugins-core.integration.test.ts`,
  `plugin-host.integration.test.ts`, `plugins.integration.test.ts` (E2E),
  `core-harness.ts`, `packaged.integration.test.ts`; earlier suites updated
  (§12); `scripts/validate-package.mjs`.
- **Docs:** ADR 0016, `ARCHITECTURE.md`, `SECURITY.md`, `README.md`,
  `AGENTS.md`, this report and `docs/sets/set-15/`.

## 3. Architecture decisions

[ADR 0016](../decisions/0016-plugins.md):

- a plugin is data plus one script, checked (manifest, rules, Skills,
  SHA-256 of every file, compatibility) before anything runs and at every
  load;
- the host owns every folder; a picked folder is staged and moved into
  place only after it is accepted;
- plugin code runs only in a new process per run under Node's permission
  model, inside a `vm` context that reaches Jupiter only through declared
  handles, each a permission-checked Skill resource;
- states are derived from what is true (stored row, last load, runs in
  progress, health), never written as a claim.

## 4. Database migrations

Migration 13 `0013_plugins` (appended; earlier migrations unchanged): table
`plugins` (`plugin_id` primary key, `version`, `source` bundled or local,
`enabled`, `manifest_json` — the manifest that was accepted, compared at
every load —, `installed_at`, `updated_at`, `verified_at`, `last_error`). A
backup is taken before the upgrade, as for every migration.

## 5. Security implications

- Third-party code never runs in Electron main, Core or the renderer.
- Defence in depth for a plugin run: separate process, Node's permission
  model, none of Jupiter's environment, memory and time limits, `vm` without Node or
  network globals, code generation off, strings only across the boundary.
- Every effect goes through a handle the manifest declares, the Skill
  declares, and the Permission Engine allows at the moment of use.
- Installing and updating are CRITICAL (Allow once or Deny, every time);
  only the person manages plugins; the publisher is never shown as
  verified.
- A changed, missing or extra file refuses a plugin at install, update and
  load; an update never replaces the installed version until it is
  accepted.
- Plugin storage cannot leave its folder, follow a link, exceed its quota
  or replace a file; uninstalling keeps it.
- No secret, credential or environment value reaches a plugin (AT9).

## 6. Commands actually run

```bash
npm ci
npm run typecheck
npm run lint
npx vitest run --project unit
node scripts/with-display.mjs npx vitest run --project integration services/plugin-runtime apps/desktop/test/plugins-core.integration.test.ts apps/desktop/test/plugin-host.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/plugins.integration.test.ts
npm run package:linux:dir && node scripts/validate-package.mjs --platform linux
JUPITER_PACKAGED_EXECUTABLE=apps/desktop/dist/linux-unpacked/jupiter node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/packaged.integration.test.ts
node scripts/plugin-integrity.mjs plugins/demo-tools
npm run verify
```

## 7. Automated test results

### Local run

`npm run verify` on Linux (Xvfb, a throwaway GNOME Keyring, Tesseract), on
commit `63af524`: **13/13 steps PASS**, exit 0. (`07bb0f0` changes only the
Windows branch of one runtime test assertion, a code comment and documents;
CI ran everything on it.)

- unit tests: 34 files, 301 tests
- integration and Electron E2E: 54 files passed and 2 skipped; 402 tests
  passed and 18 skipped (the Windows-only SET 8 suites, the Windows
  installer check and the packaged-app suite, which runs as its own step)
- secret scan, development-mode launch, Windows and Linux unpacked builds
  and their validation: PASS
- packaged-app launch: 7 tests, including installing demo-tools and running
  its Skill in the plugin runtime from inside the package

The SET 15 suites:

| Suite                                                      | Tests | What it runs                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/plugins.test.ts`                   | 5     | A valid manifest; bad ids, versions, entrypoints and unknown fields; permissions plugins cannot have and Skills reaching beyond the plugin; relative paths; semantic version order                                        |
| `services/plugin-runtime/test/runtime.integration.test.ts` | 6     | The real runtime process: a run, handles, no globals and no escapes, timeout and cancel, a throw, an exit and running out of memory, and a probe of the process itself (none of Jupiter's environment, no files or shell) |
| `apps/desktop/test/plugin-host.integration.test.ts`        | 3     | The host lists and hashes files itself and reports links and odd names; staging and commit; storage paths, links, quotas, no overwrite                                                                                    |
| `apps/desktop/test/plugins-core.integration.test.ts`       | 10    | Real Core, SQLite, Permission Engine, Skill Registry, host and runtime: AT1–AT10                                                                                                                                          |
| `apps/desktop/test/plugins.integration.test.ts`            | 6     | The real Electron app: the Plugins screen, install with the permission dialog, Skills, a refused manifest, refused and accepted updates, disable and uninstall                                                            |
| `apps/desktop/test/packaged.integration.test.ts`           | 1 new | The packaged app installs demo-tools and runs its Skill in the plugin runtime from inside the package                                                                                                                     |
| `apps/desktop/src/main/host-capabilities.test.ts`          | 1 new | The host operation list fits the Core protocol                                                                                                                                                                            |

### Found and fixed during the SET

| Found                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jupiter Core never started in the app: with seven plugin host operations the host's list (34) exceeded the Core protocol's limit (32), and Core dropped its `init` message without a word | The limit is 128, and a unit test checks the host's list against the protocol                                                                                                                                                                  |
| Installing from a folder asked for the folder twice (before and after the permission answer)                                                                                              | The staged copy waits for the answer to `plugin.install`; the retry after _Allow_ installs exactly that copy; any other answer, or ten minutes, discards it                                                                                    |
| The `vm` context still had `console` (and `WebAssembly`)                                                                                                                                  | Both removed from the context                                                                                                                                                                                                                  |
| A storage path that leaves the folder came back as `PLUGIN_FAILED` (the host's input schema refused it first)                                                                             | Core checks the path itself and answers `PLUGIN_PATH_INVALID`                                                                                                                                                                                  |
| `PluginInfo.storage` carried the host's `op` field and failed the output schema                                                                                                           | Only the three fields are copied                                                                                                                                                                                                               |
| CI (first run): the secret scan found the key-shaped test value in AT9, and the Core bundle imported `node:module` (a `createRequire` shim triggered by a method named `require`)         | AT9 uses `@jupiter/testing/fake-credentials` and now asserts the key appears nowhere in the plugin's results; the method renamed; `node:child_process` and `node:url` (starting the plugin runtime) added to the Core bundle's allowed imports |
| CI (Windows): the runtime test expected an empty environment, but libuv passes the Windows system variables to every new process                                                          | The test allows exactly those on Windows (and nothing else, no secret) and is unchanged elsewhere; the documents say so                                                                                                                        |
| Staging folders left by a crash would stay                                                                                                                                                | The host empties staging when it starts (it only ever holds Jupiter's own temporary copies)                                                                                                                                                    |

### CI

Evidence: commit `07bb0f0`, run 36981805616. All three jobs succeeded
(Linux job 110757782404, Windows job 110757782492, Legacy job
110757782266).

| Job                                                                                                                                  | Result  | Notes                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| Linux — format, lint, typecheck, unit, build, integration + E2E, secret scan, dev smoke, Windows and Linux packages, packaged launch | success | Package validation PASS (41 entries in `app.asar`); packaged launch 7/7, demo-tools installed and run      |
| Windows — typecheck, unit, build, integration + E2E, NSIS installer, package validation, packaged launch                             | success | The plugin runtime ran under Node's permission model on Windows; NSIS installer valid; packaged launch 7/7 |
| Legacy Thursday — build and acceptance suite                                                                                         | success |                                                                                                            |

Earlier runs on this PR:

- **Run 36976378562** (`3bac3d2`): Linux failed two tests — the secret scan
  found the key-shaped value in AT9, and the Core bundle's import check
  found `node:module` (a `createRequire` shim), `node:child_process` and
  `node:url`. Fixed in `63af524` (§7, found and fixed).
- **Run 36978008251** (`63af524`): Linux and Legacy succeeded. Windows
  first died in setup (a 504 from GitHub downloading Tesseract's Thai data,
  before any test ran) and was re-run once; the re-run failed one test —
  the plugin runtime's environment on Windows holds the system variables
  libuv always passes (410 other tests passed). Fixed in `07bb0f0`.

## 8. Manual tests

None beyond the automated ones: every step a person takes on the Plugins
screen (install with the permission dialog, enable, run, refused folders,
update, disable, uninstall with confirmation) runs in the E2E suite against
the real application, with screenshots (§11).

## 9. Known limitations

- **Network at the process level.** Electron 44 ships Node 24, whose
  permission model has no `--allow-net`; the plugin process is not denied
  the network by it. Plugin code has no network API in its sandbox (no
  `require`, `fetch`, sockets) and its process has none of Jupiter's environment, files or
  child processes; when Electron ships Node 25 the runtime will add the
  network to the permission model.
- **Windows system variables.** On Windows, libuv always gives a new
  process the variables Windows programs need (`HOMEDRIVE`, `HOMEPATH`,
  `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`,
  `USERNAME`, `USERPROFILE`, `WINDIR`); none is a secret, and plugin code
  cannot read them (no `process` in its sandbox). The runtime test checks
  that nothing else of Jupiter's environment arrives.
- **A `vm` context is not a security boundary by itself**; here it is the
  inner layer inside a restricted process.
- **Publishers are not verified** (shown as _Unverified_); signing is SET 21.
- Handles are limited to Jupiter's version, the time and plugin storage.
  Plugins have no interface of their own, and there is no catalogue or
  download.
- Each run starts a process: start-up time on every run.
- `get_app_version`'s health is _Not checked_ until `app.version.read` is
  granted to it (never assumed), and `save_note` has no health run (it
  would write a note).

## 10. How to run

```bash
npm ci && npm run dev
```

1. _Plugins_: the runtime is _Ready_; _demo-tools_ is listed under _Ships
   with Jupiter_.
2. _Install_: allow `plugin.install` (Allow once). The plugin is
   _Installed_; _Enable_ makes it _Enabled_ with its three Skills.
3. _Skills_: run `demo-tools.echo_text`, or `demo-tools.save_note` (allow
   `plugin.storage.write`): the note is in
   `<data>/plugin-data/demo-tools/notes/`.
4. _Install from a folder…_ or _Update from a folder…_: pick a plugin
   folder; a changed file or a newer Jupiter requirement is refused with
   its reasons.
5. _Disable_, then _Uninstall_: the Skills are gone, their history and the
   plugin's notes stay.

## 11. Evidence and artifact paths

- `docs/sets/set-15/*.png`: the E2E screenshots (also written to
  `test-results/set-15/` on each run)
- `test-results/package-validation-linux.json`: package validation
- CI run 36981805616 (commit `07bb0f0`): Linux job 110757782404, Windows
  job 110757782492, Legacy job 110757782266; artifacts
  `jupiter-linux-evidence` and `jupiter-windows-installer`
- Earlier runs 36976378562 and 36978008251: the failures and fixes in §7

## 12. Acceptance tests

| #   | Test                                     | Status   | Evidence (`plugins-core.integration.test.ts` unless noted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Valid plugin loads                       | **PASS** | demo-tools listed as valid, installed after `plugin.install` (CRITICAL, Allow once or Deny only), enabled: `ENABLED`, publisher unverified, 2 files checked, three Skills registered; after a Core restart it is loaded (and checked) again. E2E: installed through the permission dialog and enabled (screenshots 02, 03); packaged build: installed and run from inside the package                                                                                                                                        |
| 2   | Invalid manifest rejected                | **PASS** | A bad id, version and entrypoint; unknown permissions and an undeclared Skill permission; a manifest that is not JSON — each refused with `PLUGIN_INVALID` and its reasons, `install-rejected` published, nothing installed, staging empty. E2E: refused from a folder with the reasons shown, no permission asked (screenshot 05)                                                                                                                                                                                           |
| 3   | Skill registers and executes             | **PASS** | Three Skills registered with provider `plugin`, runtime `plugin@1`; `echo_text` returns Thai text unchanged; `get_app_version` asks for its own `app.version.read` and returns the version. E2E: `echo_text`, `get_app_version` and `save_note` each asking for their own permission; the note written in plugin storage; a second note never replaces the first (screenshot 04)                                                                                                                                             |
| 4   | Undeclared permission denied             | **PASS** | A plugin that calls `storage.write` without declaring it: the run fails with `PERMISSION_DENIED`, nothing is asked, nothing is written                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | Storage sandbox prevents escape          | **PASS** | `../../escape`, `../../../../tmp/escape`, `a/../../b`, `..` refused with `PLUGIN_PATH_INVALID`; a link (a junction on Windows) planted in the storage is not followed and nothing appears outside; a second note gets `today (2).md`. Host test: absolute paths, links and quotas (`PLUGIN_STORAGE_FULL`)                                                                                                                                                                                                                    |
| 6   | Broken plugin isolated                   | **PASS** | A plugin whose Skills throw, call `process.exit`, eat memory and return bad output: `DEGRADED` with its reason, each run fails on its own (`SKILL_UNHEALTHY`, `PLUGIN_FAILED`, `SKILL_CRASHED`, `SKILL_OUTPUT_INVALID`), and Jupiter and demo-tools keep working                                                                                                                                                                                                                                                             |
| 7   | Timeout and cancellation                 | **PASS** | An endless loop is stopped at its 2-second timeout (`TIMEOUT`, process killed); a long run is `RUNNING`, cancelled (`CANCELLED`), and the plugin is `ENABLED` again                                                                                                                                                                                                                                                                                                                                                          |
| 8   | Disable removes Skills safely            | **PASS** | Disabled: no plugin Skill registered, `SKILL_NOT_FOUND`, execution history kept; enabled again it works; uninstalled: gone from the list, history and storage kept. E2E: disabled, Skills gone; uninstall after confirmation; the notes and execution history stay (screenshots 09–11)                                                                                                                                                                                                                                       |
| 9   | No secrets or shell                      | **PASS** | With a key in the vault: no `require`, `process`, `Buffer`, `fetch`, `WebSocket`, timers or `console` in the sandbox; `Function` constructors, `eval` and `import()` refused; `/etc/passwd` through storage refused; reaching for credentials, the vault, a shell, files, the network or `skills.list` fails the run; a plugin declaring `shell.execute` is refused at install. Runtime test: the process gets none of Jupiter's environment (on Windows only the system variables libuv passes), no files, shell or workers |
| 10  | Incompatible or tampered update rejected | **PASS** | Refused: needs Jupiter 99 (`PLUGIN_INCOMPATIBLE`), a changed `index.js` and an unlisted file (`PLUGIN_INVALID`), not newer (`PLUGIN_NOT_NEWER`), another plugin's folder; 1.0.0 keeps running throughout; a valid 1.1.0 is accepted after `plugin.install` (refused once by the person: the folder is asked again); a file changed on disk after install is refused at the next load (`PLUGIN_TAMPERED`, `FAILED`). E2E: screenshots 06–08                                                                                   |

### SET 0–14 re-check (on the SET 15 code)

All earlier suites pass in the same `npm run verify` run. They were updated
only where SET 15 changed facts:

- **SET 1/2 app test:** the `plugin-manager` Core service is listed as
  running; no service is _Coming later_ any more (the planned
  `plugin-runtime` entry is gone), so the retry of a planned service is
  covered by the supervisor's unit test; one destination (Automations) is
  _Coming later_.
- **SET 2 shell test:** _Plugins_ is no longer among the unfinished
  screens.
