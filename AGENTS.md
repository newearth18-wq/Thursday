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
| Isolated runtimes (future SETs)                      | `services/*`         |

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
