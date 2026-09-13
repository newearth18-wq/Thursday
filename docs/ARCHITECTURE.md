# Architecture

## The one rule

Layers depend downward, never upward.

```
            ┌──────────────────────────────────────────┐
            │  Renderer (React)                        │
            │  Browser · Command Center · Workflows    │
            │  Plugins · Settings · Diagnostics        │
            └───────────────────┬──────────────────────┘
                                │  window.thursday  (context bridge)
            ┌───────────────────┴──────────────────────┐
            │  Preload — sandboxed, contextIsolation   │
            └───────────────────┬──────────────────────┘
                                │  typed IPC, zod-validated
┌───────────────────────────────┴───────────────────────────────────────┐
│  Main process                                                         │
│                                                                       │
│   Missions ──▶ Supervisor ──┐                                         │
│   Workflows ──▶ Engine ─────┼──▶ Skill Registry ──▶ Plugin Engine     │
│   AI Core ──▶ Model Router ─┘                            │            │
│                                                          │ fork()     │
│   Browser Core   Diagnostics   Logger   Settings   DB    ▼            │
│                                                  ┌──────────────────┐ │
│                                                  │ Plugin host      │ │
│                                                  │ (its own process)│ │
│                                                  └──────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

The Browser Core sits at the bottom and imports nothing from the AI core, the
plugin engine, missions or workflows. Turn every one of those off and it still
works — the acceptance suite has a test that proves it.

---

## Shared contract

`src/shared/` is the only code all three processes agree on.

`schemas.ts` holds zod schemas, and every domain type is inferred from one.
There is no second place where a `Mission` or a `ProviderConfig` is described,
so a schema change is a compile error everywhere it matters.

`ipc.ts` maps each channel to its input schema and its return type. The main
process validates every call against that schema before a handler runs, so a
handler can trust its input completely.

`channels.ts` is a deliberate split. The preload script runs sandboxed and
cannot `require` from `node_modules`, so it cannot import zod. The plain string
lists live here, and `ipc.ts` carries a compile-time assertion that the two
descriptions of the channel set are identical:

```ts
type ChannelDrift = Exclude<IpcChannel, ChannelName> | Exclude<ChannelName, IpcChannel>
export type _ChannelsInSync = AssertNever<ChannelDrift>
```

Add a channel to one and forget the other and the build fails, rather than
producing a channel that is bridged but unvalidated.

---

## Process model

**Main** owns everything stateful: the database, the tab views, provider
adapters, the plugin engine, the supervisor.

**Renderer** owns no state of its own beyond view state. It reads through IPC
and follows events.

**Plugin hosts** are separate OS processes, one per enabled plugin, forked with
`ELECTRON_RUN_AS_NODE=1`. This is the mechanism behind core principle #4:
in-process plugins can take the app down, out-of-process plugins cannot.

**Web pages** are `WebContentsView`s with `nodeIntegration: false`,
`contextIsolation: true`, `sandbox: true` and no preload script. Popups are
turned into tabs; permission requests from pages are denied.

---

## Browser Core

`src/main/browser/tab-manager.ts`.

Tabs are `WebContentsView`s added to the window's content view, which places
them above the React document. Only the active tab is visible.

The renderer measures the hole in its layout and reports the rectangle through
`browser:setViewport`. That call also carries `visible`, which is how
full-screen panels work: leaving the Browser tab sends `visible: false` and
every page view is hidden, so nothing punches through Settings or the Command
Center.

`normaliseUrl()` is the single entry point for turning user text into a URL. It
adds a scheme, falls back to a search when the text is not host-shaped, and
rejects anything that is not `http:` or `https:` — so `file:` and `javascript:`
never reach a tab.

---

## Model Router

Every provider implements one interface:

```ts
interface ModelProvider {
  readonly id: string
  readonly kind: string
  readonly requiresApiKey: boolean
  testConnection(signal?: AbortSignal): Promise<ConnectionResult>
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  chat(request: ChatRequest, tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ChatChunk>
}
```

Adding a provider means writing one adapter and adding one line to the factory.
Nothing above the router changes.

Three wire formats are covered: OpenAI Chat Completions (shared by
`openai`, `openai-compat` and `lmstudio`), Anthropic Messages, Gemini
`streamGenerateContent`, and Ollama's newline-delimited JSON.

**Errors name the problem.** `explainNetworkError` turns `ECONNREFUSED` into
*"Connection refused by 127.0.0.1:11434 — nothing is listening on that
address"*. HTTP failures carry the provider's own error body. There is no
"something went wrong" anywhere in the codebase.

**Timeouts guard the handshake, not the stream.** `fetch` settles when response
headers arrive, and the timer is cleared at that point — so a slow streaming
body is never cut off, while a dead host still fails fast. The caller's abort
signal stays attached for the whole request, which is what makes **Stop** work
mid-stream.

---

## Plugin Engine and isolation

A plugin package is a directory with `manifest.json` and a JavaScript entry
file. Manifests are validated with zod on every load; an invalid one is skipped
with a specific reason and the other plugins still load.

Starting a plugin forks `out/main/plugin-host.js`. The engine sends `init` with
the entry path, the plugin's data directory and **only the granted
permissions**. The host imports the entry module, collects its skills and
replies `ready` with their descriptors, which the engine registers in the Skill
Registry.

Failure handling:

| What happens | What Thursday does |
|---|---|
| Entry module throws on import | health `error`, reason recorded, skills withdrawn |
| Does not become ready in 15s | health `error`, host killed |
| Process exits unexpectedly | health `crashed`, skills withdrawn, restarted up to twice |
| Restart budget exhausted | stays `crashed` with a message saying so |
| A skill call exceeds 30s | that call returns `TIMEOUT`; the plugin keeps running |
| Deliberate stop (disable/reload) | `stopping` flag set, so the exit is not logged as a crash |

In every one of those rows, the browser core and all other plugins are
untouched.

### The permission gate

Plugins reach host services through a request/response bridge. Every method is
gated in the parent process, which is the side the plugin cannot modify:

```
plugin calls context.host.writeFile(...)
  → host process sends { type: 'bridge', method: 'writeFile' }
  → engine checks granted permissions          ← the gate
  → engine confines the path to plugin-data/<id>/   ← and the sandbox
  → reply
```

Two independent protections: the permission must be granted, *and* the resolved
path must stay inside the plugin's own directory. `..` and absolute paths are
rejected.

`grantPermissions` refuses anything the manifest did not declare, and a
previously granted permission that disappears from the manifest is dropped on
the next load.

---

## Skill Registry

Skills are namespaced `<pluginId>.<skillId>`, so two plugins can both expose
`echo` without colliding.

The registry does not know what a plugin is. An owner registers descriptors
plus an `invoke` function and an `availability()` callback, and can withdraw
them at any time. That is why a crashed plugin's skills vanish from the AI
core's tool list within the same tick.

Every invocation is validated against the skill's declared JSON Schema first, so
a plugin never receives input shaped differently from what it published.

---

## Missions and the Supervisor

One supervisor, not a swarm.

```
steps in order
  ├─ requiresApproval? ─▶ WAITING_APPROVAL, block until approve/reject
  ├─ no skillId?       ─▶ checkpoint: completes, records that it did no work
  └─ skillId           ─▶ invoke, retry recoverable failures with backoff
                          (TIMEOUT / PLUGIN_UNHEALTHY / EXECUTION_ERROR)
                          INVALID_INPUT and SKILL_NOT_FOUND fail immediately —
                          they would fail identically on every retry
VERIFYING ─▶ re-check every step really finished ─▶ COMPLETED or FAILED
```

The verify pass matters: a mission is only ever reported COMPLETED after the
supervisor has confirmed each step ended in `completed` or `skipped`.

A step with no skill is a **checkpoint**. It completes immediately and records
`{ type: 'checkpoint' }` — it never claims to have performed work it did not do.

Planning (`missions:plan`) asks the configured model to emit JSON referencing
live skill ids, and rejects a plan that names a skill that is not registered.
There is no offline fallback that invents plausible-looking steps: with no
working provider, planning fails and says why.

---

## Workflow Engine

Nodes execute one at a time. Branching is explicit — `next` on a node,
`onTrue`/`onFalse` on a condition — rather than a general graph, and a visit
counter stops a looping definition after 100 nodes.

Condition nodes compare two interpolated strings with a named operator. There is
no expression evaluation anywhere, so a workflow definition can never execute
arbitrary code. `{{nodeId}}` interpolation pulls earlier results out of the run
context. `file` nodes are confined to a workflow files directory the same way
plugin writes are confined.

---

## Command Center and the brain

`src/main/core/app-state.ts` holds the live state; `Brain.tsx` renders it.

The brain's palette, signal launch rate, signal speed, glow and jitter are all
read from a per-state profile. A running mission's phase always wins over the
ambient state, so the visual cannot disagree with the mission badge next to it.
Idle is slow and dim on purpose: an animation that looks busy while nothing is
happening would be a lie about system state, which is the thing the whole panel
exists to prevent.

---

## Persistence

`node:sqlite`, which ships inside Electron's Node runtime. No native module, no
rebuild step, no ABI mismatch — the most common way an Electron app fails to
install on a new machine simply does not apply.

Migrations are a numbered list applied in a transaction; a failure rolls back
and reports which migration and which database file.

Secrets live in a separate table, encrypted with `safeStorage` and flagged with
whether encryption was actually available. Diagnostics reports the truth either
way.

---

## Logging

One structured call per important action:

```ts
log.info('SKILL', `Invoking ${skillId}`, { input })
```

Categories are `CORE`, `BROWSER`, `DB`, `MODEL`, `PLUGIN`, `SKILL`, `WORKFLOW`,
`MISSION`, `PERMISSION`, `ERROR`. Every entry goes to the console, to SQLite and
live to the renderer. Entries logged before the database opens are buffered and
flushed, so boot-time failures are not lost.
