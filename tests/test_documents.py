"""Reading your documents, and finding the passage you meant."""

from __future__ import annotations

import pytest

from tests.fake_embeddings import BagOfWords, FakeEmbeddingServer, bag_of_words
from thursday.config import Settings
from thursday.documents import Library, Unreadable, chunk, extract, fingerprint
from thursday.embeddings import (
    Embedder,
    EmbeddingUnavailable,
    normalise,
    pack,
    rank,
    similarity,
    unpack,
)
from thursday.memory import Memory
from thursday.tools import ToolContext, ToolError, build_registry

CONTRACT = "\n\n".join(
    [
        ("Either party may terminate this agreement by giving thirty days written "
         "notice to the other party. ") * 10,
        ("Payment of every invoice is due within fourteen days of receipt, by bank "
         "transfer only. ") * 10,
        ("Confidential information disclosed under this agreement must not be shared "
         "with any third party. ") * 10,
    ]
)


# ------------------------------------------------------------------ maths


def test_vectors_round_trip_through_storage():
    original = normalise([1.0, 2.0, 3.0])
    assert unpack(pack(original)) == pytest.approx(original, abs=1e-6)


def test_similarity_and_ranking():
    assert similarity([1, 0], [1, 0]) == pytest.approx(1.0)
    assert similarity([1, 0], [0, 1]) == pytest.approx(0.0)
    assert similarity([1, 0], [1, 0, 0]) == 0.0     # mismatched, not a crash

    best = rank([1, 0], [("far", [0, 1]), ("near", [0.9, 0.1])], limit=1)
    assert best[0][0] == "near"


def test_normalising_a_zero_vector_is_safe():
    assert normalise([0.0, 0.0]) == [0.0, 0.0]


# --------------------------------------------------------------- chunking


def test_short_text_is_one_chunk():
    assert chunk("a short note") == ["a short note"]


def test_long_text_is_split_with_overlap():
    pieces = chunk("word " * 2000, size=500, overlap=100)

    assert len(pieces) > 1
    assert all(len(piece) <= 520 for piece in pieces)
    # Overlap means the total is longer than the original, not shorter.
    assert sum(len(piece) for piece in pieces) > 2000


def test_chunking_prefers_paragraph_breaks():
    text = ("A" * 600) + "\n\n" + ("B" * 600)
    pieces = chunk(text, size=700, overlap=0)

    assert pieces[0].endswith("A")     # it cut at the blank line
    assert pieces[1].startswith("B")


def test_empty_text_produces_nothing():
    assert chunk("   \n\n  ") == []


# ------------------------------------------------------------- extraction


def test_text_files_are_read(tmp_path):
    (tmp_path / "notes.md").write_text("# Title\n\nSome notes.", encoding="utf-8")
    assert "Some notes" in extract(tmp_path / "notes.md")


def test_an_unreadable_type_says_so(tmp_path):
    target = tmp_path / "photo.heic"
    target.write_bytes(b"\x00\x01")
    with pytest.raises(Unreadable, match="not something I can read"):
        extract(target)


def test_a_huge_file_is_refused(tmp_path, monkeypatch):
    import thursday.documents as documents

    monkeypatch.setattr(documents, "MAX_FILE_BYTES", 10)
    target = tmp_path / "big.txt"
    target.write_text("x" * 100, encoding="utf-8")

    with pytest.raises(Unreadable, match="too large"):
        documents.extract(target)


def test_the_fingerprint_changes_when_the_file_does(tmp_path):
    target = tmp_path / "notes.txt"
    target.write_text("one", encoding="utf-8")
    before = fingerprint(target)

    target.write_text("one and then some more text", encoding="utf-8")
    assert fingerprint(target) != before


# ---------------------------------------------------------------- library


@pytest.fixture()
def contract(tmp_path):
    path = tmp_path / "contract.md"
    path.write_text(CONTRACT, encoding="utf-8")
    return path


@pytest.fixture()
def library():
    return Library(Memory(":memory:"), embedder=BagOfWords())


def test_indexing_a_document(library, contract):
    result = library.index(contract)

    assert result["status"] == "indexed"
    assert result["chunks"] > 1
    assert result["semantic"] is True


def test_an_unchanged_file_is_not_re_indexed(library, contract):
    library.index(contract)
    assert library.index(contract)["status"] == "unchanged"


def test_a_changed_file_is_re_indexed(library, contract):
    library.index(contract)
    contract.write_text(CONTRACT + "\n\nAn extra clause about delivery.", encoding="utf-8")

    assert library.index(contract)["status"] == "indexed"
    assert len(library.documents()) == 1      # replaced, not duplicated


def test_search_finds_the_right_passage(library, contract):
    """The test embedder is lexical, so this checks the plumbing, not synonymy."""
    library.index(contract)

    hits = library.search("how do I terminate the agreement", limit=1)
    assert hits and "terminate" in hits[0].text

    hits = library.search("when is payment due by transfer", limit=1)
    assert hits and "Payment" in hits[0].text


