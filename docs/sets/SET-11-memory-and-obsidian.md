# SET 11 — Memory System and Obsidian Knowledge Base

- Status: **all 10 acceptance tests pass**, in-process (real Core, real
  SQLite, real vault folders on disk) and in the real Electron application
  (E2E, with screenshots). Local `npm run verify`: 13/13 steps PASS. CI: see §7 (filled in from the pull request's run).
  Evidence: §7 and §12.
- SET 10 was checked first: green in CI on Linux, Windows and Legacy
  (`59e2c77`, run 36309148629) and merged (PR #7, `f497c2d`). Its suites
  pass again on the SET 11 code; the changes to earlier tests are listed in
  §12.
- Markdown notes are checked by an independent reader (Python with PyYAML
  6.0.x, `packages/testing/scripts/check-markdown.py`).

## 1. Scope completed

### Memory layers and schema

| Layer          | Where it lives                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Working        | The `memory.recall` Mission step: matching memories passed to later steps, fenced `BEGIN/END MEMORY` |
| Session        | Core's RAM, until Core stops (_This session only_)                                                   |
| Long-term      | SQLite (migration 11), until the person deletes it or its retention date passes                      |
| Knowledge base | Markdown notes in the Obsidian vault the person connected                                            |

- **Ten types:** preferences, people, projects, documents, decisions, tasks,
  routines, facts, ideas, relationships.
- **Entry:** id, type, content (hidden for sensitive memories until
  revealed), source (you, chat, Mission or note, with a link back), created
  and updated times, confidence, importance, tags, relationships (related,
  about, part of, depends on, replaces), sensitivity and sensitive kinds,
  retention (session, long-term, until a date), layer, state (active or
  forgotten), number of corrections.

### Memory Policy (SAVE / DO_NOT_SAVE / ASK_USER)

Deterministic rules in Core, in English and Thai, each decision with its
reasons:

- **DO_NOT_SAVE:** passwords, API keys, tokens, private keys, URLs with
  credentials — always, even when asked; content already remembered;
  (when not asked for) too short or of low importance.
- **ASK_USER:** financial (card numbers checked with Luhn, bank accounts),
  health, biometric, identity numbers and documents, private details about
  someone else; (when not asked for) low confidence. The candidate waits in
  RAM only, at most 100, for 24 hours; only the person can answer.
- **SAVE:** everything else the person asked for.
- In chat, only "remember that…" / "จำไว้ว่า…" proposes a memory; nothing
  else a person types becomes one.
- Every decision (by the policy or the person) goes to an append-only log,
  without the content.

### Sensitive memories

Kept only when the person answers _Keep_, and then only sealed by the
operating system's secure storage (Electron `safeStorage`, through the host
operation `host.vault.seal`, Core only). No content or content key in the
database, never embedded, exported, logged or in an event; revealed only
when the person presses _Reveal_. Without secure storage it is not kept and
the candidate keeps waiting.

### What the person can do

- **View** memories by kind and tags, newest first, with source, confidence,
  importance and update time.
- **Search** by kind and tags, by keywords (English and Thai, substring),
  by relationship (_Related_), and by meaning (semantic, optional).
- **Correct** content, tags or kind (counted); a correction that would add a
  secret is refused, one that would make it sensitive must be added again.
- **Forget** (kept, never recalled or searched by default) and **restore**.
- **Delete** for good, with the HIGH `memory.delete` permission for that
  memory; no copy stays in the database files.
- **Export** to a JSON file (a SET 10 artifact), without sensitive content.

### Semantic search and privacy mode

Off by default (`memory.semanticSearch`, a switch on the Memory screen).
When on, the embedding model comes from the model router, so the routing
mode applies: under _Local only_ only a model on this computer can be used,
and the guarded transport refuses anything else again. When no model can be
used, the search uses keywords and says why. Sensitive memories are never
sent to a model; vectors are dropped when the content changes.

### Obsidian knowledge base

- **Connect** an existing vault (a folder with `.obsidian`) chosen in the
  system's folder dialog, or **create a Jupiter Brain** folder. The nine
  suggested subfolders (People, Projects, Ideas, Meetings, School, Tasks,
  Reference, Daily, Archive) are added only when the person presses _Add
  the suggested folders_, only those missing, after a manifest is written.
- **Search, list and read** notes (`notes.read` for the exact file or vault);
  note text is shown and passed on as untrusted data.
- **Create** a note: YAML frontmatter (title, created, source, tags with `jupiter` first), the
  text, and links to existing notes; each linked note gets a backlink under
  `## Backlinks` if it has none. Written to a temporary file and linked to a
  free name (`Title (2).md`): never overwritten. `notes.write` for each exact
  file, all asked before anything is written.
- **Append** a section and **link** two notes (Core and Mission steps).
- **Existing notes stay intact:** changed only if the file still has the
  hash Jupiter read (`NOTE_CHANGED`), after a copy is kept in
  `<data folder>\notes-backups\`; frontmatter, BOM, line endings and every
  existing line are kept; lines are only added.

### Missions

New step types: `memory.recall` (runner `memory`), `notes.search`,
`notes.read`, `notes.create` (runner `notes`). Recalled memories are fenced
`BEGIN/END MEMORY` (sensitive ones never recalled); note text is fenced
`BEGIN/END UNTRUSTED NOTE TEXT`.

### Interface

- **Memory** screen (was _Coming later_): status (counts, secure storage,
  the semantic search switch and the model it would use, or why none),
  tabs _Memories_, _Add_, _Waiting_, _Policy log_ and _Obsidian_.
- **Activity feed:** memory and notes events.
- **Languages:** English and Thai; the new error codes have summaries in
  both.
- A permission request that leads to another (a note and its backlink
  targets) is answered in turn; the action continues after each answer.
- The _Add_ form clears the text once Core has answered, so a refused key
  does not stay on screen.

## 2. Files added or changed

- **Contracts:** `packages/contracts/src/memory.ts`, `notes.ts` (new);
  `capabilities.ts` (`memory.*`, `notes.*`, the setting), `events.ts`
  (`memory.decided`, `memory.saved`, `memory.changed`, `notes.changed`),
  `permissions.ts` (`memory.delete`, `notes.read`, `notes.write`),
  `host-operations.ts` (`host.vault.*`, `host.notes.call`), `settings.ts`
  (`memory.semanticSearch`).
- **Core:** `packages/core/src/memory/` (new: `policy.ts`, `service.ts`,
  `digest.ts`, tests), `packages/core/src/notes/` (new: `agent.ts`,
  `markdown.ts`, tests); `kernel/core-kernel.ts`, `kernel/capabilities.ts`,
  `missions/manager.ts`, `workflow/catalogue.ts`, `workflow/validate.ts`,
  `ports.ts`.
- **Database:** migration 11 `0011_memory`, `repositories/memories.ts`,
  `jupiter-database.ts` (`secure_delete`),
  `test/memories.integration.test.ts`.
- **Host:** `apps/desktop/src/main/notes-host.ts`, `safe-path.ts` (new,
  shared with `file-host.ts`), `credential-vault.ts` (seal, unseal),
  `host-capabilities.ts`, `index.ts`.
- **Renderer:** `views/MemoryView.tsx`, `views/MemoryPanels.tsx`,
  `useMemory.ts`, `memoryText.ts` (new); `App.tsx`, `destinations.ts`,
  `FeatureViews.tsx`, `ActivityTimeline.tsx`, `errorText.ts`, `useFiles.ts`,
  `i18n/en.ts`, `i18n/th.ts`, `i18n/i18n.test.ts`, `styles.css`.
- **Testing:** `packages/testing/scripts/check-markdown.py`,
  `src/documents.ts` (`checkMarkdown`), `src/protocol-servers.ts`
  (`embedByWords`).
- **Tests:** `apps/desktop/test/memory-core.integration.test.ts`,
  `memory.integration.test.ts` (E2E), `core-harness.ts`; earlier suites
  updated (§12).
- **CI:** PyYAML with the Office parsers on the Linux and Windows jobs.
- **Docs:** ADR 0012, `ARCHITECTURE.md`, `SECURITY.md`, `README.md`,
  `AGENTS.md`, this report and `docs/sets/set-11/`.

## 3. Architecture decisions

[ADR 0012](../decisions/0012-memory-system-and-obsidian.md):

1. The policy is deterministic code in Core, not a model.
2. Session memory and waiting candidates stay in RAM; long-term in SQLite.
3. Sensitive memories are sealed by the OS, or not kept.
4. Semantic search goes through the router and obeys the privacy mode.
5. The person controls every memory; deletes erase remnants.
6. The vault is the one the person chose, reached only through the host.
7. Writing never harms an existing note (free names, hash check, backup,
   BOM and line endings kept).
8. Note text is untrusted data.

Rejected: a model deciding what to remember, encrypting the whole database,
a vector database, writing through Obsidian's plugin API.

## 4. Database migrations

Migration 11 `0011_memory` adds (all STRICT):

- `memories`: CHECKs on type, sensitivity, state, scores, JSON columns, the
  content key length, and "normal → content and no sealed form; sensitive →
  sealed form, no content, no content key"; indexes by time, content key
  and expiry.
- `memory_embeddings`: foreign key with cascade; a trigger refuses a vector
  for a sensitive memory.
- `memory_decisions`: triggers refuse UPDATE and DELETE.

`PRAGMA secure_delete = ON` is set when the database opens. It is appended
after migration 10; no shipped migration was edited. The database tests
cover the round trip after reopening, the sensitive-row constraints, stale
embeddings, erasing remnants, expiry and the append-only log.

## 5. Security implications

- Credentials never become memories, even on request; they are not in the
  database, logs or events (checked by scanning every file of the profile).
- Sensitive data is never silently kept: it waits in RAM for the person,
  and a kept one is only sealed by the OS.
- Deleting erases the content from the database files.
- Semantic search cannot send memories to the cloud under _Local only_, and
  never sends sensitive ones.
- The vault is only the folder the person chose; paths cannot leave it or
  follow links; notes are never overwritten or restructured without asking;
  a copy is kept before any change.
- Note text never becomes instructions: labelled and fenced.
- New actions are permission-checked: `memory.delete` (HIGH), `notes.read`
  and `notes.write` (MEDIUM) for the exact file.

`SECURITY.md` lists the new controls and their tests.

## 6. Commands actually run

```bash
npm ci
npx vitest run --project unit
npx vitest run --project integration packages/database/test
npx vitest run --project integration apps/desktop/test/memory-core.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/memory.integration.test.ts
npm run verify
```

## 7. Automated test results

### Local run

`npm run verify` on Linux (Node.js 22, Xvfb, a throwaway GNOME Keyring):
**13/13 steps PASS**, exit 0.

- unit tests: 28 files, 263 tests
- integration and Electron E2E: 42 files passed and 2 skipped; 318 tests
  passed and 16 skipped (the Windows-only SET 8 suites and the Windows
  installer check)
- packaged-app launch: 5 tests

The SET 11 suites:

| Suite                                                 | Tests | What it runs                                                                                                                              |
| ----------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/memory/policy.test.ts`             | 6     | The policy in English and Thai: credentials, sensitive kinds (Luhn, dates are not phone numbers), duplicates, explicit requests from chat |
| `packages/core/src/notes/markdown.test.ts`            | 5     | Frontmatter, links, backlinks added once with each line's ending kept, appending, Obsidian link resolution                                |
| `apps/desktop/test/memory-core.integration.test.ts`   | 12    | Real Core, SQLite and vault folders: AT1–AT10, search and relationships, a changed note refused, Mission steps                            |
| `apps/desktop/test/memory.integration.test.ts`        | 10    | The real Electron app: the Memory screen, AT1–AT10 through the interface, restart, Thai — with screenshots                                |
| `packages/database/test/memories.integration.test.ts` | 5     | Round trip after reopening, sensitive-row constraints, embeddings, erasing remnants, expiry, the append-only log                          |
| `apps/desktop/src/main/host-capabilities.test.ts`     | 13    | Includes sealing and unsealing through the host (Core only)                                                                               |

### Found and fixed during the SET

| Found                                                                                                                        | Fix                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Deleted memory text stayed readable in the database file and its WAL                                                         | `PRAGMA secure_delete = ON` and a WAL checkpoint after a delete or correction; tests scan the files            |
| New events were rejected (`EVENT_INVALID`): missing from the `DomainEvent` union                                             | Added as variants                                                                                              |
| Core could not import `node:crypto` (the renderer typecheck includes Core)                                                   | A plain TypeScript SHA-256, checked against Node's for six inputs                                              |
| E2E: creating a note with backlinks stopped after the first permission answer                                                | The interface keeps going through each request in turn; all permissions are checked before anything is written |
| E2E: the note list asked for `notes.read` again on every change                                                              | The list is read only when the person presses _Show recent notes_                                              |
| E2E review: a refused key stayed in the _Add_ form                                                                           | The form is cleared once Core answers; the E2E test checks it                                                  |
| Verify: Core's bundle gained `node:module` (a method named `require(` triggered electron-vite's CommonJS shim, as in SET 10) | Renamed; Core imports the same five Node modules as before                                                     |
| Verify: SET 7 tests picked grants by capability only and now also matched the Memory agent's default `memory.write` grant    | The tests select the fixture Skill's grant                                                                     |

