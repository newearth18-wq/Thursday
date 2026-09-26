# ADR 0004 — AI providers behind an adapter port, one guarded network path, keys in OS storage, streamed chat

- Status: accepted (SET 3)
- Date: 2026-09-25

## Context

SET 3 adds AI providers, the Model Router and Chat. A provider must be
addable or removable without changing Jupiter Core. API keys must be
encrypted with OS-backed storage and never appear in logs, renderer storage,
the database or error output. Local only must send nothing to cloud endpoints.
Answers stream, can be stopped, and history must survive a restart. A provider
outage must produce a truthful error, with fallback only where the person
allowed it. Hidden model reasoning is never shown.

## Decisions

### 1. Core knows adapters only through a port; adapters are installed where Core is assembled

`@jupiter/core` defines the adapter port (`ai/adapter.ts`): an adapter
describes itself (`AdapterInfo`: id, operations, whether a key is required,
default or example address), lists models, streams chat as typed chunks
(`text`, `tool-call`, `usage`, `finish`) and may compute embeddings. Errors
are `ProviderError`s with a fixed set of codes (`PROVIDER_KEY_REJECTED`,
`PROVIDER_UNREACHABLE`, `PROVIDER_RATE_LIMITED`, `PROVIDER_SERVER_ERROR`, …).

The adapters live in `@jupiter/providers` (OpenAI-compatible chat
completions; Anthropic Messages). Core does not depend on that package. The
list of installed adapters is one function in the Core entry,
`apps/desktop/src/core/adapters.ts`. Adding a protocol is a new adapter plus
one line there. Removing one leaves configured providers visible as
_Unavailable (adapter not installed)_, and they are never used. Nothing in
Core names a commercial provider. An integration test installs an extra adapter
without changing Core, and checks that Core's sources name no provider.

- Alternatives: vendor SDKs (each brings its own HTTP stack, retries and
  logging, which would bypass the network guard and the redaction); a plugin
  runtime for adapters (that is SET 15, with isolation this SET does not have).

### 2. One guarded network path, and locality comes from the address

Adapters never call `fetch`. They get a `transport` from Core
(`ai/transport.ts`), and ESLint forbids `fetch` and Node's network modules
in `packages/providers`. The transport:

- derives **locality from the URL alone**: loopback (`localhost`,
  127.0.0.0/8, `::1`) is _this device_; everything else, including other
  machines on the LAN, is _cloud_, because Jupiter cannot verify where it is;
- in **Local only** refuses a cloud address before any connection is opened
  (`PRIVACY_MODE_BLOCKED`, recorded as an `ai.route.blocked` event);
- refuses redirects (`redirect: 'error'`), so a local address cannot bounce a
  request to the cloud;
- refuses to send a key over plain `http` to an address that is not on this
  computer (`INSECURE_TRANSPORT`). Core checks this again before it stores a
  key for such a provider.

- Alternatives: an OS firewall rule (not portable, needs elevation, and
  invisible to the user); trusting a "local" flag the person or provider sets
  (it can be wrong, and then Local only would not mean what it says).

### 3. API keys: Electron `safeStorage` in the host, one ciphertext file per key, fingerprints only

The host's `CredentialVault` encrypts with `safeStorage`. On Windows that is
DPAPI, bound to the signed-in user. On macOS it is the Keychain. On Linux it
is the Secret Service (GNOME Keyring or KWallet). Each key is one file,
`<data folder>/credentials/<credentialId>.bin`, written atomically with mode
0600 in a 0700 folder; the name is a UUIDv7, so it can never leave the
folder. If only Chromium's hard-coded fallback (`basic_text`) is available,
the vault **refuses** to store keys. It says why, and providers that need no
key still work.

- The renderer sends a key once (`ai.credentials.set`) and never gets it back.
  Core stores only the credential id, a fingerprint (first 8 hex characters of
  its SHA-256, computed in the host) and the validation state.
