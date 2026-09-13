# Thursday Browser — Alpha

An AI-first Chromium desktop browser with a modular Plugin/Skill architecture.

Thursday is a real browser first. The AI core, the plugin engine, missions and
workflows are all optional layers stacked on top of it — disable every one of
them and the browser still opens tabs, navigates, and goes back and forward.

The goal of this Alpha is **not** feature count. It is a foundation that can
gain new abilities through plugins without the core changing.

---

## Status

Alpha. All 24 required acceptance tests pass, plus 8 additional checks written
to verify the core principles (plugin isolation, permission enforcement,
browser independence, approval gates, IPC validation).

```
Required acceptance tests : 24/24 passed
Core principle checks     : 8/8 passed
```

Run them yourself with `npm run test:acceptance`. See
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for what each test proves — and for an
explicit list of what is **not** covered.

---

## Requirements

| | |
|---|---|
| Node.js | 20.11 or newer (22.x recommended) |
| npm | 10 or newer |
| OS | Linux, macOS or Windows |

No native module compilation is needed. Thursday stores its data with Node's
built-in `node:sqlite`, which ships inside Electron's runtime, so there is no
`node-gyp` step and no ABI mismatch to debug.

---

## Installation

```bash
git clone <this repository>
cd Thursday
npm install
```

## Development commands

```bash
npm run dev              # build plugins, then start with hot reload
npm run build            # typecheck, build plugins, build main/preload/renderer
npm run start            # preview a production build
npm run typecheck        # TypeScript only, no emit
npm run build:plugins    # compile plugins/*/src into their entry files
npm run test:acceptance  # run the full acceptance suite against a real app
npm run dist             # package a distributable with electron-builder
```

### Running as root (containers, CI)

Chromium refuses to start as root without an explicit flag:

```bash
npx electron-vite dev -- --no-sandbox
```

Do not use `--no-sandbox` for everyday use on a normal desktop account.

---

## First run

1. Launch Thursday. A tab opens on the home page.
2. Open **Settings → AI providers** and add a provider. Pick the type, set the
   base URL, paste an API key if the provider needs one, and press
   **Add provider**.
3. Press **Test connection**. Thursday makes a real request and reports exactly
   what came back — including the reason if it failed.
4. Press **Fetch models**, then choose a provider and model in the Thursday
   sidebar on the right.
5. Type a message. The reply streams in.

Running Ollama or LM Studio locally? **Settings → Local AI** probes both and
reports Detected / Not detected / Connection error based on an actual HTTP
round trip — never on the port merely being plausible. Press **Add as
provider** on a detected runtime to wire it up in one click.

---

## What is in the Alpha

**Browser Core** — tabs, navigation, back/forward/reload, address bar,
downloads, session state. Pages run in `WebContentsView` with `nodeIntegration`
off, `contextIsolation` on and the sandbox enabled. Web pages get no preload
script, so no part of Thursday's API is reachable from a loaded page.

**Thursday AI Core** — conversations, streaming responses, model selection, and
a tool-calling interface that discovers what it can do through the Skill
Registry. It contains no plugin-specific code.

**Model Router** — one `ModelProvider` interface with six adapters: OpenAI,
Anthropic, Google Gemini, OpenAI-compatible, Ollama and LM Studio. Models are
discovered from each provider's own endpoint rather than hard-coded.

**Plugin Engine** — every enabled plugin runs in its own OS process. Install,
uninstall, enable, disable, reload, health and permissions are all real. A
plugin that throws on load, hangs or crashes its process takes its own skills
offline and nothing else.

**Skill Registry** — the single place the AI core, missions and workflows look
to find out what Thursday can do. Inputs are validated against each skill's
declared JSON Schema before the plugin sees them.

**Mission system + Agent Supervisor** — one supervisor that walks a mission's
steps, retries what is retryable, pauses for approval where a step demands it,
and verifies every step finished before reporting the mission complete.
Missions persist across restarts.

**Workflow Engine** — eight node types (`ai`, `skill`, `condition`, `wait`,
`human_approval`, `file`, `browser`, `output`) with explicit branching. There is
no visual canvas in Alpha; the execution model came first.

**Command Center** — the dashboard, with a neural brain whose colour, signal
rate and stability are all computed from real application state. When Thursday
is idle it visibly does nothing.