### CI

Filled in from the pull request's green run.

Earlier run on this PR:

- **Run 36316889775** (`eb3554a`): Linux and Legacy green. Windows failed
  five SET 11 tests, for two reasons:
  - Windows handed the tests a short (8.3) temporary path
    (`C:\Users\RUNNER~1\…`), while the host records the vault's real long
    path (`runneradmin`). The permission target and the vault path shown
    were right, but the tests compared them with the short form. The tests
    now use the real path (`realpathSync.native`).
  - The E2E helper read the decision still shown from the previous request
    before the new answer arrived; the next two tests failed after it. The
    _Add_ tab now clears the previous decision when a new request starts
    and numbers each answer (`data-sequence`), and the helper waits for the
    next number.

## 8. Manual tests

The E2E suite drives the real app and saves screenshots, copied to
[docs/sets/set-11](set-11/). Each was reviewed by eye:

| File                             | Shows                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `01-memory-screen.png`           | Memory: counts, "Secure storage available", semantic search off and why none is available, the five tabs                                  |
| `02-at1-saved.png`               | Add: the policy's decision _Saved_ with its reason "You asked Jupiter to remember it"                                                     |
| `04-at3-do-not-save.png`         | Add: a key → _Not saved_, "Looks like a password, key or token — never kept"; the text box is empty again                                 |
| `05-at4-waiting-for-you.png`     | Waiting: a card number waits for the person, labelled "Financial information", with _Keep_ and _Don't keep_ and when it will be discarded |
| `06-at10-sealed.png`             | Memories: the kept card number is "Content hidden (sealed)" with _Reveal_; counts show 1 sensitive                                        |
| `09-at5-delete-confirm.png`      | Delete: "Delete this memory?" — erased for good, cannot be undone, _Forget_ offered instead                                               |
| `10-at5-delete-permission.png`   | The permission dialog: `memory.delete`, target `memory:<id>`, High, "cannot be undone", nothing leaves the computer                       |
| `13-at6-connected.png`           | Obsidian: the connected vault (name, location, kind) and its notes listed after the person asked                                          |
| `15-at7-created.png`             | New note: "Created Space/Great Red Spot.md." with the backlinks added in both linked notes                                                |
| `16-at9-local-only-no-cloud.png` | Local only with only a cloud embedding model: "Semantic search was not used: Local only mode is on… Nothing was sent", keyword results    |
| `17-at9-local-semantic.png`      | With a local embedding model: ranked by meaning with embed-model (Local embeddings, on this computer)                                     |
| `18-thai-policy-log.png`         | The Memory screen in Thai: the policy log with decisions, who decided and reasons, no content                                             |

