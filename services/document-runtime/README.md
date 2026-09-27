# Document runtime (SET 10)

The process where Jupiter reads, writes and checks documents, apart from
Jupiter's own processes. A damaged or hostile file can crash or hang only
this process.

- `src/runtime.ts` — the runtime. It reads one request at a time from the IPC
  channel (`ping`, `extract`, `write`, `validate`) and answers with one reply.
  It acts only on paths the host sends.
- `src/readers.ts` — text and metadata from TXT, MD, CSV, JSON, PDF
  (`pdfjs-dist`, text only: no font loading, no XFA forms), DOCX, PPTX (slides and notes)
  and XLSX (sheets, typed values; formulas are reported, never evaluated).
- `src/writers/` — DOCX, PPTX and XLSX written from a validated
  `DocumentSpec` as Office Open XML, and TXT, MD, CSV (formula prefixes
  neutralized) and JSON. PDF is not written here: the host prints it with
  Electron and this runtime reads it back.
- `src/validate.ts` — structural checks of a written file (content types,
  well-formed XML, relationships, main part, body/slides/sheets) and a check
  that its content matches the spec.
- `src/xml.ts` — a small XML parser that refuses DOCTYPE and entities and
  limits nesting. `src/package.ts` — ZIP reading (`fflate`) with limits.
- `src/protocol.ts` — the wire contract (zod), validated in both directions,
  and `LIMITS`:
  - files up to 100 MB; packages up to 5,000 parts and 300 MB unpacked
  - a compression ratio above 200 is treated as a zip bomb
  - XML nesting up to 256; up to 500 pages, slides or sheets read
- `src/client.ts` — `DocumentRuntime`, used by the host.
  - It starts the process on first use, with a memory limit.
  - Each call has its own deadline, and a runtime that misses it is stopped.
  - A crash is reported once, as `RUNTIME_CRASHED`, and the next call starts
    a new process.
- `src/build.ts` — bundles the runtime, `pdfjs-dist` and `fflate` into one
  ES module, `document-runtime.mjs`. The desktop build writes it to
  `out/main/`, because the packaged app ships no `node_modules`. The desktop
  host runs it with Electron's own Node.js (`ELECTRON_RUN_AS_NODE`).

Only the host (`apps/desktop/src/main/file-host.ts`) uses this package.
Decisions: [ADR 0011](../../docs/decisions/0011-file-agent-and-artifacts.md).

Tests:

- `test/documents.integration.test.ts` runs the real runtime on the fixtures
  in `@jupiter/testing/documents`, writes every format, validates it, and
  opens the Office files with independent parsers (python-docx, python-pptx,
  openpyxl) through `checkOffice`.
- `apps/desktop/test/files-core.integration.test.ts` runs Core, the host and
  this runtime together for SET 10's acceptance tests.
