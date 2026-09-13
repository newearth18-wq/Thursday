# Alpha acceptance results

```bash
npm run build
npm run test:acceptance
```

`scripts/run-acceptance.mjs` launches the real application with Playwright's
Electron driver: a real Electron process, the real main process, the real
sandboxed preload bridge and the real React UI. Every call goes through
`window.thursday` in the renderer, so the whole IPC path is exercised. Nothing
inside Thursday is stubbed or mocked.

Run on Linux, Electron 38.8.6 / Chromium 140.0.7339.249 / Node 22.22.0:

```
   1. PASS  Launch Thursday
         Electron 38.8.6, Chromium 140.0.7339.249
   2. PASS  Create browser tab
         2 tab(s) open
   3. PASS  Navigate to a website
         loaded http://127.0.0.1:46873/page1 — title "Page One"
   4. PASS  Back works
         returned to http://127.0.0.1:46873/page1
   5. PASS  Forward works
         advanced to http://127.0.0.1:46873/page2
   6. PASS  Reload works
         reloaded http://127.0.0.1:46873/page2
   7. PASS  Open Thursday Sidebar
         sidebar collapses and reopens with the chat composer
   8. PASS  Add an AI provider
         saved "Acceptance Mock" (openai-compat) at http://127.0.0.1:46873/v1
   9. PASS  Test provider connection
         Connected — 2 models available
  10. PASS  Fetch available models
         discovered: mock-large, mock-small
  11. PASS  Select model
         active model is mock-large
  12. PASS  Send chat message
         stream 5386dd1d started
  13. PASS  Receive streaming response
         8 chunks streamed and persisted: "Echo from mock-large: ping from the acceptance suite…"
  14. PASS  Install/load a sample Plugin
         Demo Tools v1.0.0 running in its own process
  15. PASS  Plugin registers a Skill
         demo-tools.echo_text, demo-tools.get_current_time, demo-tools.save_note
  16. PASS  Thursday discovers the Skill
         3 skills discovered; schema validation rejects bad input
  17. PASS  Create a Mission
         mission f853a877 created with 3 steps
  18. PASS  Mission invokes the Skill
         step 1 returned {"echoed":"mission step one","length":16}
  19. PASS  Command Center updates status
         brain "executing", progress 33%, UI panel rendered
  20. PASS  Mission completes
         all 3 steps completed; note written to .../plugin-data/demo-tools/acceptance.txt
  21. PASS  Logs record execution
         MISSION 8, SKILL 10, PLUGIN 5 entries
  22. PASS  Diagnostics correctly reflects health
         11 checks; Ollama reported "offline" (Not running at http://127.0.0.1:11434)
  23. PASS  Restart application
         application closed and relaunched against the same profile
  24. PASS  Settings and mission history remain
         settings, 1 provider(s), 1 mission(s) and chat history all survived

  Core principle verification (beyond the 24 required tests)
  25. PASS  A broken plugin does not crash the Browser Core
  26. PASS  An undeclared permission is never granted
  27. PASS  A skill loses host access when its permission is revoked
  28. PASS  Workflow engine runs a multi-node workflow
  29. PASS  Browser Core works with AI and plugins disabled
  31. PASS  Mission approval gate blocks, then approves and rejects
  32. PASS  Workflow wait, file, browser and approval nodes all execute
  30. PASS  Invalid IPC input is rejected, not executed

  Required acceptance tests : 24/24 passed
  Core principle checks     : 8/8 passed
  Duration                  : 5.0s
```

---

## What the tests actually prove

Some of these are stronger than the one-line requirement suggests, so it is
worth being precise.

**3–6, navigation.** Real HTTP navigation in a real Chromium `WebContentsView`,
against two pages served over loopback. The suite waits for the tab to reach
the expected URL *and* stop loading, and checks the page title came from the
document — so it is verifying the page really parsed, not that a URL string was
stored.

**9–13, providers and chat.** Real HTTP, real SSE parsing, real persistence.
Test 13 asserts more than one text chunk arrived, which is what distinguishes
genuine streaming from a single buffered response, and then re-reads the
conversation from SQLite to confirm exactly one assistant message was persisted.

**16, skill discovery.** Beyond listing the skill, the suite invokes it and
checks the returned value, then invokes it again with `{ text: 42 }` and asserts
the registry rejects it with `INVALID_INPUT`. Schema validation is enforced, not
decorative.

**18 and 20, missions.** The mission drives three different plugin skills. The
suite reads the first step's real output (`{"echoed":"mission step one"}`) and
the third step's written file path. Completion is checked as `COMPLETED` at 100%
progress, after the supervisor's verification pass.

