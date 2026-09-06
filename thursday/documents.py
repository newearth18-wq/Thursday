"""Reading your documents, and finding things in them by meaning.

`search_files` is grep: it finds the word you typed. This finds the passage
you meant, which is what "what did that contract say about termination"
actually needs.

Text is split into overlapping chunks, embedded (locally by default) and kept
in the same SQLite file as everything else. When no embedding model is
available the search falls back to full-text matching over the same chunks -
worse, but honest, and it still works with the network unplugged.
"""

from __future__ import annotations

import hashlib
import logging
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .embeddings import Embedder, EmbeddingUnavailable, pack, rank, unpack

log = logging.getLogger(__name__)

#: Roughly a few paragraphs: big enough to answer from, small enough to rank.
CHUNK_CHARS = 1200
CHUNK_OVERLAP = 200
MAX_FILE_BYTES = 40_000_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    chunks      INTEGER NOT NULL DEFAULT 0,
    indexed_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    ordinal     INTEGER NOT NULL,
    text        TEXT NOT NULL,
    -- float32 vector, or NULL when it was indexed without a model.
    embedding   BLOB,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
"""

READABLE = {".txt", ".md", ".markdown", ".rst", ".csv", ".json", ".yaml", ".yml",
            ".py", ".js", ".ts", ".html", ".log", ".pdf", ".docx"}


# ------------------------------------------------------------- extraction


class Unreadable(RuntimeError):
    """The file cannot be turned into text."""


def extract(path: Path) -> str:
    """Pull plain text out of a document."""
    suffix = path.suffix.lower()
    if path.stat().st_size > MAX_FILE_BYTES:
        raise Unreadable(f"{path.name} is too large to index")

    if suffix == ".pdf":
        return _extract_pdf(path)
    if suffix == ".docx":
        return _extract_docx(path)
    if suffix in READABLE or suffix == "":
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise Unreadable(f"could not read {path.name}: {exc}") from exc
    raise Unreadable(f"{path.suffix or 'that file type'} is not something I can read yet")


def _extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise Unreadable(
            "reading PDFs needs pypdf: pip install 'thursday[documents]'"
        ) from exc
    reader = PdfReader(str(path))
    return "\n\n".join((page.extract_text() or "") for page in reader.pages)


def _extract_docx(path: Path) -> str:
    try:
        import docx
    except ImportError as exc:
        raise Unreadable(
            "reading Word files needs python-docx: pip install 'thursday[documents]'"
        ) from exc
    document = docx.Document(str(path))
    return "\n".join(paragraph.text for paragraph in document.paragraphs)


def chunk(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split on paragraph boundaries where possible, with a little overlap.

    The overlap matters: a sentence that straddles a boundary would otherwise
    be findable from neither side.
    """
    cleaned = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not cleaned:
        return []
    if len(cleaned) <= size:
        return [cleaned]

    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = min(start + size, len(cleaned))
        if end < len(cleaned):
            # Prefer a paragraph break, then a sentence, then any whitespace.
            for separator in ("\n\n", ". ", "\n", " "):
                cut = cleaned.rfind(separator, start + size // 2, end)
                if cut != -1:
                    end = cut + len(separator)
                    break
        piece = cleaned[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= len(cleaned):
            break
        start = max(start + 1, end - overlap)
    return chunks


def fingerprint(path: Path) -> str:
    """Cheap change detection: size and modification time."""
    stat = path.stat()
    return hashlib.sha256(f"{stat.st_size}:{int(stat.st_mtime)}".encode()).hexdigest()[:16]


# ------------------------------------------------------------------ store


@dataclass
class Hit:
    path: str
    title: str
    ordinal: int
    text: str
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "title": self.title,
            "passage": self.text,
            "score": round(self.score, 3),
        }


class Library:
    """Indexed documents, kept alongside everything else Thursday remembers."""

    def __init__(self, memory: Any, embedder: Embedder | None = None) -> None:
        self.memory = memory
        self.embedder = embedder or Embedder.from_env()
        with memory._lock:  # the schema lives in the same file as the rest
            memory._conn.executescript(SCHEMA)
            memory._conn.commit()

    # ------------------------------------------------------------ indexing

    def index(self, path: Path, force: bool = False) -> dict[str, Any]:
        """Index one file. Returns what happened."""
        text = extract(path)
        pieces = chunk(text)
        if not pieces:
            raise Unreadable(f"{path.name} has no text in it")

        mark = fingerprint(path)
        existing = self._document(str(path))
        if existing and existing["fingerprint"] == mark and not force:
            return {"path": str(path), "status": "unchanged", "chunks": existing["chunks"]}

        vectors: list[bytes | None] = [None] * len(pieces)
        embedded = False
        try:
            for start in range(0, len(pieces), 32):    # batch, to be kind to the model
                batch = pieces[start:start + 32]
                for offset, vector in enumerate(self.embedder.embed(batch)):
                    vectors[start + offset] = pack(vector)
            embedded = True
        except EmbeddingUnavailable as exc:
            # Indexing without vectors is still useful: the text is searchable.
            log.info("indexing %s without embeddings: %s", path.name, exc)

        self._replace(path, mark, pieces, vectors)
        return {
            "path": str(path),
            "status": "indexed",
            "chunks": len(pieces),
            "semantic": embedded,
        }

    def index_tree(self, root: Path, pattern: str = "*", limit: int = 200) -> dict[str, Any]:
        """Index every readable file under a directory."""
        done, skipped = [], []
        for candidate in sorted(root.rglob(pattern)):
            if len(done) >= limit:
                break
            if not candidate.is_file() or candidate.name.startswith("."):
                continue
            if candidate.suffix.lower() not in READABLE:
                continue
            try:
                done.append(self.index(candidate))
            except (Unreadable, OSError) as exc:
                skipped.append({"path": str(candidate), "why": str(exc)})
        return {"indexed": done, "skipped": skipped}

    def _replace(
        self, path: Path, mark: str, pieces: Sequence[str], vectors: Sequence[bytes | None]
    ) -> None:
        with self.memory._lock:
            connection = self.memory._conn
            connection.execute("DELETE FROM documents WHERE path=?", (str(path),))
            cursor = connection.execute(
                "INSERT INTO documents (path, title, fingerprint, chunks, indexed_at) "
                "VALUES (?,?,?,?,?)",
                (str(path), path.name, mark, len(pieces), time.time()),
            )
            document_id = cursor.lastrowid
            connection.executemany(
                "INSERT INTO chunks (document_id, ordinal, text, embedding) VALUES (?,?,?,?)",
                [
                    (document_id, ordinal, text, vector)
                    for ordinal, (text, vector) in enumerate(zip(pieces, vectors))
                ],
            )
            connection.commit()

    def forget(self, path: str) -> bool:
        with self.memory._lock:
            connection = self.memory._conn
            row = connection.execute("SELECT id FROM documents WHERE path=?", (path,)).fetchone()
            if row is None:
                return False
            connection.execute("DELETE FROM chunks WHERE document_id=?", (row["id"],))
            connection.execute("DELETE FROM documents WHERE id=?", (row["id"],))
            connection.commit()
            return True

    # ------------------------------------------------------------- reading

    def _document(self, path: str) -> sqlite3.Row | None:
        with self.memory._lock:
            return self.memory._conn.execute(
                "SELECT * FROM documents WHERE path=?", (path,)
            ).fetchone()

    def documents(self) -> list[dict[str, Any]]:
        with self.memory._lock:
            rows = self.memory._conn.execute(
                "SELECT d.*, SUM(c.embedding IS NOT NULL) AS vectors FROM documents d "
                "LEFT JOIN chunks c ON c.document_id = d.id GROUP BY d.id ORDER BY d.indexed_at DESC"
            ).fetchall()
        return [
            {
                "path": row["path"],
                "title": row["title"],
                "chunks": row["chunks"],
                "searchable_by_meaning": bool(row["vectors"]),
            }
            for row in rows
        ]

    def search(self, query: str, limit: int = 6) -> list[Hit]:
        """Passages that answer the question, by meaning where possible."""
        query = query.strip()
        if not query:
            return []

        try:
            vector = self.embedder.embed_one(query)
        except EmbeddingUnavailable as exc:
            log.info("falling back to keyword search: %s", exc)
            return self._keyword_search(query, limit)

        with self.memory._lock:
            rows = self.memory._conn.execute(
                "SELECT c.id, c.ordinal, c.text, c.embedding, d.path, d.title "
                "FROM chunks c JOIN documents d ON d.id = c.document_id "
                "WHERE c.embedding IS NOT NULL"
            ).fetchall()
        if not rows:
            return self._keyword_search(query, limit)

        by_id = {row["id"]: row for row in rows}
        ranked = rank(vector, [(row["id"], unpack(row["embedding"])) for row in rows], limit)
        return [
            Hit(
                path=by_id[key]["path"],
                title=by_id[key]["title"],
                ordinal=by_id[key]["ordinal"],
                text=by_id[key]["text"],
                score=score,
            )
            for key, score in ranked
            if score > 0.15   # below this it is noise, not a match
        ]

    def _keyword_search(self, query: str, limit: int) -> list[Hit]:
        """What we can still do with no embedding model: match the words.

        Matching the whole phrase would find almost nothing, so this scores
        passages by how many of the query's words they contain.
        """
        words = [word for word in re.findall(r"\w+", query.lower()) if len(word) > 2]
        if not words:
            words = [query.lower()]

        with self.memory._lock:
            rows = self.memory._conn.execute(
                "SELECT c.ordinal, c.text, d.path, d.title FROM chunks c "
                "JOIN documents d ON d.id = c.document_id"
            ).fetchall()

        scored: list[tuple[float, Any]] = []
        for row in rows:
            lowered = row["text"].lower()
            hits = sum(1 for word in words if word in lowered)
            if hits:
                scored.append((hits / len(words), row))
        scored.sort(key=lambda pair: pair[0], reverse=True)

        return [
            Hit(path=row["path"], title=row["title"], ordinal=row["ordinal"],
                text=row["text"], score=score)
            for score, row in scored[:limit]
        ]