## 9. Known limitations

- **Not built:** proposing memories from ordinary conversation without an
  explicit "remember that…", moving or deleting notes, editing a note's
  existing text, syncing a vault.
- **Semantic search** needs an embedding model the person has set up; the
  vectors are compared in Core (a cosine scan of at most 500 memories).
- **Sealing** needs OS-backed secure storage (DPAPI on Windows; a Secret
  Service on Linux). Without it, sensitive memories are not kept.
- **Waiting candidates** are lost if Core stops before the person answers
  (they are never written to disk, by design).
- **The folder dialog** cannot be driven in tests; they use
  `JUPITER_TEST_VAULT_FOLDER`, read only in the test environment.
- **Listing notes** asks for `notes.read` each time unless the person
  chooses _Always allow_ (the listing is shown only when asked for).

## 10. How to run

```bash
npm ci && npm run dev
```

1. Open _Memory › Add_, type something to remember and press _Remember this_.
   The decision and its reasons appear. Try a card number: it waits under
   _Waiting_.
2. _Memories_: search, _Correct_, _Forget_, _Related_, _Delete_, _Export
   memories_.
3. _Obsidian_: _Choose an Obsidian vault…_ (or _Create a Jupiter Brain
   folder…_), then _Show recent notes_, search, and create a note with links.

