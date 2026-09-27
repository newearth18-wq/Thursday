# ADR 0011 — File Agent and Artifact Manager: decisions in Core, paths resolved by the host, documents parsed in their own process

- Status: accepted (SET 10)
- Date: 2026-09-27

## Context

SET 10 asks for a file, document, Office and artifact system:

- find, list, sort, copy, move, rename, create folders, open and reveal files,
  and delete them only with permission
- read TXT, MD, CSV, JSON, PDF, DOCX, PPTX and XLSX
- create TXT, MD, CSV, JSON, DOCX, PPTX and XLSX, and PDF where a verified
  production path exists
- artifacts with lineage, versions, hashes and verification, a workspace per
  Mission, atomic writes, and a cleanup that never removes what the person
  chose to keep

Every document is untrusted input: a file can be damaged, huge, a zip bomb,
or written to direct the agent. Every path is untrusted too: `..`, absolute
paths, links and junctions must never reach outside the folders Jupiter may
use. The Permission Engine (SET 7) and the pattern of the Computer and
Browser Agents (SET 8, SET 9) exist.

## Decisions

### 1. Three layers, as in SET 8 and SET 9

| Layer                                                        | Decides                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Core** — `FileAgent` (`packages/core/src/files/`)          | What to do, which permission each operation needs for which exact file, artifact records, versions, lineage, cleanup. Owns events and storage.                     |
| **Host** — `FileHost` (`apps/desktop/src/main/file-host.ts`) | Where the approved folders are, how a relative path resolves (and whether it is refused), atomic writes, the Recycle Bin, opening and revealing. Serves only Core. |
| **Document runtime** — `services/document-runtime`           | Nothing. Parses, writes and validates exactly the bytes one validated request names, with size, entry and time limits, in a process of its own.                    |

Core never sends an absolute path: every request names an approved root
(`downloads`, `documents`, `desktop` or `workspace`) and a relative path,
checked by the `RelativePath` contract (no `..`, no drive letters, no
separators at the start, no reserved Windows names).

### 2. The host resolves every path, segment by segment

`FileHost.resolve` walks the relative path one segment at a time with
`lstat`. Any symbolic link, junction or other reparse point on the way is
refused (`PATH_REFUSED`), and the final real path must still lie inside the
real root (`realpath` containment). A refusal happens before anything is
read or written, and is reported as a `file.operation` event with outcome
`refused`.

**Alternative considered.** Following links that stay inside the root. It
needs the same checks at every use (a link can change between check and
use), so refusing links is simpler and safer.

### 3. Documents are parsed and written in a separate process

`services/document-runtime` is bundled by esbuild into one ESM file
(`document-runtime.mjs`) with `pdfjs-dist` (PDF text and metadata) and
`fflate` (ZIP). It runs on Electron's own Node.js with a memory limit, is
restarted after a crash, and every request has a deadline. A damaged or
hostile file can crash or hang only that process.

- **XML** is read by a small parser of our own that refuses DOCTYPE and
  entities (no XXE, no billion laughs) and limits depth.
- **ZIP packages** are limited to 5,000 entries and 300 MB unpacked, with a
  compression-ratio check against zip bombs.
- **Formulas** are never evaluated; XLSX formulas are reported as text.

**Alternatives considered.** LibreOffice (large, not present everywhere, and
a full office suite running on untrusted input); parsing in Core (a hostile
file could take Core down).

### 4. Writing is atomic and never overwrites

A new file is written to a temporary name (`.jupiter-writing-<id>.<ext>`)
in its target folder, validated, then linked to the first free name
(`name.ext`, `name (2).ext`, …). A file that already exists is never
replaced; a new version of an artifact is a new file and a new record with
`version + 1`. If validation fails, the temporary file is removed and the
error is returned.

### 5. Office files are written by our own OOXML writers and checked twice

DOCX (styles, headings, bullets, tables, Thai complex-script font), PPTX
(theme, master, layouts, notes, images sized from their headers, 16:9) and
XLSX (typed cells, inline strings, an allow-list of formulas, dates) are
written from a validated `DocumentSpec`. After writing, the runtime checks:

- every part has a content type, every XML part is well formed, every
  relationship resolves, the main part exists
- the body, slides or sheets have the expected structure
- the content read back matches the spec

The tests also open every generated file with an independent parser
(python-docx, python-pptx, openpyxl).

**PDF** is made only where a verified path exists: the host prints
sanitized HTML with Electron's `printToPDF` in a hidden window that runs no
script and makes no network request, then the runtime reads the PDF back.

### 6. Artifacts are records that are never deleted

An `Artifact` records name, type, location and full path, creation time,
source and transformation (lineage, including the file it came from), version,
size, SHA-256, verification status (`VERIFIED`, `FAILED`, `MISSING`) with each
check, `kept` and `deletedAt`. Migration 10 stores them; a trigger forbids
`DELETE`. Deleting the file marks the record.

Each Mission writes to its own workspace folder (`workspace/<missionId>/`).
Cleanup is allowed only after the Mission has finished, asks for
`files.delete` for that folder, and never removes an artifact marked
_kept_. A shared copy is saved outside the workspace (Downloads, Documents
or Desktop), so cleanup never reaches it.

### 7. Permissions at use, for the exact file

| Capability         | Risk     | Used for                                               |
| ------------------ | -------- | ------------------------------------------------------ |
| `files.list`       | LOW      | Listing a folder                                       |
| `files.read`       | MEDIUM   | Reading a document                                     |
| `files.write`      | HIGH     | Copying, moving, renaming, creating a folder           |
| `files.open`       | LOW      | Opening a file in its app, or showing it in its folder |
| `files.delete`     | CRITICAL | Moving a file to the Recycle Bin (Allow once or Deny)  |
| `artifacts.create` | LOW      | Saving a new artifact in the Jupiter workspace         |

Each is checked by `PermissionEngine.check` when the operation runs, with
the exact resolved path as its target. Deletion goes to the Recycle Bin
(`shell.trashItem`), so it can be undone.

### 8. Document text is untrusted data

`files.read` returns the text with the document's metadata and any passages
that try to direct the agent (the same labels as SET 9). In Missions,
`document.read` and `document.read_newest` pass it to later steps only between
`BEGIN/END UNTRUSTED DOCUMENT TEXT` fences, with its source file and
modified time.

## Consequences

- A new format is a reader and/or writer in the runtime, a validator for it,
  and a `DOCUMENT_FORMATS` entry.
- Opening a file is limited to an allow-list of document and image types;
  anything else, executables and scripts included, is `OPEN_REFUSED`.
- On Linux the "Recycle Bin" is the desktop's trash; in tests it is a folder
  next to the test folders, never the real one.
