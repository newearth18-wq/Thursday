# SET 3 — AI providers, Model Router and Chat

- Status: **all 10 acceptance tests pass** locally on Linux, after a clean
  `npm ci` and `npm run verify` (13/13 steps), and in CI on Linux and Windows
  (commit `abb94f8`, run 36208820322). See §7.
- Checkpoint tag: `jupiter-set-03-ai-providers-and-chat` on `abb94f8` (created
  in the development environment, which can push branches only).
- SET 2 re-checked before SET 3 started: `85dfae5` green in CI.
- Environment of the recorded run: Node.js 22.22.2, npm 10.9.7, Electron 44.4.5,
  Xvfb 4096×2304, GNOME Keyring 46.1 (private, throwaway D-Bus session).

## 1. Scope completed

- **Provider adapters** behind a port in Core: OpenAI-compatible chat
  completions (for local servers such as Ollama, LM Studio or llama.cpp, and
  cloud services with that API) and the Anthropic Messages API. Operations:
  chat, streaming, tool calling, structured output, vision input, embeddings
  (OpenAI-compatible), cancellation, token usage and model discovery. Hidden
  reasoning is dropped in the adapters.
- **Model Router**: modes Auto, Cloud, Hybrid and Local only; settings for the
  preferred provider and the preferred chat, reasoning, vision and embedding
  models, the fallback policy (never / same place only / any model the mode
  allows) and the cost/speed preference; a per-conversation override (mode
  and pinned model); a live route preview per capability.
- **Credentials**: API keys in OS-backed secure storage (Electron
  `safeStorage`: DPAPI, Keychain, Secret Service). They are never returned;
  the interface shows only a fingerprint and the validation state (accepted,
  rejected, not confirmed).
- **Chat**: conversations and messages with roles; streaming; Stop; Ask again;
  Edit and resend (earlier versions kept and viewable); history in SQLite;
  the model, provider and place of each answer shown with it, including any
  fallback and why; token usage; tool calls shown as structured data and not
  run (no tools until SET 6); attachments modelled as Artifact Manager parts
  and labelled _Coming later (SET 10)_; clear errors with the way to fix them
  (_Open AI Models_).
- **Screens**: _AI Models_ and _Chat_ now work, and the Home composer sends
  into a new conversation. With no usable model the composers are disabled
  and say _Not configured_ or _Unavailable_ with the real reason.

Not built (other SETs): Missions (4), running tools (6), approvals (7),
attachments (10), and everything later.

## 2. Files added or changed

| Area       | Files                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts  | `packages/contracts/src/{ai.ts,chat.ts,host-operations.ts}` (new); `capabilities.ts` (20 capabilities), `events.ts` (6 events), `settings.ts` (8 AI settings), `contracts.test.ts`                                                                                                            |
| Core       | `packages/core/src/ai/{adapter.ts,transport.ts,router.ts,providers.ts,chat.ts,sanitize.ts}` (new) with `router.test.ts`, `transport.test.ts`; `kernel/{core-kernel.ts,capabilities.ts}`, `ports.ts`                                                                                           |
| Providers  | `packages/providers` (new): `openai-compatible.ts`, `anthropic.ts`, `sse.ts`, `http.ts`, `adapters.integration.test.ts`                                                                                                                                                                       |
| Database   | `packages/database/src/schema.ts` (migration 3), `repositories/{providers.ts,chat.ts}` (new), `jupiter-database.ts`; `test/ai-chat.integration.test.ts` (new), migration, backup and crash tests                                                                                              |
| Host       | `apps/desktop/src/main/{credential-vault.ts (new),host-capabilities.ts,services.ts,index.ts}`, `host-capabilities.test.ts`                                                                                                                                                                    |
| Core entry | `apps/desktop/src/core/{adapters.ts (new),index.ts}`                                                                                                                                                                                                                                          |
| Renderer   | `views/{ChatView,ModelsView}.tsx` (new), `components/{ChatComposer,RouteBadge,ActivityTimeline}.tsx`, `useAi.ts`, `useLiveEvents.ts` (new), `router.ts`, `destinations.ts`, `App.tsx`, `HomeView.tsx`, `FeatureViews.tsx`, `LoadFailure.tsx`, `errorText.ts`, `styles.css`, `i18n/{en,th}.ts` |
| Shared     | `apps/desktop/src/shared/views.ts` (`#/chat/<conversation>`), `packages/ui/src/Icon.tsx` (12 icons)                                                                                                                                                                                           |
| Testing    | `packages/testing/src/protocol-servers.ts` (new); `apps/desktop/test/{ai.integration.test.ts,ai-core.integration.test.ts}` (new); SET 0–2 E2E tests updated                                                                                                                                   |
| Tooling    | `scripts/with-display.mjs` (private GNOME Keyring), `.github/workflows/ci.yml`, `eslint.config.js` (no `fetch` in providers)                                                                                                                                                                  |
| Docs       | ADR `0004`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `AGENTS.md`, this report, `docs/sets/set-03/*.png`                                                                                                                                                                            |

