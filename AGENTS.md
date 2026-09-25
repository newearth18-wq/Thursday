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
   directions, sender-checked and correlated.
5. Secrets never go into source, plaintext storage, logs, the renderer or error
   messages. Credentials use OS-backed secure storage (arrives in SET 3).
6. Every trust boundary uses typed, validated schemas.
7. Timestamps are UTC ISO-8601; IDs are UUIDv7 (`packages/core/src/ids.ts`).
8. Never delete or overwrite user data or artifacts silently.
9. Follow Jupiter Visual Design Lock v1 (`packages/ui`) for any UI.

## Where things go

| Change                                              | Place                |
| --------------------------------------------------- | -------------------- |
| Data shapes crossing a process or trust boundary    | `packages/contracts` |
| Framework-independent logic (no Electron, no React) | `packages/core`      |
| Redaction, secret detection                         | `packages/security`  |
| Design tokens, shared visual components             | `packages/ui`        |
| Electron main, preload, renderer                    | `apps/desktop`       |
| Isolated runtimes (future SETs)                     | `services/*`         |

Do not modify `legacy/thursday-browser` unless a task is explicitly about it.

## Checks to run

```bash
npm ci
npm run verify      # format, lint, typecheck, unit, build, E2E, secrets, dev smoke, package validation
```

On Linux without a display the Electron tests run under `xvfb-run`
automatically. As root (containers) Chromium needs `--no-sandbox`; the test
helpers add it only in that case.

## Writing tests

- Unit tests: `*.test.ts(x)` next to the code. Integration tests:
  `*.integration.test.ts`.
- E2E tests launch the real built app through `@jupiter/testing`
  (`launchJupiter`) with a temporary profile. Don't stub Jupiter internals in
  E2E tests.
- Never put a real or realistic-looking credential in the repository: use
  `@jupiter/testing/fake-credentials`, which assembles test values at runtime so
  the secret scan stays meaningful.
