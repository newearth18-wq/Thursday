# SET 10 — File, Document, Office and Artifact System

- Status: **all 10 acceptance tests pass locally**, in-process (real host,
  real document runtime, real Core) and in the real Electron application.
  Evidence: §7 and §12. CI: see §7 (filled in from the pull request's run).
- SET 9 was checked first: green in CI on Linux, Windows and Legacy
  (`7765c4c`, run 36295800015) and merged (PR #6). Its suites pass again on
  the SET 10 code; the changes to earlier tests are listed in §12.
- Office files are checked by independent parsers: python-docx 1.2.0,
  python-pptx 1.0.2 and openpyxl 3.1.5.

## 1. Scope completed

### File operations (File Agent)

- **Find and list** in an approved folder, optionally recursive (depth 5,
  at most 5,000 entries checked), filtered by format and name, sorted by
  real modified time, name or size.
- **Metadata** for every entry: name, relative path, kind, format, size,
  modified and created times.
- **Copy, move and rename** (never over an existing file), **new folder**,
  **open** (allow-listed document and image types only), **show in folder**.
- **Delete** only with the CRITICAL `files.delete` permission for the exact
  file, asked every time (Allow once or Deny); the file goes to the Recycle
  Bin.

### Approved roots and exact paths

- Roots: Downloads, Documents, Desktop and the Jupiter workspace
  (`<data folder>\workspace`).
- A request names a root and a relative path (`FileLocation`). Absolute
  paths, drive letters, `..`, NUL, alternate data streams (`:`), reserved
  Windows names and over-long names are refused by the contract.
- The host resolves each segment with `lstat` and refuses any symbolic link,
  junction or other reparse point, then checks the real path is still inside
  the real root (`PATH_REFUSED`). Listings never follow links; they are
  counted as skipped.

### Reading documents

TXT, MD, CSV, JSON, PDF, DOCX, PPTX and XLSX, in the document runtime (its
own process):

- text, up to a character limit the caller chooses, with `truncated` and the
  full character count
- metadata: title, author, subject, created and modified, pages, slides,
  sheets, words
- structure: PDF pages, DOCX headings, PPTX slides (title, text, notes,
  images), XLSX sheets (rows, columns, formulas — reported, never
  evaluated)
- text that tries to direct the agent is labelled (the SET 9 kinds)

### Creating documents

TXT, MD, CSV, JSON, DOCX, PPTX and XLSX from a validated `DocumentSpec`, and
**PDF** through a verified production path: the host prints sanitized HTML
with Electron's `printToPDF` (no script, every request blocked) and the
runtime reads the PDF back.

- **DOCX:** headings, paragraphs, bullets, tables, Thai text (complex-script
  font).
- **PPTX:** theme (accent colour, font), title and content layouts, bullets,
  images (PNG or JPEG, sized from their headers), speaker notes, 16:9.
- **XLSX:** typed columns (text, number, date, boolean), an allow-list of
  formulas (SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, AND, OR,
  NOT, MEDIAN); text that looks like a formula stays text.
- **CSV:** UTF-8 with BOM, RFC 4180, formula prefixes neutralized.

Each written file is validated before it is kept: content types, well-formed
XML, relationships, main part, body/slides/sheets structure, and the content
read back compared with the spec.

### Artifacts (Artifact Manager)

- **Schema:** artifact id, Mission and step, name, type, location and full
  path, created time, source (kind, transformation, source artifact or file),
  version, size, SHA-256, verification status (VERIFIED, FAILED, MISSING)
  with each check, verified time, kept, deleted time.
- **Workspace per Mission** (`workspace/<missionId>/`, or `workspace/shared/`).
- **Atomic writes:** temporary `.jupiter-writing-<id>.<ext>` → validate →
  link to a free name (`name (2).ext`). Nothing is overwritten; a new
  version is a new file with `version + 1` and lineage to the previous one.
- **Verification** again at any time (`unchanged`, `readable`, structure).
- **Actions:** Open, Show in folder, Copy path, Save a copy to Downloads,
  Documents or Desktop (a new, kept artifact), Check again, Keep / Stop
  keeping, Delete (Recycle Bin; the record stays, marked deleted).
- **Cleanup** only for a finished Mission, with `files.delete` for its
  folder; never removes kept files.

### Missions

- New step types (runner `files`): `document.read_newest` (the newest file
  of a format in a root, by modified time), `document.read` and
  `document.create`.
- Document text reaches later steps only between
  `BEGIN/END UNTRUSTED DOCUMENT TEXT` fences, with its source file and
  modified time.
- The Mission detail lists its files (artifacts), with every artifact
  action.
- Example workflow "Find newest PDF in Downloads and summarize it" runs end
  to end (§12, AT7).

### Interface

- **Files** screen (was _Coming later_): approved folders and availability,
  find form, results with Read, Open, Show in folder and Delete, a document
  preview with metadata and the "Document content" untrusted label, and the
  list of files Jupiter made.
- **Missions:** a Files section in the Mission detail; File Agent in the
  agents row.
- **Activity feed:** file and artifact events.
- **Languages:** English and Thai; the new error codes have summaries in
  both.

## 2. Files added or changed

- **Contracts:** `packages/contracts/src/files.ts` (new);
  `permissions.ts` (`files.list`, `files.open`, `files.delete`,
  `artifacts.create`), `capabilities.ts` (`files.*`, `artifacts.*`),
  `events.ts` (`file.operation`, `artifact.created`, `artifact.changed`),
  `host-operations.ts` (`host.files.call`), `missions.ts` (`files`).
- **Document runtime** (new): `services/document-runtime/` — protocol,
  XML, package, readers, writers (DOCX, PPTX, XLSX, text), validator,
  runtime, client, build, README, tests.
- **Core:** `packages/core/src/files/` (new: `agent.ts`, `driver.ts`,
  `steps.ts`); `kernel/core-kernel.ts`, `kernel/capabilities.ts`,
  `missions/manager.ts`, `workflow/catalogue.ts`, `workflow/validate.ts`,
  `ports.ts`.
- **Database:** migration 10 `0010_artifacts`, `repositories/artifacts.ts`,
  `test/artifacts.integration.test.ts`.
- **Host:** `apps/desktop/src/main/file-host.ts` (new), `index.ts` (roots,
  PDF printing, Recycle Bin), `host-capabilities.ts`, `services.ts`,
  `electron.vite.config.ts` (bundles `document-runtime.mjs`).
- **Renderer:** `views/FilesView.tsx`, `components/ArtifactList.tsx`,
  `useFiles.ts`, `fileText.ts` (new); `App.tsx`, `destinations.ts`,
  `FeatureViews.tsx`, `MissionsView.tsx`, `useMissions.ts`,
  `ActivityTimeline.tsx`, `errorText.ts`, `i18n/en.ts`, `i18n/th.ts`,
  `styles.css`.
- **Testing:** `packages/testing/fixtures/documents/` (PDF and PNG made by
  Chromium; DOCX, PPTX, XLSX by python-docx, python-pptx, openpyxl),
  `scripts/make-document-fixtures.*`, `scripts/check-office.py`,
  `src/documents.ts`.
- **Tests:** `apps/desktop/test/files-core.integration.test.ts`,
  `files.integration.test.ts` (E2E), `packaged.integration.test.ts` (SET 10
  check); earlier suites updated (§12).
- **CI:** Python 3.12 and the three parsers on the Linux and Windows jobs.
- **Docs:** ADR 0011, `ARCHITECTURE.md`, `SECURITY.md`, `README.md`,
  `AGENTS.md`, this report and `docs/sets/set-10/`.

## 3. Architecture decisions

[ADR 0011](../decisions/0011-file-agent-and-artifacts.md):

1. Three layers, as in SET 8 and 9: Core decides, the host resolves paths
   and owns folders, the document runtime only parses and writes.
2. Paths are resolved segment by segment; links and junctions are refused.
3. Documents are parsed and written in their own process with limits.
4. Writes are atomic and never overwrite.
5. Office files come from our own OOXML writers and are checked by our
   validator and, in tests, by independent parsers; PDF only through
   Electron's printer, read back.
6. Artifact records are never deleted.
7. Permissions at use, for the exact file; delete is CRITICAL.
8. Document text is untrusted data.

Rejected: LibreOffice (large, absent on most machines, and a full office
suite on untrusted input), parsing in Core, following links that stay inside
a root.

## 4. Database migrations

Migration 10 `0010_artifacts` adds the `artifacts` table (STRICT): CHECKs on
type, root, version, size, hash length, status, kept, and valid JSON;
indexes by Mission, time and name/version; a trigger that refuses `DELETE`.
It is appended after migration 9; no shipped migration was edited. The
database tests cover the round trip, listing and versioning, invalid rows
and the delete refusal.

## 5. Security implications

- The renderer still has no file access of its own: every file operation is
  a capability that takes a root and a relative path, resolved by the host;
  the SET 1 gateway test now also checks that absolute and `..` paths are
  refused.
- Every operation asks for its permission for the exact resolved file;
  delete is CRITICAL (Allow once or Deny) and reversible (Recycle Bin).
- Nothing is overwritten; artifact records are append-only.
- Hostile documents are contained: separate process, memory limit,
  deadlines, size/part/zip-bomb limits, no DTD or entities, no formula or
  script evaluation, CSV formula injection neutralized.
- Document text never becomes instructions: labelled, fenced in Missions.
- PDF printing runs no script and makes no request.

`SECURITY.md` lists the new controls and their tests.

## 6. Commands actually run

```bash
npm ci
npx vitest run services/document-runtime/test packages/database/test/artifacts.integration.test.ts
npx vitest run --project integration apps/desktop/test/files-core.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/files.integration.test.ts
JUPITER_PACKAGED_EXECUTABLE=apps/desktop/dist/linux-unpacked/jupiter node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/packaged.integration.test.ts
npm run verify
```

## 7. Automated test results

### Local run

`npm run verify` on Linux (Node.js 22, Xvfb, a throwaway GNOME Keyring):
**13/13 steps PASS**, exit 0.

- unit tests: 26 files, 250 tests
- integration and Electron E2E: 39 files passed and 2 skipped; 291 tests
  passed and 15 skipped (the Windows-only SET 8 suites and the Windows
  installer check)
- packaged-app launch: 4 tests (5 after the SET 10 packaged check was added;
  run separately afterwards: 5/5)

The SET 10 suites:

| Suite                                                          | Tests | What it runs                                                                                                                               |
| -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/document-runtime/test/documents.integration.test.ts` | 13    | The real runtime: every reader, every writer with independent parsers, formula and CSV rules, damaged files, XXE, zip bomb, crash          |
| `apps/desktop/test/files-core.integration.test.ts`             | 7     | Real Core, host and runtime: AT1–AT10, the example workflow, delete, crash recovery, traversal, symbolic link and junction                 |
| `apps/desktop/test/files.integration.test.ts`                  | 7     | The real Electron app: Files screen, reading, a Mission with DOCX and PDF artifacts, the CRITICAL delete dialog, errors — with screenshots |
| `packages/database/test/artifacts.integration.test.ts`         | 3     | Store round trip, listing and versions, invalid rows and the delete refusal                                                                |
| `apps/desktop/test/packaged.integration.test.ts` (SET 10 test) | 1     | The packaged app writes and verifies a DOCX and a PDF with the runtime from `app.asar`; the `document-runtime` service is HEALTHY          |

### CI

To be filled in from the pull request's CI run.

### Found and fixed during the SET

| Found                                                                                                                                      | Fix                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| PPTX slides read as missing: `<p:sldId id="256" r:id="rId2"/>` has both `id` and `r:id`; the plain one won                                 | `relId()` prefers the relationship id                                                                           |
| E2E: reading a file that does not exist first asked the person for permission to read it                                                   | A missing file fails at once with `FILE_NOT_FOUND`; both the in-process and E2E tests assert no request is made |
| Build-output test: Core's bundle gained an unused `node:module` import (a method named `require(` triggered electron-vite's CommonJS shim) | The method was renamed; Core's imports are unchanged from SET 9                                                 |
| "1 files found" in the Files screen                                                                                                        | Reworded ("Matching files: 1")                                                                                  |

## 8. Manual tests

The E2E suite drives the real app and saves screenshots, copied to
[docs/sets/set-10](set-10/). Each was reviewed by eye:

| File                                | Shows                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `01-files-available.png`            | Files: Available, the formats it reads and creates, the four approved folders                                               |
| `03-pdf-read.png`                   | The newest PDF (report.pdf, 20 Sept) found; its preview: "Document content" label, title, "Pages: 2", the text              |
| `04-pptx-read.png`                  | A PPTX preview: slides with titles and notes                                                                                |
| `05-xlsx-read.png`                  | An XLSX preview: sheets with rows, columns and formulas                                                                     |
| `06-damaged-file.png`               | A damaged DOCX: "The file is damaged or is not the format its name says", `DOCUMENT_INVALID`; the app keeps working         |
| `08-mission-artifacts-verified.png` | The Mission's files: summary.docx (13 of 13 checks) and summary.pdf (6 of 6), both Verified, with their actions and lineage |
| `10-delete-permission-critical.png` | Delete: `files.delete`, the exact path, Critical, "The file is moved to the Recycle Bin", only Deny and Allow once          |
| `11-artifact-deleted.png`           | The artifact marked Deleted (no verification badge: the file is gone), its record and checks kept                           |

## 9. Known limitations

- **Not built:** editing documents in place, OCR of scanned PDFs, legacy
  binary formats (DOC, PPT, XLS), conversion through an office suite.
- **PDF reading** gives text, not layout; a scanned PDF has no text
  (`DOCUMENT_EMPTY`).
- **XLSX formulas** are kept and reported but not calculated by Jupiter;
  Excel recalculates on open (`fullCalcOnLoad`).
- **Opening files** uses the system's default app, so it cannot be checked
  in tests beyond the host's allow-list; the E2E suite does not click Open.
- **Recycle Bin:** on Linux it is the desktop's trash; tests use a folder,
  never the real one.
- **Copying the path** uses the page's own copy command (the renderer has no
  clipboard permission).

## 10. How to run

```bash
npm ci && npm run dev
```

1. Open _Files_. Choose a folder and a format, then _Find_. Answer the
   permission request (it names the folder).
2. _Read_ a document; the preview shows its metadata and text.
3. Create a Mission such as "Find newest PDF in Downloads and summarize it"
   (needs a model provider). Its files appear in the Mission and in _Files_.

The in-process tests (python-docx, python-pptx and openpyxl needed):

```bash
python3 -m pip install python-docx python-pptx openpyxl
npx vitest run --project integration apps/desktop/test/files-core.integration.test.ts
```

## 11. Evidence and artifact paths

- `docs/sets/set-10/*.png`: the E2E screenshots (also written to
  `test-results/set-10/` on each run)
- CI: see §7

## 12. Acceptance tests

| #   | Test                                                         | Status   | Evidence (`files-core.integration.test.ts` unless noted)                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Find newest file correctly from controlled fixture           | **PASS** | Listing first asks for `files.list` on the exact Downloads folder. Then three PDFs with set times come back newest first: `m-newest-report.pdf` (2026-09-20T08:30), `z-middle-report.pdf`, `a-old-report.pdf`; a newer DOCX is not a candidate. E2E: every fixture has a set time; the Files screen lists report.pdf first (screenshot 03)                            |
| 2   | Read TXT                                                     | **PASS** | `notes.txt` text is exactly `Mission notes\nLine two with ภาษาไทย.\n`, size 51. E2E: read in the Files screen                                                                                                                                                                                                                                                         |
| 3   | Parse PDF                                                    | **PASS** | report.pdf: title "Jupiter Quarterly Report", 2 pages, page 2 contains "Revenue grew by 12 percent." E2E: preview with "Pages: 2" and the untrusted label (screenshot 03)                                                                                                                                                                                             |
| 4   | Parse DOCX                                                   | **PASS** | briefing.docx: headings `Mission Briefing`, `Moons`; the table row `Ganymede	5268`. E2E: preview                                                                                                                                                                                                                                                                       |
| 5   | Parse PPTX and XLSX metadata/content                         | **PASS** | review.pptx: slides in order with titles, notes and image counts. budget.xlsx: sheets with rows and formula counts, title "Budget 2026". E2E: slide and sheet lists (screenshots 04, 05)                                                                                                                                                                              |
| 6   | Generated PPTX/DOCX/XLSX open and pass structural validation | **PASS** | All three are VERIFIED, in the workspace, with SHA-256 and the structural checks; python-docx, python-pptx and openpyxl open them with the expected title, slides and sheet. A second DOCX of the same name is version 2 with lineage, a new file, the first untouched; no temporary file left. Runtime suite: full content checks                                    |
| 7   | Artifact appears in Mission with verified status             | **PASS** | The example workflow Mission completes: the step names `m-newest-report.pdf` by its modified time; the model got it inside the untrusted fences; the Mission's `files` has the DOCX, VERIFIED, with lineage; checked again: unchanged; cleanup removes nothing kept. E2E: DOCX and printed PDF both Verified in the Mission (screenshot 08)                           |
| 8   | Delete requires permission and exact target                  | **PASS** | Delete fails with `PERMISSION_REQUIRED`; one request, `files.delete`, CRITICAL, target the exact path, offered only ALLOW_ONCE/DENY; the file stays until allowed, then goes to the Recycle Bin. The next file asks again; denied → nothing deleted. An artifact's delete is the same, record kept. E2E: the dialog (screenshot 10)                                   |
| 9   | Nonexistent/corrupted file returns failure without crashing  | **PASS** | Missing → `FILE_NOT_FOUND` at once, no permission asked. Truncated DOCX and a fake PDF → `DOCUMENT_INVALID` (validation). The runtime killed with SIGKILL → `RUNTIME_CRASHED`, then the next read works on a new process. E2E: the error in the Files screen, Core still running (screenshot 06)                                                                      |
| 10  | Path traversal and scope escape rejected                     | **PASS** | `../outside.txt`, `a/../../x.txt`, `/etc/passwd`, `C:\Windows\win.ini`, `report.txt:hidden`, `CON`, `NUL.txt` → `INVALID_PAYLOAD`. A file link and a folder link (a junction on Windows) out of Documents → `PATH_REFUSED`; a copy through the link is refused and nothing is written outside; listings skip links. E2E and the SET 1 gateway test: the same refusals |

### SET 0–9 re-check (on the SET 10 code)

All earlier suites pass in the same `npm run verify` run. They were updated
only where SET 10 changed facts:

- **SET 1 AT3:** the example of an unknown capability is now
  `files.execute` (`files.read` exists).
- **SET 1 AT10:** the file capabilities are listed, with the reason each is
  safe, and the test now checks that absolute and `..` paths are refused.
- **SET 2 AT10 and the shell test:** Files is no longer _Coming later_ (four
  planned destinations, not five).
- **SET 5:** the step-type list includes the three `document.*` types,
  unavailable where there is no File Agent.
- **Build output:** unchanged — Core imports the same five Node modules.