def test_search_over_an_empty_library_is_not_an_error(library):
    assert library.search("anything") == []
    assert library.search("   ") == []


def test_indexing_a_folder(library, tmp_path, contract):
    (tmp_path / "notes.txt").write_text("Buy oat milk.", encoding="utf-8")
    (tmp_path / "photo.heic").write_bytes(b"\x00")      # not readable, skipped

    result = library.index_tree(tmp_path)

    assert len(result["indexed"]) == 2
    assert all("heic" not in entry["path"] for entry in result["indexed"])


def test_forgetting_a_document(library, contract):
    library.index(contract)

    assert library.forget(str(contract)) is True
    assert library.documents() == []
    assert library.forget(str(contract)) is False


# ------------------------------------------------------- without a model


def test_indexing_still_works_with_no_embedding_model(contract):
    """The text should stay findable even when nothing can embed it."""
    unreachable = Embedder(name="ollama", base_url="http://127.0.0.1:9/v1")
    library = Library(Memory(":memory:"), embedder=unreachable)

    result = library.index(contract)
    assert result["status"] == "indexed"
    assert result["semantic"] is False
    assert library.documents()[0]["searchable_by_meaning"] is False


def test_search_falls_back_to_keywords(contract):
    unreachable = Embedder(name="ollama", base_url="http://127.0.0.1:9/v1")
    library = Library(Memory(":memory:"), embedder=unreachable)
    library.index(contract)

    hits = library.search("terminate notice")
    assert hits and "terminate" in hits[0].text


def test_the_keyword_fallback_matches_words_not_the_whole_phrase(contract):
    """Matching the phrase verbatim would find almost nothing."""
    unreachable = Embedder(name="ollama", base_url="http://127.0.0.1:9/v1")
    library = Library(Memory(":memory:"), embedder=unreachable)
    library.index(contract)

    assert library.search("how do I terminate this thing")


def test_an_unreachable_model_explains_itself():
    embedder = Embedder(name="ollama", base_url="http://127.0.0.1:9/v1")
    ok, why = embedder.available()

    assert ok is False
    assert "ollama pull" in why       # the preset's own hint


# --------------------------------------------------------- over a socket


def test_embedding_over_http():
    with FakeEmbeddingServer() as server:
        embedder = Embedder(name="ollama", base_url=server.base_url, model="fake")
        assert embedder.available() == (True, "")

        vectors = embedder.embed(["hello there", "goodbye"])
        assert len(vectors) == 2
        assert len(vectors[0]) == len(bag_of_words("x"))
        # Normalised on the way in, so ranking is a dot product later.
        assert sum(value * value for value in vectors[0]) == pytest.approx(1.0, abs=1e-6)

    assert server.requests[0]["model"] == "fake"


def test_a_model_that_errors_is_reported_not_hidden():
    with FakeEmbeddingServer(fail=True) as server:
        embedder = Embedder(name="ollama", base_url=server.base_url)
        with pytest.raises(EmbeddingUnavailable, match="503"):
            embedder.embed_one("anything")


def test_indexing_through_a_real_endpoint(contract):
    with FakeEmbeddingServer() as server:
        embedder = Embedder(name="ollama", base_url=server.base_url, model="fake")
        library = Library(Memory(":memory:"), embedder=embedder)

        assert library.index(contract)["semantic"] is True
        assert library.search("terminate", limit=1)


def test_the_default_embedder_is_local(monkeypatch):
    monkeypatch.delenv("THURSDAY_EMBED_PROVIDER", raising=False)
    embedder = Embedder.from_env()

    assert embedder.local is True
    assert "localhost" in embedder.base_url


# ------------------------------------------------------------------ tools


@pytest.fixture()
def context(tmp_path):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path, plugin_dirs=())
    context = ToolContext(settings=settings, memory=Memory(":memory:"))
    context.state["library"] = Library(context.memory, embedder=BagOfWords())
    return context


def call(registry, name, arguments, context):
    import asyncio

    return asyncio.run(registry.call(name, arguments, context))


def test_the_tools_index_and_search(context, tmp_path):
    (tmp_path / "contract.md").write_text(CONTRACT, encoding="utf-8")
    registry = build_registry(context.settings)

    indexed = call(registry, "index_documents", {"path": "contract.md"}, context)
    assert '"indexed"' in indexed

    found = call(registry, "search_documents", {"query": "terminate the agreement"}, context)
    assert "terminate" in found
    assert "contract.md" in call(registry, "list_documents", {}, context)


def test_indexing_cannot_leave_the_workspace(context):
    registry = build_registry(context.settings)
    with pytest.raises(ToolError, match="outside the workspace"):
        call(registry, "index_documents", {"path": "/etc"}, context)