The in-process tests (PyYAML needed for the Markdown check):

```bash
python3 -m pip install PyYAML
npx vitest run --project integration apps/desktop/test/memory-core.integration.test.ts
```

## 11. Evidence and artifact paths

- `docs/sets/set-11/*.png`: the E2E screenshots (also written to
  `test-results/set-11/` on each run)
- CI: the pull request's run (see §7)

## 12. Acceptance tests

| #   | Test                                              | Status   | Evidence (`memory-core.integration.test.ts` unless noted)                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Save an allowed memory                            | **PASS** | SAVE with reason `explicit-request`; type, content, source, confidence, importance, tags, long-term, active; found by keyword; the decision logged without content; no permission asked (the visible default grants made by `core`). E2E: _Saved_ in the Add tab, listed as Long-term (screenshot 02)                                                                                                 |
| 2   | Retrieve it after restart                         | **PASS** | Core stopped and started on the same database: the long-term memory is identical; a session memory is gone (`MEMORY_NOT_FOUND`). E2E: the app closed and relaunched on the same profile; the memory is listed with its content (screenshot 03)                                                                                                                                                        |
| 3   | DO_NOT_SAVE is respected                          | **PASS** | An API key, an English and a Thai password → DO_NOT_SAVE (`credential`), no memory, no candidate; a duplicate → `duplicate`; trivia → `too-short`, `low-importance`; an ordinary chat turn makes no decision, "Remember that…" does. None of the secrets is in the database files, logs or events. E2E: a key → _Not saved_, the form cleared, the key in no file of the profile (screenshot 04)      |
| 4   | ASK_USER waits for a decision                     | **PASS** | Health data and a low-confidence note → ASK_USER; listed as candidates, not searchable, not on disk; the person declines one (`person-declined`) and keeps the other (`person-saved`, sealed, revealed only on request); an automation actor cannot answer. E2E: a card number waits under _Waiting_, nothing on disk; _Keep_ stores it sealed; _Don't keep_ leaves no trace (screenshot 05)          |
| 5   | User can correct and delete memory                | **PASS** | Correct (content and tags, `corrections: 1`, old text no longer found); a correction to a password → `MEMORY_REFUSED`; forget and restore; delete → `PERMISSION_REQUIRED`, `memory.delete` HIGH on `memory:<id>`, then deleted, `MEMORY_NOT_FOUND`, not in the database files, `memory.changed deleted`. E2E: Correct dialog, Forget, Delete with the HIGH dialog (screenshots 08–10)                 |
| 6   | Connect an approved Obsidian vault                | **PASS** | A folder without `.obsidian` → `NOT_A_VAULT`; no folder chosen → `VAULT_NOT_CHOSEN`; the chosen vault connects; an automation actor cannot connect; `../`, absolute and `.obsidian` paths refused; Jupiter Brain: its folder and, on request, the nine subfolders, nothing else touched. E2E: _Choose an Obsidian vault…_ connects the chosen folder; notes listed after `notes.read` (screenshot 13) |
| 7   | Create valid Markdown note with valid backlinks   | **PASS** | `notes.write` asked for the exact new path; the note parses with PyYAML (title, source, tags) and its links resolve; both linked notes get one backlink; a missing link target → `NOTE_LINK_TARGET_MISSING`. E2E: created through the form, checked by the independent reader, backlinks added (screenshot 15)                                                                                        |
| 8   | Existing notes remain intact after update         | **PASS** | The BOM + CRLF note keeps its frontmatter, BOM, CRLF and every original line (only the backlink line added); its original bytes are in the backup; appending keeps every byte before; linking again adds no duplicate; the same title again → `(2)`; a note changed on disk → `NOTE_CHANGED`, untouched. E2E: the same byte checks and backups; a second create → `Great Red Spot (2).md`             |
| 9   | LOCAL_ONLY semantic search makes no cloud call    | **PASS** | With only a cloud embedding model and Local only: `used: false`, keyword fallback with the reason, **0 connections** to the cloud server; with a local model: `used: true`, `this-device`, ranked by meaning, still 0 cloud connections; the sensitive memory never sent. E2E: the same with the real app and a non-loopback "cloud" server (screenshots 16, 17)                                      |
| 10  | Sensitive memory not silently persisted or logged | **PASS** | A card number waits (ASK_USER, `financial`) and is in no file, log or event; once kept it is sealed (no content in the database, logs, events, search or export) and revealed only to the person; without secure storage keeping it fails (`SECURE_STORAGE_UNAVAILABLE`) and nothing is stored. E2E: every file of the profile scanned before and after keeping (screenshot 06)                       |

### SET 0–10 re-check (on the SET 11 code)

All earlier suites pass in the same `npm run verify` run. They were updated
only where SET 11 changed facts:

- **SET 2 AT10 and the shell test:** Memory is no longer _Coming later_
  (three planned destinations, not four); the window-restore test still
  reopens on the Memory screen.
- **SET 1/2 app test:** the `memory` Core service is listed as running.
- **SET 5:** the step-type list includes `memory.recall` (available: it
  needs only the database) and the three `notes.*` types (unavailable where
  there is no vault host).
- **SET 10:** `withPermission` now continues through several permission
  requests in turn (a note and its backlink targets); the File Agent's
  single-file actions behave as before.
- **SET 1 gateway test:** unchanged; none of the new capabilities matches
  its file, credential or shell pattern.
