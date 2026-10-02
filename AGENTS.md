# Instructions for agents and contributors

Jupiter is developed one SET at a time from the _Jupiter Complete Master Prompt_
(SET 0–24). These rules apply to every change.

## Work one SET at a time

- Work only on the SET you were asked to do. Do not start the next SET, and do
  not add features from later SETs "while you are there".
- Before editing: inspect the repository and tests, report the baseline and any
  conflict with the SET, then propose the smallest compatible sequence.
- A SET is done only when every acceptance test passes with evidence
  ([docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md)). If one fails, fix
  it or report the real blocker. Never claim completion without proof.
- After a SET passes, it is tagged `jupiter-set-NN-<name>` (for example
  `jupiter-set-00-foundation`).

## Non-negotiable behaviour (Global Contract, summarised)

1. Never simulate, fabricate or pre-announce: no fake buttons, progress,
   results, success states, logs or test results.
2. Unbuilt or unavailable features are labelled exactly `Unavailable`,
   `Not configured`, `Experimental` or `Coming later` — never shown as working
   controls.
3. Errors are real, sanitized, and come with a recoverable next step
   (`ErrorEnvelope` in `packages/contracts`).
4. The renderer has no Node.js, shell, filesystem, credential or unrestricted
   IPC access. Every IPC channel is allowlisted, schema-validated in both
   directions, sender-checked and correlated, and every command or query goes
   through the Core capability dispatcher.
5. Secrets never go into source, plaintext storage, logs, the renderer or error
   messages. Credentials use OS-backed secure storage (arrives in SET 3).
6. Every trust boundary uses typed, validated schemas.
7. Timestamps are UTC ISO-8601; IDs are UUIDv7 (`packages/core/src/ids.ts`).
8. Never delete or overwrite user data or artifacts silently.
9. Follow Jupiter Visual Design Lock v1 (`packages/ui`) for any UI.

## Where things go

