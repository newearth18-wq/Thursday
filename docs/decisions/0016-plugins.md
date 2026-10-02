# ADR 0016 — Plugins: checked packages, a process per run under Node's permission model, handles behind permissions

- Status: accepted (SET 15)
- Date: 2026-10-02

## Context

SET 15 asks for a Plugin Engine: a manifest (id, name, version, entrypoint,
minimum Jupiter version, permissions, Skills, capabilities, publisher,
integrity), validation of all of it, a Plugin Manager (discover, validate,
install, load, enable, disable, unload, health, update, permissions, Skills,
uninstall), the states `INSTALLED`, `DISABLED`, `ENABLED`, `RUNNING`,
`DEGRADED`, `FAILED` and `INCOMPATIBLE`, and an isolated runtime:
third-party code must never run in Electron main or the renderer, may use
only declared and granted handles, has no files, secrets, camera,
microphone, network, shell or Electron, gets plugin-scoped storage with safe
paths and quotas, has timeouts, limits and cancel, and cannot crash
Jupiter. Disabling or uninstalling removes its Skills and keeps Mission
history; an update needs compatibility and integrity checks. A
`demo-tools` plugin provides `echo_text`, `get_app_version` and `save_note`
(which writes only to plugin storage).

The person chose (asked at the start of SET 15): plugins that ship with
Jupiter plus a local folder the person picks; integrity by the SHA-256 of
every file listed in the manifest, with the publisher shown as
_Unverified_ (signing is SET 21); and no network at all for plugins.

The Skill Registry and its `vm` worker sandbox (SET 6), the Permission
Engine (SET 7) and the runtime-process pattern of the document, browser
and identity runtimes (SET 9, 10, 14) exist. The SET 6 sandbox is explicitly
not a boundary for hostile code.

## Decision

1. **A plugin is data plus one script, checked before anything runs.**
   `PluginManifest` (`packages/contracts/src/plugins.ts`) is strict:
   a lower-case id, semver versions, a `.js` entrypoint inside the folder,
   permissions only from `PLUGIN_PERMISSIONS`, capabilities only from
   `PLUGIN_HANDLES`, every declared permission used by a declared handle and
   every handle's permission declared, Skill permissions within the
   plugin's, Skill schemas in the SET 6 subset. `checkPackage`
   (`packages/core/src/plugins/validate.ts`) also compares the SHA-256 of
   every file the host found with the manifest: a missing, changed or
   unlisted file refuses the plugin. It runs at install, at update and at
   every load, so a file changed on disk after install is caught
   (`PLUGIN_TAMPERED`, state `FAILED`).
2. **The host owns every folder.** `PluginHost`
   (`apps/desktop/src/main/plugin-host.ts`) reads the bundled plugins
   (`out/main/plugins`, from the repository's `plugins/`), Jupiter's own
   copies (`<data>/plugins`) and each plugin's storage
   (`<data>/plugin-data/<id>`). A folder the person picks in the system
   dialog is copied (plain files only, no links, size and count limits) into
   staging, checked by Core, and moved into place only after the person
   allows `plugin.install`; the previous version stays until then. A request
   never carries a path.
3. **Installing and updating are CRITICAL.** `plugin.install` is asked every
   time (Allow once or Deny), names the plugin, version, publisher
   (unverified) and the permissions it asks for. While the person answers,
   the staged copy is kept so that the retry after _Allow_ installs exactly
   that copy without asking for the folder again; any other answer, or ten
   minutes, discards it. Only the `user-interface` actor manages plugins.
4. **Plugin code runs only in the plugin runtime, a process per run.**
   `PluginSandbox` (`services/plugin-runtime`) starts Electron as Node
   (`ELECTRON_RUN_AS_NODE`) with `--permission` (Node's permission model:
   no file system beyond its own entry script, no child processes, worker
   threads or add-ons), `--max-old-space-size`, a fixed stack size,
   `--disallow-code-generation-from-strings`, an environment with only that
   one variable, and stdin and stdout closed. The plugin's code arrives by
   message and runs in a `vm` context without `require`, `process`,
   `console`, `WebAssembly`, timers or `fetch`, with code generation from
   strings off; only strings cross the boundary. The timeout and cancel
   kill the process; running out of memory is reported as a crash.
   Nothing of a plugin ever loads in Electron main, Core or the renderer.
5. **Handles, not APIs.** Inside the sandbox a plugin has only
   `context.use(handle, args)`. Each handle (`app.version`, `system.time`,
   `storage.read`, `storage.list`, `storage.write`) is a Skill resource
   with a fixed capability and exact target, checked by the Permission
   Engine when used (`app.version.read`, `system.time.read`,
   `plugin.storage.read` LOW, `plugin.storage.write` MEDIUM). A handle the
   Skill did not declare, or one Jupiter does not know, fails the run and
   its output is discarded.
6. **Storage is the plugin's own folder.** Paths are checked in Core
   (`PluginRelativePath`) and resolved again by the host, which refuses
   `..`, absolute paths and links on every segment. Quotas: 200 files, 1 MB
   each, 5 MB in all. A write never replaces a file (temporary file,
   `O_EXCL`, link to a free name such as `name (2).md`). Uninstalling keeps
   the storage.
7. **States are derived, not stored.** `INCOMPATIBLE` when this Jupiter is
   older than `minimumJupiterVersion`; `FAILED` when a load failed (with its
   reason); otherwise `INSTALLED`, `DISABLED`, `ENABLED`, `RUNNING` (a run is
   in progress) or `DEGRADED` (a Skill's health check failed). Changes are
   the persistent `plugin.changed` event.
8. **Plugin Skills are ordinary Skills with their own runtime.** They
   register as `<plugin id>.<skill id>` with provider `plugin` and runtime
   `plugin@1`; the Skill Registry picks the sandbox by runtime. Disabling or
   uninstalling unregisters them; their execution history and Mission
   history stay.

## Alternatives considered

- **Running plugins in the SET 6 worker sandbox.** A `vm` in a worker of the
  Core process shares its memory and process; a sandbox escape would reach
  Core and the database. Rejected for third-party code.
- **One long-lived plugin process.** Cheaper per run, but a crash or leak
  would affect every plugin and state could leak between runs. A process
  per run makes timeout, cancel and crash isolation exact.
- **Electron `utilityProcess`.** Only Electron main can start one, so every
  plugin run would pass through main, and it gives no file-system
  restriction by itself; Node's permission model does.
- **Signed packages now.** Signing needs a key infrastructure and update
  channel, which SET 21 builds; the SHA-256 list catches any changed file,
  and the publisher is shown as _Unverified_ until then.

## Consequences

- Node 24 (Electron 44) has no `--allow-net`; the plugin process itself is
  not blocked from the network by the permission model. The plugin's code
  has no network API inside the sandbox (no `require`, `fetch`, sockets),
  and its process has no environment, files or child processes to get one.
  When Electron ships Node 25, `--permission` also denies the network and
  the runtime will use it.
- A `vm` context is not a security boundary on its own; here it is the inner
  layer, inside a process under the permission model with nothing in its
  environment.
- Each run starts a new process, which costs start-up time on every run;
  acceptable for Skills, and it keeps runs from sharing any state.
- Files in `plugins/*` are byte-exact (`.gitattributes`: `-text`) so their
  SHA-256 is the same on every platform; after editing one, run
  `node scripts/plugin-integrity.mjs <folder>`.
