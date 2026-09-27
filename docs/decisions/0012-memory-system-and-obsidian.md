# ADR 0012 — Memory System and Obsidian: a deterministic policy in Core, sealed sensitive memories, a vault the person chose

- Status: accepted (SET 11)
- Date: 2026-09-27

## Context

SET 11 asks for a memory system and an Obsidian knowledge base:

- memory layers (working, session, long-term, knowledge base), ten
  categories, and a schema with source, confidence, importance, tags,
  relationships, sensitivity and retention
- a policy that decides, for each thing that could be remembered, SAVE,
  DO_NOT_SAVE or ASK_USER
- the person can view, correct, export, forget and delete what is
  remembered
- metadata, keyword, relationship and optional semantic search, which must
  respect the privacy mode (routing)
- Obsidian: choose an existing vault or create a Jupiter Brain folder with
  suggested subfolders; create notes with valid frontmatter and backlinks;
  never restructure silently; atomic writes; keep frontmatter and encoding;
  back up before a change; no duplicate backlinks or filename collisions

The risks are specific. A memory can outlive the conversation it came from
by years, so a password or a card number kept by mistake is a lasting
leak. Semantic search sends memory text to an embedding model, which may be
in the cloud. A vault is the person's own notes: an overwrite, a lost
frontmatter block or a changed line ending is damage to their data.

The Permission Engine (SET 7), the OS-backed vault for API keys (SET 3),
the model router and its routing modes (SET 3) and the safe-path pattern of
the File Agent (SET 10) exist.

## Decisions

### 1. The policy is deterministic code in Core, not a model

`packages/core/src/memory/policy.ts` decides with fixed rules, in English
and Thai, and gives reason codes (`POLICY_REASON_CODES`) for every
decision:

| Found                                                                   | Decision    |
| ----------------------------------------------------------------------- | ----------- |
| A password, API key, token, private key or URL with credentials         | DO_NOT_SAVE |
| Financial (a card number that passes Luhn, bank account), health,       | ASK_USER    |
| biometric, identity number or document, private data about someone else |             |
| The same content already remembered (normalised SHA-256)                | DO_NOT_SAVE |
| Not asked for explicitly, and too short or of low importance            | DO_NOT_SAVE |
| Not asked for explicitly, and of low confidence                         | ASK_USER    |
| Otherwise                                                               | SAVE        |

A credential is refused even when the person asks for it to be remembered;
Jupiter has a vault for keys (SET 3). A model is never asked whether to
remember something: the decision has to be the same every time, explainable
and testable.

In chat, only an explicit request ("remember that…", "จำไว้ว่า…") is a
candidate. Nothing else a person types becomes a memory on its own.

### 2. Where each layer lives

| Layer          | Where                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| Working        | The `memory.recall` step: matching memories handed to a Mission, fenced as data               |
| Session        | Core's memory (RAM) until Core stops                                                          |
| Waiting        | Candidates for ASK_USER: RAM only, at most 100, discarded after 24 hours                      |
| Long-term      | SQLite, migration 11 (`memories`), until the person deletes it or its retention ends          |
| Knowledge base | Markdown notes in the person's Obsidian vault, reached only through the host (`host.notes.*`) |

A candidate waiting for the person is never written to disk, logged or put
in an event. Only the person (the `user-interface` actor) can answer it.

### 3. Sensitive memories are sealed by the operating system, or not kept

When the person keeps a sensitive memory, Core asks the host to seal it
(`host.vault.seal`, Core actor only), which uses Electron `safeStorage`
(DPAPI on Windows, the keyring on Linux, as for API keys). The database row
has no content and no content key (a CHECK constraint enforces both), it is
never embedded (a trigger refuses it), never exported, never in an event or
a log, and never recalled into a Mission. It is unsealed only when the
person presses Reveal. Without secure storage a sensitive long-term memory
is not kept at all (`SECURE_STORAGE_UNAVAILABLE`; the candidate keeps
waiting), and the screen says so. A sensitive memory kept for _this session
only_ stays in Core's RAM and is never sealed or written.

### 4. Semantic search goes through the router and obeys the privacy mode

Semantic search is off by default (`memory.semanticSearch`). When it is on,
Core asks the model router for an embeddings model
(`providers.route('embeddings', …)`), which applies the routing mode: under
Local only, only a model on this computer can be chosen, and the guarded
transport refuses any other host again. When no model can be used, the
search falls back to keywords and says why; it never waits for or silently
uses the cloud. Sensitive memories are never sent to any model. Vectors are
kept only for normal memories and dropped when the content changes.

