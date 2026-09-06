"""An Obsidian vault as a second brain.

The vault is the user's, not Thursday's, so most of these are about what it
must not do to their files.
"""

from __future__ import annotations

import asyncio
from datetime import date

import pytest

from thursday.config import Settings
from thursday.connect import MEANING_FLOOR, Connection, Connector, cosine
from thursday.memory import Memory
from thursday.tools import ToolContext, ToolError, build_registry
from thursday.undo import Journal
from thursday.vault import (
    BEGIN,
    END,
    Vault,
    VaultError,
    block_entries,
    frontmatter_tags,
    normalise,
    parse,
    slug,
)


NOTES = {
    "งบประมาณ 2027": "---\ntags:\n  - work\n---\n\nวางแผนงบปีหน้า คุยกับ [[ทีมบัญชี]] แล้ว\n",
    "ค่าใช้จ่ายไอที": "---\ntags: [work, it]\n---\n\nค่าเซิร์ฟเวอร์ ค่าไลเซนส์ เดือนละสามหมื่น\n",
    "ทีมบัญชี": "คนที่ดูแลงบ ติดต่อคุณสมชาย\n",
    "ประชุมซัพพลายเออร์": "คุยกับ [[ทีมบัญชี]] เรื่องเงื่อนไขการจ่าย\n",
    "แกงเขียวหวาน": "พริกแกง กะทิ มะเขือ #cooking\n",
}


