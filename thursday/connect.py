"""Finding connections between notes that nobody has drawn yet.

A vault does not become a second brain by holding notes. It becomes one when
the notes point at each other - which is the part people stop doing, because
remembering what you wrote eight months ago is exactly the thing you wanted
the vault for.

So this looks for connections and says why it thinks so. Three kinds of
evidence, in the order they are trusted:

1. **A shared tag.** You said these belong together; nothing here is guessing.
2. **A note both mention.** Two notes that both link to the same third thing
   are usually about the same corner of your life.
3. **Close in meaning.** From the same local embeddings the document search
   uses. The weakest evidence, and the one that says a number out loud.

The reason is not decoration. A bare list of related notes is noise you learn
to scroll past; "both tagged #tax" is something you actually read, and it
lets you see when the suggestion is wrong.

Suggesting and writing are separate. `suggest` reads and returns proposals;
`apply` writes them. The default is to suggest - editing someone's notes
without being asked is not a thing to do by accident, and even when writing,
only the block Thursday itself put there is ever replaced.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

from .vault import Note, Vault, normalise

log = logging.getLogger(__name__)

#: Below this, "close in meaning" is not evidence of anything. Set from
#: watching it work on real vaults: 0.6 pairs things that share a topic, 0.5
#: pairs anything written by the same person in the same month.
MEANING_FLOOR = 0.62

#: How many links to put on one note. A Related block longer than this stops
#: being a suggestion and becomes a wall.
MAX_PER_NOTE = 5

#: Below this a note is a stub, and a stub is "close in meaning" to
#: everything. Applies to the similarity check only: a two-line note that
#: shares a tag with another is a perfectly good connection, and a character
#: count is a poor measure of content in Thai or Japanese anyway.
MIN_CHARS = 80


@dataclass
class Connection:
    """One suggested link, and the evidence for it."""

    source: str
    target: str
    reason: str
    strength: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "from": self.source,
            "to": self.target,
            "why": self.reason,
            "strength": round(self.strength, 3),
        }


def cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    size = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return dot / size if size else 0.0


class Connector:
    """Looks for links worth drawing, and can draw them."""

    def __init__(self, vault: Vault, embedder: Any = None) -> None:
        self.vault = vault
        self.embedder = embedder
        #: Set after a run, so callers can say which kind of evidence was used
        #: rather than implying the model was consulted when it was not.
        self.used_meaning = False

    # ----------------------------------------------------------- suggesting

    def suggest(self, limit_per_note: int = MAX_PER_NOTE) -> list[Connection]:
        """Connections that are not already there."""
        notes = [note for note in self.vault.notes() if note.text]
        if len(notes) < 2:
            return []

        vectors = self._vectors(notes)
        existing = self._already_said(notes)

        found: dict[str, list[Connection]] = {}
        for index, note in enumerate(notes):
            candidates: list[Connection] = []
            for other_index, other in enumerate(notes):
                if other_index == index or other.key == note.key:
                    continue
                if other.key in existing.get(note.key, set()):
                    continue      # they already point at each other
                reason, strength = self._evidence(
                    note, other,
                    vectors[index] if vectors else None,
                    vectors[other_index] if vectors else None,
                )
                if reason:
                    candidates.append(Connection(note.title, other.title, reason, strength))

            candidates.sort(key=lambda c: c.strength, reverse=True)
            if candidates:
                found[note.key] = candidates[: max(1, limit_per_note)]

        # Deduplicated across the pair: A-to-B and B-to-A are one connection,
        # and writing both would put the same suggestion on two notes.
        seen: set[tuple[str, str]] = set()
        flat: list[Connection] = []
        for entries in found.values():
            for connection in entries:
                pair = tuple(sorted((normalise(connection.source), normalise(connection.target))))
                if pair in seen:
                    continue
                seen.add(pair)
                flat.append(connection)
        flat.sort(key=lambda c: c.strength, reverse=True)
        return flat

    def _evidence(
        self, note: Note, other: Note, vector: Any, other_vector: Any
    ) -> tuple[str, float]:
        """Why these two belong together, and how strongly."""
        shared_tags = set(note.tags) & set(other.tags)
        if shared_tags:
            tag = sorted(shared_tags)[0]
            # Strongest, because it is not a guess: a person filed both here.
            return f"both tagged #{tag}", 0.95 + 0.01 * len(shared_tags)

        shared_links = set(note.links) & set(other.links)
        if shared_links:
            target = sorted(shared_links)[0]
            return f"both mention [[{target}]]", 0.85 + 0.01 * len(shared_links)

        # Only meaning has the stub problem, so only meaning has the floor.
        if (
            vector is not None and other_vector is not None
            and len(note.text) >= MIN_CHARS and len(other.text) >= MIN_CHARS
        ):
            score = cosine(vector, other_vector)
            if score >= MEANING_FLOOR:
                return f"close in meaning ({score:.2f})", score
        return "", 0.0

    def _already_said(self, notes: list[Note]) -> dict[str, set[str]]:
        """Pairs there is nothing new to say about, either way round.

        Both what the person wrote and what Thursday already suggested. The
        second is what makes running this again useful: it finds what has
        turned up since, rather than handing back the same list for ever.
        """
        edges: dict[str, set[str]] = {note.key: set() for note in notes}
        for note in notes:
            for target in (*note.links, *note.suggested):
                edges.setdefault(note.key, set()).add(target)
                edges.setdefault(target, set()).add(note.key)
        return edges

    def _vectors(self, notes: list[Note]) -> list[list[float]] | None:
        """Embed every note, or give up and use the other evidence.

        Giving up is a normal outcome, not a failure: most people have no
        embedding model running, and shared tags and shared links are real
        connections without one.
        """
        if self.embedder is None:
            return None
        from .embeddings import EmbeddingUnavailable

        try:
            vectors = self.embedder.embed([note.text[:2000] for note in notes])
        except EmbeddingUnavailable as exc:
            log.info("connecting on tags and links only: %s", exc)
            return None
        except Exception as exc:  # pragma: no cover - a provider misbehaving
            log.warning("could not embed the vault: %s", exc)
            return None
        self.used_meaning = True
        return vectors

    # ------------------------------------------------------------- applying

    def apply(self, connections: list[Connection]) -> list[str]:
        """Write the suggestions into their notes.

        Grouped by source so each note is written once, and only its Related
        block changes. The block is added to, not replaced: a connection found
        last month is not less true this month.
        """
        grouped: dict[str, list[tuple[str, str]]] = {}
        for connection in connections:
            grouped.setdefault(connection.source, []).append(
                (connection.target, connection.reason)
            )

        written = []
        for title, entries in grouped.items():
            try:
                self.vault.link(title, entries)
            except Exception as exc:
                log.warning("could not link %s: %s", title, exc)
                continue
            written.append(title)
        return written

    # -------------------------------------------------------------- reading

    def related_to(self, title: str, limit: int = 6) -> list[Connection]:
        """What connects to one note, whether or not it has been written down."""
        note = self.vault.find(title)
        if note is None:
            return []
        others = [
            other for other in self.vault.notes() if other.key != note.key and other.text
        ]
        if not others:
            return []

        vectors = self._vectors([note, *others])
        mine = vectors[0] if vectors else None
        found = []
        for index, other in enumerate(others, start=1):
            reason, strength = self._evidence(
                note, other, mine, vectors[index] if vectors else None
            )
            # Something already linked is still related - it is just already
            # written down, and worth saying so rather than hiding it.
            if not reason and other.key in note.links:
                reason, strength = "already linked", 0.5
            if reason:
                found.append(Connection(note.title, other.title, reason, strength))
        found.sort(key=lambda c: c.strength, reverse=True)
        return found[:limit]