## 3. Architecture decisions

Recorded in [ADR 0004](../decisions/0004-providers-router-credentials-and-chat.md):
an adapter port in Core with adapters installed only in the Core entry; one
guarded network path with locality taken from the address; keys in the
host's `safeStorage` vault, reachable by Core only; a pure router; chat stored
first, streamed as transient events and finished once. No IPC channel or
bridge function was added.

## 4. Database migrations

Migration 3 `0003_ai_providers_and_chat` adds `ai_providers` (credential id
and fingerprint only), `ai_models` (cascade on provider delete),
`chat_conversations` and `chat_messages` (unique `(conversation, seq)`,
`superseded_by`, index on streaming answers). An existing database is backed
up before the upgrade; the v2→v3 upgrade is tested. Fixed on the way: the
pre-migration backup could leave `-wal`/`-shm` files next to the copy; the copy
is now made self-contained (`journal_mode=DELETE`) before it is verified.

## 5. Security implications

- Keys: OS-encrypted files (0600 in a 0700 folder), refused without OS
  protection, never returned, never in the database, events, logs or errors
  (provider text is sanitized), read by Core only through host operations
  that are not capabilities and are refused for any actor but Core.
- Network: adapters cannot call `fetch` (lint); the guarded transport enforces
  Local only before connecting, refuses redirects, and never sends a key over
  plain `http` off this computer. The renderer's CSP still has
  `connect-src 'none'`: all network traffic is in Core.
- Model output is rendered as text only; hidden reasoning is dropped; tool
  calls are displayed and never run.
- Controls table: [SECURITY.md](../../SECURITY.md).

## 6. Commands actually run

```bash
npm ci                    # added 530 packages, 0 vulnerabilities
npm run verify            # 13/13 steps PASS (format, lint, typecheck, unit, build,
                          # integration + E2E, secret scan, dev smoke, Windows and
                          # Linux unpacked builds and validation, packaged launch)
node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/ai.integration.test.ts   # 14/14
```

## 7. Automated test results

| Suite                                       | Result                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Unit (23 files)                             | **216 passed**, 0 failed                                                    |
| Integration (17 files)                      | **120 passed**, 0 failed, 3 skipped (packaged tests, run as their own step) |
| — SET 3 E2E, real app (`ai.integration`)    | **14 passed**                                                               |
| — SET 3 Core in process (`ai-core`)         | **13 passed**                                                               |
| — adapters against protocol servers         | **14 passed**                                                               |
| — database (incl. `ai-chat`, v2→v3 upgrade) | **30 passed**                                                               |
| Packaged app launch (Linux unpacked)        | **3 passed**                                                                |
| Development-mode smoke                      | **5/5**                                                                     |
| Secret scan (sources + build output)        | **328 files**, 0 findings                                                   |
| Windows / Linux package validation          | **6/6** / **5/5**                                                           |

### CI evidence (commit `abb94f8`, run 36208820322)

| Job                                                                                                                                    | Result  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Linux — format, lint, typecheck, unit, build, integration + E2E with a throwaway GNOME Keyring, secret scan, dev smoke, packages       | success |
| Windows — unit, integration and E2E (including all 14 SET 3 E2E tests with DPAPI), NSIS installer, package validation, packaged launch | success |
| Legacy Thursday — build and acceptance checks                                                                                          | success |

The first run (`e02573b`, run 36208304010) failed on Windows in two tests,
both defects in the tests: a raw SQLite connection in `ai-chat` was not
closed (Windows locks open files: `EBUSY` on cleanup), and the SET 2 keyboard
test's Tab budget did not allow for focus starting inside the page and
wrapping, which the longer AI Models screen exposed. Fixed in `abb94f8`.

## 8. Manual tests

The E2E suite drives the real app through the interface; its screenshots were
reviewed after each round:

| Screenshot                                                                                   | What it shows                                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [No model](set-03/01-models-empty.png)                                                       | _Not configured_, secure storage backend shown                                    |
| [Local provider](set-03/02-models-local-provider.png)                                        | Provider _Ready_, _This device_, model enabled for chat                           |
| [Streaming](set-03/03-chat-streaming.png)                                                    | Answer growing, _Writing…_, Stop                                                  |
| [Stopped](set-03/05-chat-stopped.png)                                                        | Partial answer kept, _Stopped_                                                    |
| [Tool call](set-03/07-chat-tool-call.png)                                                    | Structured tool request, "nothing was run"                                        |
| [Key saved](set-03/08-models-key-saved.png), [rejected](set-03/09-models-key-rejected.png)   | Fingerprint only; rejected key: clear error, the echoed key shown as `[REDACTED]` |
| [Fallback](set-03/11-chat-fallback.png)                                                      | Answer from another local model, with which model failed and why                  |
| [Local only](set-03/12-models-local-only.png), [chat](set-03/13-chat-local-only-blocked.png) | Cloud provider _Blocked by Local only_; composer _Unavailable_ with the reason    |
| [After restart](set-03/14-chat-after-restart.png)                                            | History restored                                                                  |