**Diagnostics** — every line is the result of a check run at that moment.

**Permissions** — the full catalogue is modelled now; four are enforced in
Alpha (`browser.read`, `filesystem.read`, `filesystem.write`, `network`). The
rest are declaration-only and are labelled as such in the UI. A plugin can
never receive a permission it did not declare.

### Deliberately not in the Alpha

Desktop/computer control, game control, trading execution, voice, camera
vision, avatars, video or image generation, Obsidian, mobile sync, smart home,
automated purchasing, and the visual workflow canvas. Only the interfaces
future plugins will need exist today.

---

## Project layout

```
src/
  shared/            contract shared by all three processes
    schemas.ts         zod schemas — the source of truth for every type
    ipc.ts             typed IPC contract (channel -> input schema, return type)
    channels.ts        dependency-free channel names for the sandboxed preload
    permissions.ts     permission catalogue
    plugin-api.ts      the interface plugin authors write against
  main/              Electron main process
    core/              db, logger, events, settings, secrets, typed IPC, app state
    browser/           tab manager, downloads          <- Browser Core
    ai/                router, chat, providers/*       <- Thursday AI Core
    plugins/           engine + isolated host process
    skills/            registry + JSON Schema validation
    missions/          store + agent supervisor
    workflow/          execution engine
    diagnostics/       live health checks
  preload/           sandboxed context bridge
  renderer/          React UI (Vite)
plugins/
  demo-tools/        the sample plugin
scripts/
  build-plugins.mjs  compiles plugin TypeScript
  run-acceptance.mjs the acceptance suite
  mock-provider.mjs  local OpenAI-compatible server used by the suite
docs/
```

Further reading: [Architecture](docs/ARCHITECTURE.md) ·
[Plugin development](docs/PLUGINS.md) · [Acceptance results](docs/ACCEPTANCE.md)

---

## Where Thursday keeps your data

| | |
|---|---|
| Linux | `~/.config/thursday-browser` |
| macOS | `~/Library/Application Support/thursday-browser` |
| Windows | `%APPDATA%\thursday-browser` |

`thursday.db` holds settings, providers, plugin metadata, conversations,
missions, workflow runs and logs. `plugin-data/<plugin-id>/` is the only
directory a plugin can write to.

API keys are encrypted with Electron `safeStorage`, backed by the OS keychain.
When no keychain is available — common on a bare Linux server — Thursday still
stores the key so the app works, marks it as unencrypted, and Diagnostics
reports **Secure Storage: Degraded** with the reason. It never implies a key is
protected when it is not.

---

## Troubleshooting

**`Running as root without --no-sandbox is not supported`**
You are running as root. Use `npx electron-vite dev -- --no-sandbox`, or run as
a normal user.

**The window opens but stays blank in dev**
The renderer dev server did not come up. Check the terminal for the
`dev server running ... http://localhost:5173/` line. If port 5173 is taken,
stop the other process and restart.

**A web page shows through the Settings or Command Center screen**
Web pages render in a native view stacked above the UI. The app hides them when
you leave the Browser tab. If you ever see this, it means
`browser:setViewport` did not reach the main process — check the console for an
IPC error.

**`Connection refused by 127.0.0.1:11434`**
Ollama is not running. Start it with `ollama serve`, then press **Re-scan** in
Settings → Local AI.

**Test connection fails with HTTP 401**
The API key is wrong or missing for that provider. Re-enter it in
Settings → AI providers. The detail line shows what the provider actually said.

**A plugin shows `crashed`**
Its host process exited. Thursday restarts it twice, then stops and keeps the
reason on the plugin card. Fix the cause and press **Reload**. The browser core
and every other plugin are unaffected — this is by design, and the acceptance
suite checks it.

**A skill fails with `Permission "filesystem.write" is not granted`**
The permission is declared in the plugin's manifest but not granted. Tick it on
the plugin's card under **Plugins**.

**`npm run dev` fails on a fresh clone**
Run `npm run build:plugins` on its own and read the error. Plugins compile
before Electron starts, so a plugin TypeScript error stops the dev server.

**Changes to a plugin are not picked up**
Plugin entry files are built, not loaded from source. Run `npm run build:plugins`,
then press **Reload** on the plugin's card.

---

## License

MIT
