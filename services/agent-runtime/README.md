# Agent runtime (SET 8)

The process where the Windows Computer Agent's UI Automation runs, apart from
Jupiter's own processes.

- `src/uia-runtime.ps1` — the runtime: Windows PowerShell 5.1 with the .NET UI
  Automation client. It reads one request per line from standard input and
  writes one reply per line (Base64 of UTF-8 JSON). It keeps no state and acts
  only on what the host sends: window handles, element queries, an executable
  and arguments the host chose, a screenshot path in the host's folder.
- `src/protocol.ts` — the wire contract (zod), validated in both directions.
- `src/client.ts` — `AgentRuntime`, used by the host: starts the process on first
  use (the script is sent over standard input, nothing is written to disk),
  one deadline per call, a hung runtime is stopped, a crash is reported once as
  `RUNTIME_CRASHED`, and the next call starts a new process.

Only the host (`apps/desktop/src/main/computer-host.ts`) uses this package.
Decisions: [ADR 0009](../../docs/decisions/0009-windows-computer-agent.md).