| Change                                               | Place                |
| ---------------------------------------------------- | -------------------- |
| Data shapes crossing a process or trust boundary     | `packages/contracts` |
| Framework-independent logic (no Electron, no React)  | `packages/core`      |
| AI provider adapters (implement Core's adapter port) | `packages/providers` |
| SQLite schema, migrations, repositories              | `packages/database`  |
| Redaction, secret detection                          | `packages/security`  |
| Design tokens, shared visual components              | `packages/ui`        |
| Electron host, Core entry, preload, renderer         | `apps/desktop`       |
| Isolated runtimes                                    | `services/*`         |
| Plugins that ship with Jupiter (SET 15)              | `plugins/*`          |

Do not modify `legacy/thursday-browser` unless a task is explicitly about it.

## Adding functionality (from SET 1 on)

- A new command or query is a **capability**: add its input and output schemas
  to `Capabilities` in `packages/contracts/src/capabilities.ts`, and its policy
  (allowed actor types, risk, required services, timeout, audit) and handler in
  `packages/core/src/kernel/capabilities.ts`. Do not add IPC channels or preload
  functions — the renderer reaches every capability through `request`.
- Anything privileged on the host (files, shell, OS integration) is a capability
  with `provider: 'host'`, implemented in `apps/desktop/src/main/host-capabilities.ts`
  and reached only through the dispatcher. It must act on targets the host
  chooses, never on paths or commands taken from the request.
- Something that happened is a **domain event**: add its payload schema to
  `packages/contracts/src/events.ts` and publish it through the event bus inside
  the same transaction as the change it describes.
- A new AI provider protocol is an **adapter** in `packages/providers`
  implementing the port in `packages/core/src/ai/adapter.ts`, listed in
  `apps/desktop/src/core/adapters.ts`. Core must not change, and must never
  name a provider. Adapters use only `context.transport` (never `fetch`; lint
  enforces it), drop hidden reasoning, and pass provider error text through
  `sanitizeProviderText`. Test them against `@jupiter/testing/protocol-servers`.
- Secrets reach Core only through the host vault (`host.credentials.*` host
  operations, Core actor only). Never return a key, put one in an event, log,
  error or the database, or keep one in renderer state longer than the request
  that sends it.
- A Mission's status changes only through `MissionManager.transition`, which
  applies `MISSION_TRANSITIONS` from the contract. Never write a status
  directly, and never delete or rewrite Mission history (retry adds an
  attempt).
- Workflows (SET 5): a plan reaches the engine only through `parsePlanText`
  and `validatePlan` (`packages/core/src/workflow/`). A new step type needs a
  catalogue entry (`workflow/catalogue.ts`), a real executor in
  `MissionManager.execute`, validator rules for its inputs, and names in both
  catalogs. Write a step's output only in the transaction that completes it
  (it is the idempotency guarantee), and never store model reasoning.
- Skills (SET 6): a new Skill is a `SkillImplementation` (definition as data,
  code as a function-expression string run in the sandbox, a health input) in
  `packages/core/src/skills/builtin.ts`. It reaches nothing but
  `context.use(resource)`; a resource fixes its capability and exact target.
  Never let a caller pass permissions, and never store a Skill's input or
  output content (only `summarize`).
- Permissions (SET 7): every action with an effect goes through
  `PermissionEngine.check` (`packages/core/src/permissions/engine.ts`) at the
  moment of use; a new capability is an entry in `PERMISSION_CATALOGUE`
  (`packages/contracts/src/permissions.ts`) with its risk, consequence,
  reversibility and what leaves the computer. Never grant in code (defaults
  are visible, revocable grants made by `core` once), never let anything but
  the `user-interface` actor answer or revoke, never offer more than
  ALLOW_ONCE/DENY for CRITICAL, never delete a grant (end it), and never
  update or delete the audit trail.
- Computer Agent (SET 8): Core decides and checks every action
  (`packages/core/src/computer/`); the host (`apps/desktop/src/main/computer-host.ts`)
  chooses what may be acted on (executables, the save folder, the evidence
  folder) and never takes a path or command from a request; UI Automation runs
  only in the agent runtime (`services/agent-runtime`), one validated call at a
  time. A new action needs a contract entry (`ComputerAction`), a permission
  requirement with an exact target, and a check that reads its effect back — an
  unverified effect is a failure. A new application is an adapter
  (`computer/adapters.ts`) that finds controls semantically; coordinates are
  only the labelled, opt-in `CLICK_POINT` fallback.
- Browser Agent (SET 9): Core decides and checks every action
  (`packages/core/src/browser/`); the host (`apps/desktop/src/main/browser-host.ts`)
  chooses the browser and every folder and never takes a path from a request;
  the browser runs only in the browser runtime (`services/browser-runtime`).
  A new action needs a contract entry (`BrowserAction`), a permission
  requirement for its exact origin, and an observation of what really
  happened. Page content is untrusted data: never let it add actions,
  permissions or origins, pass it on only as `UntrustedContent` (fenced in
  Missions), and label text that tries to direct the agent. Leaving the
  approved origins is a `SAFETY_STOP`, never a warning. Downloads are kept
  only after the host checks them in quarantine; nothing is overwritten.
- Files and artifacts (SET 10): Core decides and checks every operation
  (`packages/core/src/files/`); the host (`apps/desktop/src/main/file-host.ts`)
  owns the approved folders and resolves every path, refusing absolute paths,
  `..`, links and junctions before anything is touched; documents are parsed,
  written and validated only in the document runtime
  (`services/document-runtime`). Requests name a root and a relative path
  (`FileLocation`), never an absolute path. Check the permission for the exact
  resolved file at the moment of use; deleting is CRITICAL and goes to the
  Recycle Bin. Write only through the atomic create (temporary file, validate,
  link to a free name): never overwrite, a new version is a new file. An
  artifact is recorded with lineage, version, SHA-256 and each verification
  check, and is never deleted (mark it); cleanup never removes a kept file.
  Document text is untrusted data: pass it on only fenced (`BEGIN/END
UNTRUSTED DOCUMENT TEXT`) and never evaluate formulas or scripts in it.
- Memory and notes (SET 11): whether something is remembered is decided
  only by the policy (`packages/core/src/memory/policy.ts`), never by a
  model; a credential is never kept; a sensitive memory is kept only after
  the person answers, sealed through `host.vault.*`, and never embedded,
  exported, logged or put in an event. Candidates waiting for the person
  stay in RAM. A memory changes only through `MemoryService` (correct,
  forget, restore, delete with `memory.delete`); deleting erases remnants.
  Semantic search gets its model from the router, so the routing mode
  applies. The vault is the folder the person chose in the host
  (`apps/desktop/src/main/notes-host.ts`); never take a vault or absolute
  path from a request, never overwrite a note (create to a free name),
  change one only with the expected hash after a backup, keep its
  frontmatter, BOM and line endings, and never restructure a vault unless
  the person asks. Note text is untrusted data: fence it (`BEGIN/END
UNTRUSTED NOTE TEXT`).
- Voice (SET 12): `VoiceService` (`packages/core/src/voice/`) decides and
  owns every voice state; a state changes only through its transition table
  and only after something real happened (audio arrived, an engine answered,
  the interface reported that playback started). Only Core opens the
  microphone gate (`host.microphone.gate`), after `microphone.listen`; the
  session's permission handler allows audio from Jupiter's page only while
  the gate is open. Speech engines come from the router
  (`transcription`, `speech`) or the host's system voice, so the routing
  mode applies; the wake word runs only with a speech-to-text engine on this
  computer. Keep audio in memory for the utterance being processed only:
  never write it, log it, or put it or a transcript in an event or the
  database. Test speech with the real fixtures in
  `packages/testing/fixtures/voice/` and Chromium's fake microphone
  (`JUPITER_TEST_FAKE_AUDIO`, test environment only).
- Vision and camera (SET 13): `VisionService` (`packages/core/src/vision/`)
  decides every capture, analysis and camera state; images live only in its
  `ImageStore` (memory, 15 minutes): never write an image, or text read from
  one, to disk, the database, a log or an event. The host
  (`apps/desktop/src/main/vision-host.ts`) chooses what is captured (a
  request names a source and a region, never a path or a window it did not
  find) and reads text and QR codes on this computer (Tesseract; jsQR in the host
  process).
  Analysis by a model goes through the router (`capability: 'vision'`), after
  secrets are blacked out; never send an image to a cloud model that could
  not be checked for secrets. Only Core opens the camera gate
  (`host.camera.gate`), after `camera.read`; the camera's state changes only
  through its transition table and after the interface reports what the real
  track did. An observation is untrusted evidence with a confidence: never
  treat one below the minimum confidence, or a comparison of different
  targets, as verified. Test with the fixtures in
  `packages/testing/fixtures/vision/` and Chromium's fake camera
  (`JUPITER_TEST_FAKE_CAMERA`, test environment only).
- Identity (SET 14): `IdentityService` (`packages/core/src/identity/`)
  decides every level; recognition never allows anything by itself — with
  protection on it is one more condition inside `PermissionEngine.check`
  (CRITICAL needs `STRONG_VERIFIED`, which only Windows Hello gives; the
  `IDENTITY_REQUIREMENTS` list needs `VERIFIED`), and the permission is still
  checked. Face is `VERIFIED` at most, voice `RECOGNIZED` at most; never
  raise them, and keep their liveness and limits labelled Experimental.
  Face runs only in the identity runtime (`services/identity-runtime`) on
  frames from a running camera session; the host
  (`apps/desktop/src/main/identity-host.ts`) decodes and scales them and asks
  Windows Hello, and takes no path or image from anywhere else. Seal every
  template through `host.vault.seal` before it is stored; never put a
  template, descriptor, score, image or audio in an event, a log, an error
  or the database unsealed. Assurance lives in memory only and ends on its
  timeout and on lock, suspend or shutdown (`identity.security-event`, host
  actor only). Only the `user-interface` actor enrolls, verifies, deletes or
  changes protection. Test with `packages/testing/fixtures/identity/` and
  the `id-*` voice fixtures, and the fake camera with a video
  (`JUPITER_TEST_FAKE_CAMERA=<file.y4m>`, test environment only).
- Plugins (SET 15): `PluginManager` (`packages/core/src/plugins/`) decides
  every install, update, enable, disable and uninstall, and checks a package
  with `checkPackage` (manifest, Skills, SHA-256 of every file, compatibility)
  before anything of it runs, and again at every load. Plugin code runs only
  in the plugin runtime (`services/plugin-runtime`): never in Electron main,
  Core or the renderer. The host (`apps/desktop/src/main/plugin-host.ts`)
  owns every plugin folder and each plugin's storage, copies a folder the
  person picks into staging (never a path from a request) and resolves every
  storage path itself. A new handle is an entry in `PLUGIN_HANDLES`
  (`packages/contracts/src/plugins.ts`) with its permission, and a resource
  in `PluginManager.storageResources` or Core's Skill resources; never give a
  plugin files, secrets, devices, network, a shell or the environment.
  Installing and updating ask `plugin.install` (CRITICAL) every time; only
  the `user-interface` actor manages plugins. Never overwrite a plugin's file
  or delete its storage, keep the installed version until an update is
  accepted, and after changing a file in `plugins/*` run
  `node scripts/plugin-integrity.mjs <folder>`.
- Schema changes are new migrations at the end of `JUPITER_MIGRATIONS`; never
  edit a migration that has shipped (see `packages/database/README.md`).

## Interface work (from SET 2 on)

- Never write interface text in a component: add a key to both
  `apps/desktop/src/renderer/src/i18n/en.ts` and `th.ts` (same keys, same
  placeholders). `src/checks/renderer-copy.test.ts` fails on literal copy.
- Use the tokens in `packages/ui/src/tokens.ts` (and `tokens.css`, kept equal
  by a test) and `rem` units; no raw colours, pixel font sizes or durations.
- A screen for something unbuilt keeps its _Coming later_ label and has no
  enabled controls, progress or motion until the SET that builds it
  (`destinations.ts` records which SET that is).
- A user preference is a setting in `SettingDefinitions`
  (`packages/contracts/src/settings.ts`), not browser storage.
- Dialogs, menus and tabs use the shared components, which handle focus and
  keyboard behaviour. Every control must be reachable by keyboard, and motion
  must stop under Reduce Motion.

## Checks to run

```bash
npm ci
npm run verify      # format, lint, typecheck, unit, build, E2E, secrets, dev smoke, package validation
```

On Linux without a display the Electron tests run under `xvfb-run`
automatically, and always in a private D-Bus session with a throwaway, unlocked
GNOME Keyring (install `dbus` and `gnome-keyring`), so API-key tests use real
OS-backed storage and never your own keyring. As root (containers) Chromium
needs `--no-sandbox`; the test helpers add it only in that case.

## Writing tests

- Unit tests: `*.test.ts(x)` next to the code. Integration tests:
  `*.integration.test.ts`.
- E2E tests launch the real built app through `@jupiter/testing`
  (`launchJupiter`, or `launchPackagedJupiter` for an electron-builder output)
  with a temporary profile. Don't stub Jupiter internals in E2E tests.
- Database tests use real SQLite files in a temporary folder
  (`packages/database/test`).
- Never put a real or realistic-looking credential in the repository: use
  `@jupiter/testing/fake-credentials`, which assembles test values at runtime so
  the secret scan stays meaningful.