### 5. The person controls every memory

- **Correct:** changes content, tags or kind; the number of corrections is
  kept. A correction that would make it a credential is refused
  (`MEMORY_REFUSED`); one that would make it sensitive must be added again
  (`MEMORY_BECOMES_SENSITIVE`), so it is asked about.
- **Forget:** the memory stays but is never recalled or searched by
  default; it can be restored.
- **Delete:** `memory.delete` (HIGH, target `memory:<id>`), asked when it
  runs. The row and its embeddings are removed, and with
  `PRAGMA secure_delete = ON` and a WAL checkpoint (`TRUNCATE`) no copy of
  the content stays in the database files.
- **Export:** a JSON artifact (SET 10) without sensitive content.
- **Policy log:** every decision, by the policy or the person, with its
  reasons and never the content; append-only (triggers refuse UPDATE and
  DELETE).

Default grants for the Memory agent (`memory.read`, `memory.write` on
`jupiter:memory`) are made once by `core`, visible and revocable in
_Settings › Permissions_ (the SET 7 rule).

### 6. The vault is the one the person chose, reached only through the host

`NotesHost` (`apps/desktop/src/main/notes-host.ts`) keeps the chosen folder
in `<data folder>\notes-vault.json`. The folder comes from the system's
folder dialog, never from a request. Connecting and disconnecting are for
the person only.

- **Obsidian vault:** must contain `.obsidian` (`NOT_A_VAULT` otherwise).
- **Jupiter Brain:** a `Jupiter Brain` folder in the chosen folder (or in a
  vault). Its nine suggested subfolders are created only when the person
  presses _Add the suggested folders_, and only those that are missing,
  after a manifest is written. Nothing existing is moved or renamed.

Paths are resolved with the SET 10 resolver (`safe-path.ts`): relative
only, no `..`, no links or junctions, the real path inside the vault;
`.obsidian` and `.trash` are never touched. `notes.read` and `notes.write`
(MEDIUM) are checked for the exact file when the operation runs.

### 7. Writing notes never harms an existing note

- **New note:** written to a temporary file and linked to a free name
  (`Title (2).md`), so nothing is overwritten.
- **Change** (a backlink, an appended section): only if the file still has
  the hash Core read (`NOTE_CHANGED` otherwise); a copy is kept first in
  `<data folder>\notes-backups\<vault>\<time>\`; the BOM and the line
  endings of the note are kept; lines are only added.
- **Frontmatter:** written as YAML with JSON-quoted strings; an existing
  block is never rewritten.
- **Links:** every link must resolve to an existing note
  (`NOTE_LINK_TARGET_MISSING`); a backlink is added only where it is
  missing, under a `## Backlinks` heading.
- All permissions for a note and its backlink targets are checked before
  anything is written.

### 8. Note text is untrusted data

`notes.read` and `notes.search` return the text as data. In Missions,
`notes.read` and `notes.search` pass it on only between
`BEGIN/END UNTRUSTED NOTE TEXT` fences, and `memory.recall` between
`BEGIN/END MEMORY` fences.

## Alternatives rejected

- **A model decides what to remember.** Not repeatable, not explainable,
  and it would need the content sent to a model first.
- **Encrypting the whole database.** It would not stop the content reaching
  logs, events or embeddings, and it needs a key store anyway; sealing the
  sensitive rows with the OS store is narrower and testable.
- **A vector database.** A few hundred memories fit in SQLite rows with a
  cosine scan; a second store would be another place for content to leak.
- **Writing into the vault with Obsidian's own plugin API.** Needs Obsidian
  running and a plugin in the person's vault; files on disk are Obsidian's
  own format.

## Consequences

- A new sensitive kind is a detector in `policy.ts`, a `SENSITIVE_KINDS`
  entry and a reason code, with tests in English and Thai.
- A new note operation is a `NoteOps` entry, a host method that resolves
  inside the vault, and a Core method that checks `notes.*` for the exact
  file.
- Semantic search quality depends on the embedding model the person has;
  with none, keyword search is used and the screen says so.
- Deleted memories cannot be recovered, by design; forgetting is the
  reversible choice.
