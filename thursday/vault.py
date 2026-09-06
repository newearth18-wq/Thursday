"""An Obsidian vault as Thursday's second brain.

Thursday already had notes. They lived in SQLite, which meant they were only
ever readable through Thursday - no graph, no backlinks, no editing them on
your own, nothing when Thursday is not running. A second brain that only one
program can open is not much of a brain.

An Obsidian vault is a folder of Markdown files with `[[wikilinks]]`, tags and
YAML frontmatter. That is the whole format. So Thursday reads it, writes into
it, and keeps finding connections between what is in it - and everything it
writes is a plain file you can open, edit, sync and keep long after Thursday
is gone.

The rule that shapes all of this: **the vault is yours, not Thursday's.**

- Notes Thursday writes on its own go in one folder (`Thursday/` by default),
  so they are obviously its and easy to delete en masse.
- Notes *you* wrote are never rewritten. Links are added inside a delimited
  block at the end of the file, rebuilt whole each time, so Thursday's edits
  can only ever touch text Thursday put there.
- Every write goes through the same journal as any other file change, so
  `/undo` puts a note back.
- Frontmatter is preserved byte for byte where it can be. Losing someone's
  `tags:` because a parser was clever is not a trade worth making.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger(__name__)

#: Where Thursday's own notes go, so they are obviously its.
OWN_FOLDER = "Thursday"

#: The block Thursday maintains at the end of a note. Rebuilt whole every
#: time, so an edit can only ever replace text Thursday itself wrote. The
#: markers are HTML comments, which Obsidian renders as nothing.
BEGIN = "<!-- thursday:links -->"
END = "<!-- /thursday:links -->"
MANAGED = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.DOTALL)

#: Obsidian's own file extension. A vault can hold anything, but only these
#: are notes.
NOTE_SUFFIX = ".md"

#: Folders a vault keeps for itself.
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules", ".stfolder"}

#: [[link]], [[link|shown as this]], [[note#heading]]
WIKILINK = re.compile(r"\[\[([^\]\[|#]+)(?:#[^\]\[|]*)?(?:\|([^\]\[]*))?\]\]")

#: #tag, but not a Markdown heading and not a colour like #fff inside code.
TAG = re.compile(r"(?:^|(?<=\s))#([A-Za-z฀-๿][\w฀-๿/-]*)")

FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)

#: tags in frontmatter, both shapes Obsidian accepts:
#:     tags: [work, budget]        tags:
#:                                   - work
_FM_TAGS_INLINE = re.compile(r"^tags?\s*:\s*\[(.*?)\]", re.MULTILINE)
_FM_TAGS_BLOCK = re.compile(r"^tags?\s*:\s*$((?:\r?\n[ \t]*-[ \t]*\S.*)+)", re.MULTILINE)
_FM_TAGS_ONE = re.compile(r"^tags?\s*:[ \t]*([^\[\r\n][^\r\n]*)$", re.MULTILINE)


def frontmatter_tags(raw: str) -> list[str]:
    """Tags declared in YAML frontmatter.

    Parsed rather than pulled in with a YAML library, because the library
    would be a dependency for one field - and because a vault is full of
    frontmatter that no strict parser will accept, which must not stop the
    note being read at all.
    """
    found: list[str] = []
    inline = _FM_TAGS_INLINE.search(raw)
    if inline:
        found += [part.strip().strip("\"'") for part in inline.group(1).split(",")]
    block = _FM_TAGS_BLOCK.search(raw)
    if block:
        found += [
            line.strip().lstrip("-").strip().strip("\"'")
            for line in block.group(1).splitlines()
            if line.strip()
        ]
    if not found:
        single = _FM_TAGS_ONE.search(raw)
        if single:
            found += [part.strip().strip("\"'") for part in re.split(r"[,\s]+", single.group(1))]
    return [tag.lstrip("#") for tag in found if tag and tag.strip()]


class VaultError(Exception):
    """Something about the vault or the note is wrong."""


def slug(title: str) -> str:
    """A filename for a note title.

    Only characters a filesystem objects to are removed. Thai, Japanese and
    accented Latin all stay readable, because a vault full of `r-w-wgan.md`
    is not a second brain anyone will keep using.
    """
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return (cleaned or "note")[:120]


def normalise(name: str) -> str:
    """One key for a note however its name was typed or composed.

    NFC first: Obsidian on macOS writes decomposed filenames, so the same note
    reached from two machines would otherwise be two notes.
    """
    return unicodedata.normalize("NFC", name).strip().lower()


@dataclass
class Note:
    """One Markdown file in the vault."""

    path: Path
    title: str
    body: str = ""
    frontmatter: str = ""
    links: tuple[str, ...] = field(default_factory=tuple)
    tags: tuple[str, ...] = field(default_factory=tuple)
    #: Links inside Thursday's own block. Kept apart from `links` so a
    #: suggestion is never mistaken for something the person wrote - but they
    #: still count as "already said", so running the connector again finds
    #: what is genuinely new rather than repeating itself.
    suggested: tuple[str, ...] = field(default_factory=tuple)

    @property
    def key(self) -> str:
        return normalise(self.title)

    @property
    def text(self) -> str:
        """The body with Thursday's own block removed.

        Everything that reads a note for meaning - search, embedding, link
        suggestion - uses this, so Thursday never rediscovers its own
        suggestions and links notes to each other in a loop.
        """
        return MANAGED.sub("", self.body).strip()

    def as_dict(self, full: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "title": self.title,
            "path": str(self.path),
            "links": list(self.links),
            "tags": list(self.tags),
        }
        if full:
            payload["text"] = self.text
        return payload


def parse(path: Path, raw: str) -> Note:
    """Read one note. Never raises on odd content - a vault is full of it."""
    frontmatter = ""
    body = raw
    match = FRONTMATTER.match(raw)
    if match:
        frontmatter = match.group(0)
        body = raw[match.end():]

    # Links and tags come from the person's text only, never from Thursday's
    # own block - or every suggestion would immediately look like a real link.
    people_wrote = MANAGED.sub("", body)
    links = tuple(
        dict.fromkeys(
            normalise(m.group(1)) for m in WIKILINK.finditer(people_wrote) if m.group(1).strip()
        )
    )
    # Both places Obsidian keeps them: inline #tags in the text, and the
    # frontmatter field, which is what most people actually use.
    tags = tuple(
        dict.fromkeys(
            [*(m.group(1) for m in TAG.finditer(people_wrote)), *frontmatter_tags(frontmatter)]
        )
    )
    block = MANAGED.search(body)
    suggested = tuple(
        dict.fromkeys(
            normalise(m.group(1)) for m in WIKILINK.finditer(block.group(0) if block else "")
        )
    )
    return Note(
        path=path,
        title=path.stem,
        body=body,
        frontmatter=frontmatter,
        links=links,
        tags=tags,
        suggested=suggested,
    )


#: One line of Thursday's block: `- [[Title]] — why`
_ENTRY = re.compile(r"^-\s*\[\[([^\]\[|#]+)(?:[^\]\[]*)?\]\]\s*(?:—\s*(.*))?$", re.MULTILINE)


def block_entries(body: str) -> list[tuple[str, str]]:
    """What Thursday has already suggested on this note, with its reasons.

    Read back rather than only remembered, so adding a connection next month
    keeps the ones found last month instead of replacing them.
    """
    block = MANAGED.search(body)
    if not block:
        return []
    return [
        (match.group(1).strip(), (match.group(2) or "").strip())
        for match in _ENTRY.finditer(block.group(0))
        if match.group(1).strip()
    ]


def render_links(entries: Iterable[tuple[str, str]]) -> str:
    """Thursday's block: a link and why it is there.

    The reason matters. A bare list of links is noise you learn to skip; "same
    supplier as" is something you read.
    """
    lines = [BEGIN, "", "### Related", ""]
    for title, why in entries:
        lines.append(f"- [[{title}]]{f' — {why}' if why else ''}")
    lines += ["", END]
    return "\n".join(lines)


def with_links(body: str, block: str) -> str:
    """Put the block into a note, replacing any block already there.

    Idempotent on purpose: running this a hundred times leaves one block, so a
    note does not grow a new "Related" section every time Thursday thinks
    about it.
    """
    if MANAGED.search(body):
        return MANAGED.sub(lambda _: block, body, count=1)
    return body.rstrip() + "\n\n" + block + "\n"


class Vault:
    """An Obsidian vault, read and written as files."""

    def __init__(self, root: Path | str, journal: Any = None) -> None:
        self.root = Path(root).expanduser()
        #: The change journal, so a note Thursday edits can be put back.
        self.journal = journal

    # -------------------------------------------------------------- reading

    def check(self) -> None:
        if not self.root.is_dir():
            raise VaultError(
                f"{self.root} is not a folder. Set THURSDAY_VAULT to your Obsidian "
                "vault - the folder that contains the .obsidian directory."
            )

    @property
    def configured(self) -> bool:
        return self.root.is_dir()

    def paths(self) -> list[Path]:
        self.check()
        found = []
        for path in sorted(self.root.rglob(f"*{NOTE_SUFFIX}")):
            if any(part in SKIP_DIRS for part in path.relative_to(self.root).parts):
                continue
            if path.is_file():
                found.append(path)
        return found

    def read(self, path: Path) -> Note:
        try:
            return parse(path, path.read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            raise VaultError(f"could not read {path}: {exc}") from exc

    def notes(self) -> list[Note]:
        return [self.read(path) for path in self.paths()]

    def find(self, title: str) -> Note | None:
        """A note by its title, however it was typed."""
        wanted = normalise(title)
        for path in self.paths():
            if normalise(path.stem) == wanted:
                return self.read(path)
        return None

    def search(self, query: str, limit: int = 10) -> list[Note]:
        """Plain text matching over titles, tags and bodies.

        Deliberately not the embedding search - that lives in `documents.py`
        and works on the indexed vault. This is the one that answers "the note
        I called X" without needing a model.
        """
        wanted = query.strip().lower()
        if not wanted:
            return []
        hits = []
        for note in self.notes():
            haystack = f"{note.title}\n{' '.join(note.tags)}\n{note.text}".lower()
            if wanted in haystack:
                # Title matches first: asking for "budget" usually means the
                # note called budget, not the forty that mention it.
                hits.append((0 if wanted in note.title.lower() else 1, note))
        hits.sort(key=lambda pair: pair[0])
        return [note for _, note in hits[:limit]]

    # ---------------------------------------------------------- the graph

    def graph(self) -> dict[str, set[str]]:
        """Who links to whom, by normalised title.

        Both directions, because Obsidian's backlink pane is most of why the
        graph is useful and a one-way index cannot answer "what points here".
        """
        edges: dict[str, set[str]] = {}
        for note in self.notes():
            edges.setdefault(note.key, set())
            for target in note.links:
                edges[note.key].add(target)
                edges.setdefault(target, set()).add(note.key)
        return edges

    def neighbours(self, title: str, depth: int = 1) -> list[str]:
        """What this note connects to, out to `depth` steps."""
        edges = self.graph()
        start = normalise(title)
        if start not in edges:
            return []
        seen = {start}
        frontier = {start}
        for _ in range(max(1, depth)):
            frontier = {n for node in frontier for n in edges.get(node, set())} - seen
            if not frontier:
                break
            seen |= frontier
        return sorted(seen - {start})

    def orphans(self) -> list[str]:
        """Notes nothing links to and which link to nothing.

        The pile a vault accumulates: things written once and never connected
        to anything, which is exactly what a second brain is meant to prevent.
        """
        edges = self.graph()
        return sorted(
            note.title for note in self.notes() if not edges.get(note.key)
        )

    # -------------------------------------------------------------- writing

    def path_for(self, title: str, folder: str = OWN_FOLDER) -> Path:
        return self.root / folder / f"{slug(title)}{NOTE_SUFFIX}"

    def write(
        self, title: str, text: str, tags: Iterable[str] = (),
        folder: str = OWN_FOLDER, append: bool = False,
    ) -> Path:
        """Write one of Thursday's own notes.

        Its own folder, so what Thursday wrote is obvious at a glance and can
        be deleted in one go by someone who decides they would rather it did
        not.
        """
        self.check()
        path = self.path_for(title, folder)
        path.parent.mkdir(parents=True, exist_ok=True)

        if append and path.is_file():
            existing = self.read(path)
            # Appended text goes above Thursday's link block, or the block
            # would drift into the middle of the note.
            block = MANAGED.search(existing.body)
            kept = existing.body
            if block:
                kept = existing.body[: block.start()].rstrip()
                body = f"{kept}\n\n{text.strip()}\n\n{block.group(0)}\n"
            else:
                body = f"{kept.rstrip()}\n\n{text.strip()}\n"
            self._save(path, existing.frontmatter + body)
            return path

        front = self._frontmatter(tags)
        self._save(path, f"{front}{text.strip()}\n")
        return path

    def link(
        self, title: str, entries: list[tuple[str, str]], replace: bool = False
    ) -> Path:
        """Add to the Related block on a note.

        Added to rather than replaced, because a connection found last month
        is not less true this month. `replace=True` is how the block is
        cleared or rewritten wholesale.
        """
        note = self.find(title)
        if note is None:
            raise VaultError(f"there is no note called {title!r}")

        merged: list[tuple[str, str]] = [] if replace else block_entries(note.body)
        seen = {normalise(entry[0]) for entry in merged}
        for target, why in entries:
            if normalise(target) in seen:
                continue
            seen.add(normalise(target))
            merged.append((target, why))

        body = (
            with_links(note.body, render_links(merged))
            if merged
            else MANAGED.sub("", note.body).rstrip() + "\n"
        )
        self._save(note.path, note.frontmatter + body)
        return note.path

    def _frontmatter(self, tags: Iterable[str]) -> str:
        listed = [tag.lstrip("#") for tag in tags if str(tag).strip()]
        lines = ["---", f"created: {date.today().isoformat()}", "source: thursday"]
        if listed:
            lines.append("tags:")
            lines.extend(f"  - {tag}" for tag in listed)
        lines += ["---", ""]
        return "\n".join(lines)

    def _save(self, path: Path, content: str) -> None:
        """Write a note, keeping a copy of whatever was there.

        Through the same journal as every other file change, so a note
        Thursday edited is put back by the same /undo as anything else.
        """
        if self.journal is not None:
            try:
                self.journal.before(path, "write" if path.exists() else "create")
            except Exception:  # pragma: no cover - a journal must not block a write
                log.exception("could not journal the change to %s", path)
        try:
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            raise VaultError(f"could not write {path}: {exc}") from exc

    # --------------------------------------------------------- daily notes

    def daily(self, folder: str = "", when: date | None = None) -> Path:
        """Today's daily note, made if it is not there.

        The name is the ISO date, which is Obsidian's own default and the one
        setting most people never change.
        """
        self.check()
        day = (when or date.today()).isoformat()
        existing = self.find(day)
        if existing is not None:
            return existing.path
        path = self.root / folder / f"{day}{NOTE_SUFFIX}" if folder else self.root / f"{day}{NOTE_SUFFIX}"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._save(path, f"# {day}\n\n")
        return path

    def add_to_daily(self, text: str, folder: str = "") -> Path:
        path = self.daily(folder)
        note = self.read(path)
        stamped = f"- {text.strip()}"
        block = MANAGED.search(note.body)
        if block:
            head = note.body[: block.start()].rstrip()
            body = f"{head}\n{stamped}\n\n{block.group(0)}\n"
        else:
            body = f"{note.body.rstrip()}\n{stamped}\n"
        self._save(path, note.frontmatter + body)
        return path

    # ------------------------------------------------------------- summary

    def describe(self) -> dict[str, Any]:
        if not self.configured:
            return {"configured": False, "root": str(self.root)}
        notes = self.notes()
        edges = self.graph()
        linked = sum(1 for note in notes if edges.get(note.key))
        return {
            "configured": True,
            "root": str(self.root),
            "notes": len(notes),
            "links": sum(len(note.links) for note in notes),
            "connected": linked,
            "orphans": len(notes) - linked,
            "tags": len({tag for note in notes for tag in note.tags}),
        }