**22, diagnostics.** Asserts each subsystem reports OK, that a genuinely absent
Ollama is reported **offline** rather than connected, and that no check anywhere
in the report contains the string "something went wrong".

**23–24, persistence.** The app is fully closed and relaunched against the same
profile. Settings, the provider, the stored API key flag, the mission with its
step outputs, and the chat history are all re-read after restart.

**25, plugin isolation.** The suite writes a plugin whose entry file is
`throw new Error(...)`, installs it through the real install path, and asserts:
the plugin is marked unhealthy with the actual error text; the browser still has
its tabs; the healthy plugin is still `ok`; and a skill from the healthy plugin
still executes. This is core principle #4 under test.

**27, permission revocation.** Revokes `filesystem.write`, reloads, confirms
`save_note` now fails with a message naming the permission, then re-grants and
confirms it works again.

**30, IPC validation.** Sends a deliberately malformed payload from the renderer
and asserts it is rejected with a message naming the offending field, rather
than reaching a handler.

**31, the mission approval gate.** Asserts the gated step has produced no output
while the mission sits in `WAITING_APPROVAL` — that it is genuinely blocked, not
merely labelled. Then approves it and checks it runs, and rejects the next one
and checks it is marked `skipped` with no output. This test found a real bug on
its first run: `startMission` set the status to `EXECUTING` *after* launching
the run loop, overwriting the `WAITING_APPROVAL` the loop had already set
synchronously, so a blocked mission reported itself as running. Fixed in
`src/main/missions/supervisor.ts`.

**32, the remaining workflow node types.** Runs `wait`, `file` (write and read
back), `browser` (opens a real tab) and `human_approval` in one workflow, and
asserts the run genuinely blocks at the gate — checking that the browser node
before it had already run — before approving and confirming the file round trip
survived into the run context.

---

## What these tests do NOT cover

Stated plainly, because a passing suite that quietly skips things is worse than
no suite.

**Live vendor APIs are not contacted.** Tests 8–13 point at a local
OpenAI-compatible server (`scripts/mock-provider.mjs`). That exercises
Thursday's provider adapter, HTTP layer, SSE parsing, persistence and UI for
real — but it proves nothing about OpenAI's, Anthropic's or Google's live
services, which need real credentials.

Specifically unverified by automation:
- The Anthropic adapter against `api.anthropic.com`
- The Gemini adapter against `generativelanguage.googleapis.com`
- The OpenAI adapter against `api.openai.com`
- Ollama and LM Studio against real running instances (both were absent during
  the run, so only the **not detected** path was exercised — test 22 asserts
  Thursday reports that honestly rather than claiming a connection)

The three cloud adapters are written against each vendor's documented wire
format and share the tested HTTP/SSE plumbing, but "written correctly" is not
"verified running". Add a provider with a real key and press **Test connection**
to check one.

**Tool calling through a real model is not tested end to end.** The mock
provider does not emit tool calls, so the path from a model's `tool_call` chunk
through the registry and back into the conversation is exercised only by the
mission and workflow tests, which invoke skills directly. The chat-driven tool
loop needs a real model to verify.

**Downloads are not tested.** The code is wired to Electron's `will-download`
and logs each transition, but no test drives a download.

**The `ai` workflow node is not tested.** Tests 28 and 32 cover `skill`,
`condition`, `output`, `wait`, `file`, `browser` and `human_approval` — seven of
the eight node types. The `ai` node is the exception, for the same reason as
above: it needs a real model.

**Mission planning with a model is not tested.** `missions:plan` asks a real
model for a JSON plan. The mock provider only echoes, so the planner's happy
path is unverified; its validation path (rejecting a plan that names an
unregistered skill) is implemented but also untested.

**Platform coverage is Linux only.** The suite has not been run on macOS or
Windows. Nothing in the code is platform-specific beyond Electron's own
behaviour and `safeStorage`, which is explicitly handled and reported.

**Packaging is verified only as a directory build.** `npx electron-builder --dir --linux`
produces `dist/linux-unpacked/`, and that binary was launched and confirmed to
boot with plugins discovered from `resources/plugins`. Installer targets
(AppImage, NSIS, dmg) and code signing were not exercised.

---

## Environment notes

The suite runs headless under `xvfb-run` and passes `--no-sandbox` because the
container runs as root. On a normal desktop account neither is needed.

Each run uses a fresh temporary profile via `--user-data-dir`, so results do not
depend on and do not disturb any existing installation. The profile is deleted
afterwards.