Found and fixed through this review: checkboxes and radios did not move until
Core confirmed (now shown as _Saving…_ and reverted with the reason on
failure); returning to Chat lost the open conversation; provider names used
the section-label style; a key field was offered for an unencrypted cloud
address although Core always refuses it (now disabled with the reason); the
router did not say that a cloud model was being kept out by Local only.

## 9. Known limitations

- Two protocols are built in; other services work if they offer the
  OpenAI-compatible API. Model capabilities are chosen by the person unless the
  provider reports them.
- On Linux, keys need a running Secret Service; without one Jupiter says so and
  keyless providers still work.
- Error messages inside an `ErrorEnvelope` come from Core in English; known
  codes get a translated summary next to them.
- The OS key stores (DPAPI, Keychain) are exercised in CI only on Windows;
  macOS is not in CI.
- Answer text is plain text (no Markdown rendering yet).

## 10. How to run

```bash
npm ci && npm run dev
```

Start a local model server (for example Ollama at `http://127.0.0.1:11434/v1`),
open _AI Models_ › _Add provider_, choose _OpenAI-compatible API_, tick
_Chat_ for a model and turn it on, then write in _Chat_ or on Home. Try _Local
only_ with a cloud provider added, and _Stop_ during an answer.

## 11. Evidence and artifact paths

- `test-results/set-03/*.png` (written by the E2E suite; uploaded by CI)
- `docs/sets/set-03/*.png`
- `test-results/package-validation-win.json`, `test-results/package-validation-linux.json`

## 12. Acceptance tests

| #   | Test                                                                | Status   | Evidence                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A provider can be added or removed without modifying Core           | **PASS** | `ai-core`: an extra adapter is installed from outside Core and used, and Core's sources name no provider; E2E: the adapters listed come from the Core entry, and a provider is added and removed in the interface                                           |
| 2   | API keys are stored encrypted using OS-backed storage               | **PASS** | E2E: backend `gnome_libsecret` (DPAPI on Windows); one ciphertext file, mode 0600, without the key, Chromium's keyring marker `v11`; key accepted by the provider, and read back after a restart                                                            |
| 3   | An invalid key returns a clear, sanitized error                     | **PASS** | E2E: `PROVIDER_KEY_REJECTED`, "rejected the API key (HTTP 401)", validation _Rejected_; the server echoes the wrong key and it appears nowhere in the page; adapter tests for both protocols                                                                |
| 4   | The streaming response renders incrementally                        | **PASS** | E2E with a gated server: the page shows "Alpha ", then "Alpha Beta ", then the full answer, while the message is `streaming`, recorded by a MutationObserver                                                                                                |
| 5   | Stop Generation cancels the active provider request                 | **PASS** | E2E: Stop after the first piece → `cancelled`, partial text kept, and the provider saw its connection closed (`abortedAt`); adapter and in-process tests                                                                                                    |
| 6   | The router selects the correct model capability                     | **PASS** | E2E: chat routes to the chat model, vision has no route (`NO_MODEL_AVAILABLE`), a pinned conversation uses its model; 15 router unit tests (capability, preferences, modes, cost/latency, fallback)                                                         |
| 7   | LOCAL_ONLY sends no data to cloud endpoints                         | **PASS** | E2E: with a cloud server on a real non-loopback address, Local only shows it _Blocked_, Check now and chat send **zero connections** to it, and chat is answered locally; with only a cloud model, chat says _Unavailable_ (`PRIVACY_MODE_BLOCKED`)         |
| 8   | A secret never appears in logs, renderer storage, a DB dump, errors | **PASS** | E2E: after all tests, every file in the profile (logs, database, Chromium's Local/Session Storage, IndexedDB, caches, preferences) in UTF-8 and UTF-16, a full database dump and the process output are scanned for the right and the wrong key: 0 findings |
| 9   | An outage produces a truthful error and only approved fallback      | **PASS** | E2E: HTTP 503 → `PROVIDER_SERVER_ERROR` shown, no other provider asked (policy _Never_); with _Same place only_ another local model answers, the fallback is shown with the failed model and code, and the cloud model is never asked                       |
| 10  | Conversation history survives a restart                             | **PASS** | E2E: conversations and message texts identical after closing and relaunching the app                                                                                                                                                                        |

### SET 0–2 re-check (on the SET 3 code)

All SET 0–2 E2E suites pass (`app`, `core-gateway`, `shell`, `packaged`),
updated only where SET 3 changed facts: Chat and AI Models are no longer
_Coming later_ (7 unfinished screens instead of 9), `secure-storage` and
`model-router` are running services, and the composer without a model says
_Not configured_.
