# Browser runtime (SET 9)

The process where the Browser Agent drives a web browser, apart from Jupiter's
own processes.

- `src/runtime.ts` — the runtime. It uses `playwright-core` to drive an
  installed Chromium-family browser (Microsoft Edge, Google Chrome or
  Chromium) that the host chose. It reads one request at a time from the IPC
  channel and answers with one reply.
  - **Sessions.** Each session is its own browser context, temporary by
    default (nothing on disk). A persistent session uses a profile folder the
    host chose.
  - **Isolation.** Site permissions are none, and service workers are
    blocked.
  - **Tabs.** Pages that open tabs by themselves are blocked, closed and
    counted.
  - **Finding controls.** Role and accessible name come first, then label,
    placeholder, text or test id. A CSS selector is used only when the task
    names one.
  - **Stopping.** Every operation can be stopped: `stop` interrupts a running
    call.
- `src/protocol.ts` — the wire contract (zod), validated in both directions.
  The runtime acts only on paths the host sends: a profile folder, the
  quarantine folder, an evidence file, or a file to upload.
- `src/client.ts` — `BrowserRuntime`, used by the host.
  - It starts the process on first use.
  - Each call has its own deadline, and a runtime that misses it is stopped.
  - A crash is reported once, as `RUNTIME_CRASHED`, and the next call starts
    a new process.
- `src/build.ts` — bundles the runtime and `playwright-core` into one
  self-contained `browser-runtime.cjs`. The desktop build writes it to
  `out/main/`, because the packaged app ships no `node_modules`. The desktop
  host runs it with Electron's own Node.js (`ELECTRON_RUN_AS_NODE`).

Only the host (`apps/desktop/src/main/browser-host.ts`) uses this package.
Decisions: [ADR 0010](../../docs/decisions/0010-browser-agent.md).

Tests:

- `test/client.integration.test.ts` checks the transport against a stand-in
  process.
- `apps/desktop/test/browser-core.integration.test.ts` runs the real runtime
  and a real browser against the fixture sites in
  `@jupiter/testing/web-fixtures`.