- Core reads a key only through **host operations**
  (`host.credentials.store/read/delete`). These are not in the capability
  catalogue, so the renderer cannot call them, and the host refuses them for
  any actor other than Core. The plaintext exists only in memory, for the
  request that needs it. Adapter errors pass through `sanitizeProviderText`,
  which removes the key, echoes of it and any other credential format before
  a message is stored, logged or shown.
- On Linux the host asks Chromium for `gnome-libsecret` explicitly unless the
  person chose a password store on the command line. The tests run in a
  private D-Bus session with a throwaway, unlocked GNOME Keyring
  (`scripts/with-display.mjs`), so they use real encrypted storage and never
  the developer's own keyring.

- Alternatives: `keytar` (archived, and a native module, which Jupiter avoids
  shipping); a key encrypted with a key that ships inside the app (that is
  not protection); `safeStorage` inside Core (it is not available in a utility
  process, and it would put key handling next to network code).

### 4. The router is a pure function of what the person configured

`selectRoute` (`ai/router.ts`) takes the providers, their models (enabled,
capabilities, measured latency, reported prices), the mode, the fallback
policy, the cost/latency preference and the preferred provider or model. It
returns a primary candidate and the fallbacks the policy allows, or a typed
configuration error. It never invents a model.

- **Modes**: _Auto_ (any allowed model, by preference), _Cloud_ (cloud only),
  _Hybrid_ (this device first) and _Local only_ (this device only). A
  conversation can override the mode and pin a model, but a global _Local
  only_ always wins.
- **Order**: the model pinned to the conversation, then the preferred model
  for the capability, then (in Hybrid) this device, then the preferred
  provider, then cost or latency where known, then a stable order.
- **Fallback**: `never` (the default), `same-locality` (never from this
  device to the cloud) or `allowed-by-mode`. Fallback happens only before
  anything was received, and only for failures that say nothing about the
  request (unreachable, overloaded, server error, timeout). It is recorded as
  an `ai.route.fallback` event and in the answer's route, and shown with the
  answer.
- Discovered models start **unused**. A model list does not say what a model
  can do, so the person chooses its capabilities before using it, unless the
  provider reports them.

### 5. Chat: stored first, streamed as transient events, finished once

`chat.send` stores the question and an empty answer (`streaming`) in one
transaction and returns. The answer is generated in the background. Its text
streams to the interface as transient `chat.message.delta` events, which are
never stored in the event log. They are coalesced every 40 ms and each carries
its offset, so a client can place text exactly and detect a gap. The finished
answer is written once, with its real outcome: `complete`; `cancelled` (Stop
or shutdown; what arrived is kept); or `failed` (the sanitized provider error).

- **Stop** aborts the request's `AbortSignal`, which closes the provider
  connection.
- **Ask again** and **edit** never delete: the earlier messages are marked
  `supersededBy` the new ones and can be shown.
- Answers that were streaming when Core stopped are marked failed
  (`GENERATION_INTERRUPTED`) at the next start.
- **Hidden reasoning** is dropped inside the adapters. Only its token count is
  kept. Tool calls are stored as structured parts. Jupiter has no tools until
  SET 6, so the interface shows them and says nothing was run.
- **Limits**: 4 answers at a time, 60 messages of context, 200 000 characters
  per answer, 120 s without data ends an answer (`PROVIDER_TIMEOUT`).
- The event log keeps only message **metadata** (`chat.message.changed`), never
  text.

## Consequences

- The capability catalogue grows by 20 entries (`ai.*`, `chat.*`,
  `host.credentials.status`). No IPC channel or bridge function was added.
- Migration 3 adds `ai_providers`, `ai_models`, `chat_conversations` and
  `chat_messages`. Providers keep only a credential id and fingerprint.
- Linux users need a running Secret Service to save keys. Without one, Jupiter
  says so and keeps working with keyless (for example local) providers.
- Only two protocols are built in. Other providers that speak the
  OpenAI-compatible protocol work through that adapter.