@pytest.fixture()
def vault(tmp_path):
    root = tmp_path / "MyVault"
    (root / ".obsidian").mkdir(parents=True)
    (root / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
    for title, body in NOTES.items():
        (root / f"{title}.md").write_text(body, encoding="utf-8")
    return Vault(root)


@pytest.fixture()
def context(tmp_path, vault, monkeypatch):
    monkeypatch.setenv("THURSDAY_VAULT", str(vault.root))
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    async def approve(title, detail):
        return True

    context.confirm = approve
    return context


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


# ------------------------------------------------------------------ reading


def test_a_note_gives_up_its_links_and_tags(vault):
    note = vault.find("งบประมาณ 2027")

    assert note.links == ("ทีมบัญชี",)
    assert "work" in note.tags


def test_tags_are_read_from_frontmatter_as_well_as_the_text():
    """Most people use the frontmatter field, not inline #tags."""
    assert frontmatter_tags("---\ntags:\n  - work\n  - budget\n---\n") == ["work", "budget"]
    assert frontmatter_tags("---\ntags: [work, budget]\n---\n") == ["work", "budget"]
    assert frontmatter_tags("---\ntag: work\n---\n") == ["work"]
    assert frontmatter_tags("---\ntitle: no tags here\n---\n") == []


def test_inline_tags_are_read_too(vault):
    assert vault.find("แกงเขียวหวาน").tags == ("cooking",)


def test_a_vault_folder_is_skipped(vault):
    """.obsidian holds config, not notes."""
    titles = {note.title for note in vault.notes()}

    assert titles == set(NOTES)
    assert not any(".obsidian" in str(path) for path in vault.paths())


def test_a_link_with_a_display_name_or_heading_still_resolves():
    note = parse.__wrapped__ if hasattr(parse, "__wrapped__") else parse
    from pathlib import Path

    got = note(Path("x.md"), "see [[Budget|the budget]] and [[Team#Contacts]]\n")

    assert got.links == ("budget", "team")


def test_a_note_is_the_same_note_however_its_name_is_typed():
    assert normalise("  Budget ") == normalise("budget") == "budget"


def test_missing_vault_says_what_to_set(tmp_path):
    with pytest.raises(VaultError, match="THURSDAY_VAULT"):
        Vault(tmp_path / "nowhere").check()


# -------------------------------------------------------------- the graph


def test_the_graph_goes_both_ways(vault):
    """Obsidian's backlink pane is most of why a graph is useful."""
    edges = vault.graph()

    assert "ทีมบัญชี" in edges["งบประมาณ 2027"]
    assert "งบประมาณ 2027" in edges["ทีมบัญชี"]      # the backlink


def test_orphans_are_the_notes_the_vault_has_lost(vault):
    assert vault.orphans() == ["ค่าใช้จ่ายไอที", "แกงเขียวหวาน"]


def test_neighbours_walk_out_from_a_note(vault):
    assert vault.neighbours("ทีมบัญชี") == ["งบประมาณ 2027", "ประชุมซัพพลายเออร์"]

    # One step reaches the note linked directly; two steps reach what that
    # note leads to in turn.
    assert vault.neighbours("งบประมาณ 2027") == ["ทีมบัญชี"]
    assert vault.neighbours("งบประมาณ 2027", depth=2) == [
        "ทีมบัญชี", "ประชุมซัพพลายเออร์"
    ]
    # And a note is never among its own neighbours, however far you walk.
    assert "งบประมาณ 2027" not in vault.neighbours("งบประมาณ 2027", depth=4)


# -------------------------------------------------------------- writing


def test_thursdays_own_notes_go_in_their_own_folder(vault):
    path = vault.write("Meeting notes", "It was agreed.", tags=["meeting"])

    assert path.parent.name == "Thursday"
    assert "tags:" in path.read_text(encoding="utf-8")
    assert "source: thursday" in path.read_text(encoding="utf-8")


def test_a_thai_title_stays_readable_as_a_filename(vault):
    """A vault full of r-w-wgan.md is not a second brain anyone keeps using."""
    path = vault.write("รีวิวงาน ปี 2027", "x")

    assert "รีวิวงาน ปี 2027" in path.name


def test_a_title_a_filesystem_would_refuse_is_cleaned(vault):
    path = vault.write('re: budget/2027 <draft>?', "x")

    assert path.is_file()
    for bad in '\\/:*?"<>|':
        assert bad not in path.name


def test_what_the_person_wrote_is_never_rewritten(vault):
    before = (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8")

    vault.link("ทีมบัญชี", [("งบประมาณ 2027", "both about the budget")])

    after = (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8")
    assert before.strip() in after
    assert BEGIN in after and END in after


def test_the_block_is_rebuilt_not_repeated(vault):
    """Or a note grows a new Related section every time Thursday thinks."""
    for _ in range(3):
        vault.link("ทีมบัญชี", [("งบประมาณ 2027", "again")])

    body = (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8")

    assert body.count(BEGIN) == 1
    assert body.count("[[งบประมาณ 2027]]") == 1


def test_the_block_is_added_to_rather_than_replaced(vault):
    """A connection found last month is not less true this month."""
    vault.link("ทีมบัญชี", [("งบประมาณ 2027", "first")])
    vault.link("ทีมบัญชี", [("ประชุมซัพพลายเออร์", "second")])

    body = (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8")

    assert "[[งบประมาณ 2027]]" in body
    assert "[[ประชุมซัพพลายเออร์]]" in body
    assert body.count(BEGIN) == 1


def test_a_block_can_be_replaced_outright_when_asked(vault):
    vault.link("ทีมบัญชี", [("งบประมาณ 2027", "first")])
    vault.link("ทีมบัญชี", [("ประชุมซัพพลายเออร์", "only this")], replace=True)

    body = (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8")

    assert "[[งบประมาณ 2027]]" not in body
    assert "[[ประชุมซัพพลายเออร์]]" in body


def test_frontmatter_survives_an_edit(vault):
    """Losing someone's tags because a parser was clever is not a trade."""
    vault.link("งบประมาณ 2027", [("ค่าใช้จ่ายไอที", "same tag")])

    body = (vault.root / "งบประมาณ 2027.md").read_text(encoding="utf-8")

    assert body.startswith("---\ntags:\n  - work\n---")


def test_the_block_reads_back_with_its_reasons(vault):
    vault.link("ทีมบัญชี", [("งบประมาณ 2027", "both tagged #work")])

    entries = block_entries((vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8"))

    assert entries == [("งบประมาณ 2027", "both tagged #work")]


def test_thursdays_own_links_are_not_counted_as_the_persons(vault):
    """Or every suggestion would immediately look like a real link, and the
    graph would fill up with Thursday talking to itself."""
    vault.link("ทีมบัญชี", [("งบประมาณ 2027", "suggested")])

    note = vault.find("ทีมบัญชี")
    assert note.links == ()
    assert note.suggested == ("งบประมาณ 2027",)
    assert "suggested" not in note.text


def test_an_edited_note_can_be_put_back(tmp_path, vault):
    """Through the same journal as any other file change."""
    journal = Journal(Memory(":memory:"), tmp_path / "undo")
    vault.journal = journal
    before = (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8")

    vault.link("ทีมบัญชี", [("งบประมาณ 2027", "why not")])
    journal.undo()

    assert (vault.root / "ทีมบัญชี.md").read_text(encoding="utf-8") == before


# --------------------------------------------------------------- daily notes


def test_a_daily_note_is_made_and_added_to(vault):
    path = vault.add_to_daily("bought milk")
    vault.add_to_daily("called the accountant")

    body = path.read_text(encoding="utf-8")
    assert path.stem == date.today().isoformat()
    assert "- bought milk" in body
    assert "- called the accountant" in body


def test_the_daily_note_can_live_in_a_folder(vault):
    path = vault.daily("Journal")

    assert path.parent.name == "Journal"


# --------------------------------------------------------------- connecting


def test_a_shared_tag_is_the_strongest_evidence(vault):
    found = Connector(vault).suggest()

    tagged = [c for c in found if "งบประมาณ 2027" in (c.source, c.target)
              and "ค่าใช้จ่ายไอที" in (c.source, c.target)]
    assert tagged and tagged[0].reason == "both tagged #work"


def test_a_shared_link_counts_too(vault):
    found = Connector(vault).suggest()
    pairs = {(c.source, c.target): c.reason for c in found}

    assert any("both mention [[ทีมบัญชี]]" == reason for reason in pairs.values())


def test_unrelated_notes_are_left_alone(vault):
    """A curry recipe has nothing to do with the IT budget."""
    found = Connector(vault).suggest()

    assert not any("แกงเขียวหวาน" in (c.source, c.target) for c in found)


def test_notes_already_linked_are_not_suggested(vault):
    found = Connector(vault).suggest()

    assert not any(
        {c.source, c.target} == {"งบประมาณ 2027", "ทีมบัญชี"} for c in found
    )


def test_the_same_pair_is_only_suggested_once(vault):
    found = Connector(vault).suggest()
    pairs = [tuple(sorted((c.source, c.target))) for c in found]

    assert len(pairs) == len(set(pairs))


def test_running_again_finds_only_what_is_new(vault):
    """The whole point: it keeps growing rather than repeating itself."""
    first = Connector(vault)
    first.apply(first.suggest())
    assert Connector(vault).suggest() == []

    (vault.root / "แผนภาษี.md").write_text(
        "---\ntags: [work]\n---\n\nยื่นภาษีก่อนสิ้นพฤษภา\n", encoding="utf-8"
    )
    grown = Connector(vault).suggest()

    assert grown
    assert all("แผนภาษี" in (c.source, c.target) for c in grown)


def test_no_embedding_model_is_not_a_failure(vault):
    """Most people have none, and shared tags are real connections without it."""
    class Missing:
        def embed(self, texts):
            from thursday.embeddings import EmbeddingUnavailable

            raise EmbeddingUnavailable("no model")

    connector = Connector(vault, Missing())
    found = connector.suggest()

    assert found
    assert connector.used_meaning is False


def test_meaning_is_used_when_a_model_is_there(vault):
    """Two notes with no shared tag and no shared link, paired on meaning."""
    (vault.root / "a.md").write_text("the lease on the office runs to 2029\n" * 4,
                                     encoding="utf-8")
    (vault.root / "b.md").write_text("our office rental agreement ends in 2029\n" * 4,
                                     encoding="utf-8")

    class Fake:
        def embed(self, texts):
            # a and b close together, everything else far away.
            return [
                [1.0, 0.0] if "lease" in text or "rental" in text else [0.0, 1.0]
                for text in texts
            ]

    connector = Connector(vault, Fake())
    found = connector.suggest()

    assert connector.used_meaning is True
    pair = [c for c in found if {c.source, c.target} == {"a", "b"}]
    assert pair and pair[0].reason.startswith("close in meaning")


def test_a_stub_is_not_close_in_meaning_to_everything(vault):
    """Two lines pair with anything, which is noise, not a connection."""
    (vault.root / "stub.md").write_text("todo\n", encoding="utf-8")
    (vault.root / "long.md").write_text("a real note about something. " * 20,
                                        encoding="utf-8")

    class Same:
        def embed(self, texts):
            return [[1.0, 0.0] for _ in texts]

    found = Connector(vault, Same()).suggest()

    assert not any("stub" in (c.source, c.target) for c in found)


def test_a_short_note_can_still_share_a_tag(vault):
    """The length floor is about meaning only - a two-line note with a tag in
    common is a perfectly good connection."""
    (vault.root / "สั้นมาก.md").write_text("---\ntags: [it]\n---\n\nสั้น\n", encoding="utf-8")

    found = Connector(vault).suggest()

    assert any("สั้นมาก" in (c.source, c.target) for c in found)


def test_cosine_is_safe_on_rubbish():
    assert cosine([], [1.0]) == 0.0
    assert cosine([0.0, 0.0], [1.0, 1.0]) == 0.0
    assert cosine([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)


def test_the_meaning_floor_is_not_so_low_it_pairs_everything():
    assert 0.5 < MEANING_FLOOR < 0.9


def test_related_to_says_what_is_already_linked(vault):
    found = Connector(vault).related_to("งบประมาณ 2027")
    reasons = {c.target: c.reason for c in found}

    assert reasons.get("ทีมบัญชี") == "already linked"


# ------------------------------------------------------------------- tools


def test_the_tools_read_and_write_the_vault(context, vault):
    registry = build_registry(context.settings)

    found = call(registry, "vault_search", {"query": "งบ"}, context)
    assert "งบประมาณ 2027" in found

    call(registry, "vault_write",
         {"title": "สรุปการประชุม", "text": "อนุมัติแล้ว [[งบประมาณ 2027]]",
          "tags": "meeting"}, context)

    assert (vault.root / "Thursday" / "สรุปการประชุม.md").is_file()
    assert "อนุมัติแล้ว" in call(registry, "vault_read", {"title": "สรุปการประชุม"}, context)


def test_connecting_reads_before_it_writes(context, vault):
    registry = build_registry(context.settings)

    seen = call(registry, "vault_connect", {}, context)
    assert '"written": false' in seen.lower()
    assert BEGIN not in (vault.root / "งบประมาณ 2027.md").read_text(encoding="utf-8")

    call(registry, "vault_connect", {"apply": True}, context)
    assert BEGIN in (vault.root / "ค่าใช้จ่ายไอที.md").read_text(encoding="utf-8")


def test_connecting_asks_before_it_writes(context, vault):
    registry = build_registry(context.settings)
    asked = []

    async def decline(title, detail):
        asked.append(title)
        return False

    context.confirm = decline
    result = call(registry, "vault_connect", {"apply": True}, context)

    assert asked and "vault" in asked[0]
    assert "declined" in result
    assert BEGIN not in (vault.root / "ค่าใช้จ่ายไอที.md").read_text(encoding="utf-8")


def test_a_vault_that_is_not_set_up_says_what_to_do(tmp_path, monkeypatch):
    monkeypatch.delenv("THURSDAY_VAULT", raising=False)
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    with pytest.raises(ToolError, match="THURSDAY_VAULT"):
        call(build_registry(settings), "vault_search", {"query": "x"}, context)


def test_the_map_reports_what_is_adrift(context):
    registry = build_registry(context.settings)

    shown = call(registry, "vault_map", {}, context)

    assert '"notes": 5' in shown
    assert "แกงเขียวหวาน" in shown


def test_the_journal_note_lands_in_todays_note(context, vault):
    registry = build_registry(context.settings)

    call(registry, "vault_journal", {"text": "คุยกับซัพพลายเออร์แล้ว"}, context)

    body = (vault.root / f"{date.today().isoformat()}.md").read_text(encoding="utf-8")
    assert "- คุยกับซัพพลายเออร์แล้ว" in body


def test_a_connection_survives_being_turned_into_json():
    payload = Connection("A", "B", "both tagged #x", 0.96).as_dict()

    assert payload == {"from": "A", "to": "B", "why": "both tagged #x", "strength": 0.96}


def test_slug_never_returns_nothing():
    assert slug("") == "note"
    assert slug("///") == "note"
