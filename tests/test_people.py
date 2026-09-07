"""More than one person in the house."""

from __future__ import annotations

import asyncio
import json

import pytest

from thursday.agent import Agent
from thursday.config import Settings
from thursday.memory import Memory
from thursday.people import ROLE_DENIED, Household, Person, slug
from thursday.tools import ToolContext, build_registry
from tests.test_agent import Block, Reply, StubClient


@pytest.fixture()
def household(tmp_path):
    house = Household(path=tmp_path / "household.json")
    house.set("Supakit", "owner")
    house.set("Nok", "member")
    house.set("Ploy", "guest")
    return house


@pytest.fixture()
def memory():
    return Memory(":memory:")


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


def context_for(tmp_path, memory, person):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=memory)
    context.state["person"] = person
    return context


# ------------------------------------------------------------------ memory


def test_two_people_can_each_have_their_own_answer(memory):
    """The bug this closes: facts were keyed on the key alone, so the second
    person overwrote the first."""
    memory.remember("home_city", "Bangkok", person="supakit")
    memory.remember("home_city", "Chiang Mai", person="nok")

    assert memory.recall("home_city", "supakit") == "Bangkok"
    assert memory.recall("home_city", "nok") == "Chiang Mai"


def test_a_persons_own_answer_beats_the_shared_one(memory):
    memory.remember("home_city", "Bangkok")                    # the household's
    memory.remember("home_city", "Chiang Mai", person="nok")   # hers

    assert memory.recall("home_city", "nok") == "Chiang Mai"
    assert memory.recall("home_city", "supakit") == "Bangkok"
    assert memory.all_facts("nok")["home_city"] == "Chiang Mai"


def test_nobody_reads_someone_elses_notes(memory):
    memory.add_note("dentist", "tuesday 3pm", person="nok")
    memory.add_note("shopping", "milk", person="supakit")
    memory.add_note("wifi password", "on the router")          # shared

    mine = {note["title"] for note in memory.list_notes(person="supakit")}

    assert mine == {"shopping", "wifi password"}


def test_someone_elses_note_cannot_be_deleted(memory):
    note_id = memory.add_note("dentist", "tuesday", person="nok")

    assert memory.delete_note(note_id, person="supakit") is False
    assert memory.delete_note(note_id, person="nok") is True


def test_searching_notes_stays_within_your_own(memory):
    memory.add_note("ประชุม", "งบประมาณ", person="nok")
    memory.add_note("ประชุม", "งบประมาณ", person="supakit")

    assert len(memory.search_notes("งบประมาณ", person="nok")) == 1


def test_reminders_belong_to_whoever_set_them(memory):
    memory.add_reminder("dentist", 4_000_000_000.0, person="nok")
    memory.add_reminder("standup", 4_000_000_000.0, person="supakit")

    mine = [r.text for r in memory.pending_reminders("supakit")]

    assert mine == ["standup"]


def test_every_reminder_still_fires_whoever_is_in_the_room(memory):
    """Scoping this would silently drop the reminders of whoever was not
    standing in front of the camera."""
    memory.add_reminder("dentist", 1.0, person="nok")
    memory.add_reminder("standup", 1.0, person="supakit")

    due = {r.text for r in memory.due_reminders(now=2.0)}

    assert due == {"dentist", "standup"}


def test_someone_elses_reminder_cannot_be_cancelled(memory):
    reminder = memory.add_reminder("dentist", 4_000_000_000.0, person="nok")

    assert memory.cancel_reminder(reminder.id, person="supakit") is False
    assert memory.cancel_reminder(reminder.id, person="nok") is True


# ------------------------------------------------------------- migration


def test_an_old_database_keeps_its_facts_and_gains_the_new_key(tmp_path):
    """SQLite cannot alter a primary key, so facts is rebuilt. Nothing may be
    lost doing it, and it must not happen twice."""
    import logging
    import sqlite3

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, "
        "updated_at REAL NOT NULL);"
    )
    conn.execute("INSERT INTO facts VALUES ('home_city', 'Bangkok', 1.0)")
    conn.commit()
    conn.close()

    memory = Memory(path)
    assert memory.recall("home_city") == "Bangkok"
    memory.remember("home_city", "Chiang Mai", person="nok")
    assert memory.recall("home_city", "nok") == "Chiang Mai"
    memory.close()

    # Opening it again must be silent - not a rebuild every startup.
    logger = logging.getLogger("thursday.memory")
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    logger.addHandler(handler)
    try:
        Memory(path).close()
    finally:
        logger.removeHandler(handler)

    assert not [r for r in records if "rebuilding" in r.getMessage()]


# --------------------------------------------------------------- the people


def test_a_name_is_the_same_person_however_it_is_typed():
    assert slug("  Nok ") == slug("nok") == "nok"


def test_roles_decide_what_someone_may_do(household):
    assert household.get("Supakit").denied() == ()
    assert "run_shell" in household.get("Nok").denied()
    assert "search_notes" in household.get("Ploy").denied()
    assert "search_notes" not in household.get("Nok").denied()


def test_someone_recognised_but_never_given_a_role_is_a_guest(household):
    """A stranger the camera knows is still a stranger."""
    stranger = household.get("Somebody Else")

    assert stranger.role == "guest"
    assert "run_shell" in stranger.denied()


def test_nobody_recognised_is_the_owner(household):
    """An assistant that locks its owner out when the camera is covered is
    worse than useless. The access token is the real gate."""
    assert household.get("").is_owner is True
    assert household.get("").denied() == ()


def test_a_person_can_be_denied_something_extra(household):
    household.set("Nok", "member", denied_tools=("get_weather",))

    denied = household.get("Nok").denied()

    assert "get_weather" in denied
    assert "run_shell" in denied      # the role's list is still there


def test_a_household_survives_a_round_trip(tmp_path, household):
    household.save()

    reloaded = Household.load(tmp_path / "household.json")

    assert reloaded.get("Nok").role == "member"
    assert reloaded.owner_name() == "Supakit"


def test_a_broken_household_file_is_ignored_not_fatal(tmp_path):
    path = tmp_path / "household.json"
    path.write_text("{not json", encoding="utf-8")

    house = Household.load(path)

    assert house.anyone is False
    assert house.get("anyone").is_owner is True   # back to how it was before


def test_an_unknown_role_in_the_file_becomes_a_guest(tmp_path):
    path = tmp_path / "household.json"
    path.write_text(
        json.dumps({"people": {"x": {"name": "X", "role": "administrator"}}}),
        encoding="utf-8",
    )

    assert Household.load(path).get("X").role == "guest"


# ----------------------------------------------------------------- the agent


def test_the_agent_applies_a_persons_permissions(tmp_path, household):
    agent = Agent(
        settings=Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=()),
        household=household,
        client=StubClient([Reply([Block("text", "ok")])]),
    )

    agent.speaking_to("Nok")
    assert "run_shell" in agent.policy.denied_tools

    agent.speaking_to("Supakit")
    assert "run_shell" not in agent.policy.denied_tools


def test_switching_back_restores_exactly_what_was_configured(tmp_path, household):
    """A person's denials must not accumulate on the policy."""
    settings = Settings(
        workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=(), allow_shell=False
    )
    agent = Agent(settings=settings, household=household,
                  client=StubClient([Reply([Block("text", "ok")])]))

    agent.speaking_to("Ploy")
    agent.speaking_to("Supakit")

    # The owner gets back the configured list - which still has no shell,
    # because that is what allow_shell=False said.
    assert agent.policy.denied_tools == ("run_shell",)


def test_a_denied_tool_is_refused_when_a_guest_asks(tmp_path, household):
    agent = Agent(
        settings=Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=()),
        household=household,
        client=StubClient([
            Reply([Block("tool_use", id="t1", name="run_shell",
                         input={"command": "ls"})], "tool_use"),
            Reply([Block("text", "I cannot do that here.")]),
        ]),
    )
    agent.speaking_to("Ploy")
    events = []

    async def collect(event):
        events.append(event)

    asyncio.run(agent.run("list my files", on_event=collect))

    refusals = [e for e in events if e.type == "tool_error"]
    assert refusals, "the guest's shell command was not refused"
    assert "switched off" in refusals[0].result


def test_the_prompt_says_who_is_being_spoken_to(tmp_path, household):
    agent = Agent(
        settings=Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=()),
        household=household,
        client=StubClient([Reply([Block("text", "ok")])]),
    )
    default = agent.profiles["default"]

    agent.speaking_to("Ploy")
    guest_prompt = agent.system_for(default)
    agent.speaking_to("Supakit")
    owner_prompt = agent.system_for(default)

    assert "Ploy" in guest_prompt and "guest" in guest_prompt
    assert "Supakit" in guest_prompt          # so it can point them at the owner
    assert "guest" not in owner_prompt
    # The owner's prompt is the plain one, so the cache still hits for them.
    assert owner_prompt == agent.base_system


def test_a_persons_notes_are_their_own_through_the_tools(tmp_path, memory, household):
    registry = build_registry(
        Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    )
    nok = context_for(tmp_path, memory, household.get("Nok"))
    owner = context_for(tmp_path, memory, household.get("Supakit"))

    call(registry, "add_note", {"title": "dentist", "body": "tuesday"}, nok)
    call(registry, "remember_fact", {"key": "home_city", "value": "Chiang Mai"}, nok)

    assert "dentist" not in call(registry, "search_notes", {}, owner)
    assert "dentist" in call(registry, "search_notes", {}, nok)
    assert "Chiang Mai" not in call(registry, "recall_facts", {}, owner)


def test_with_nobody_listed_nothing_changes(tmp_path, memory):
    """A household of one must behave exactly as it did before people existed."""
    empty = Household(path=tmp_path / "household.json")
    registry = build_registry(
        Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    )
    context = context_for(tmp_path, memory, empty.get(""))

    call(registry, "add_note", {"title": "shopping", "body": "milk"}, context)

    assert "shopping" in call(registry, "search_notes", {}, context)
    assert empty.anyone is False


def test_every_role_denies_a_real_tool(tmp_path):
    """A typo in ROLE_DENIED would silently deny nothing."""
    registry = build_registry(
        Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    )
    known = {tool.name for tool in registry}

    for role, denied in ROLE_DENIED.items():
        unknown = set(denied) - known
        assert not unknown, f"{role} denies tools that do not exist: {sorted(unknown)}"


def test_the_guest_profile_denies_real_tools_too(tmp_path):
    from thursday.profiles import builtin_map

    registry = build_registry(
        Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    )
    known = {tool.name for tool in registry}
    guest = builtin_map()["guest"]

    assert not set(guest.deny_tools) - known
    assert Person(name="X", role="guest").denied() == guest.deny_tools


def test_a_broken_file_does_not_lock_the_owner_out(tmp_path):
    """Roles are not in force until they have been set up, so a file that
    failed to parse must not demote a named owner to a guest."""
    path = tmp_path / "household.json"
    path.write_text("{not json", encoding="utf-8")

    house = Household.load(path)

    assert house.get("Supakit").is_owner is True
    assert house.get("Supakit").denied() == ()


def test_once_roles_exist_an_unlisted_name_is_a_guest(household):
    assert household.anyone is True
    assert household.get("Someone New").role == "guest"


# ----------------------------------------------- the gaps in the deny lists


def test_a_guest_who_cannot_write_a_file_cannot_delete_one_either():
    """delete_file was allowed to a guest who could not read, write, list or
    search a single file - only the tool's own confirmation prompt stood in
    the way, and that prompt does not say the request came from a guest."""
    from thursday.people import ROLE_DENIED

    for role in ("member", "guest"):
        assert "delete_file" in ROLE_DENIED[role]
        assert "undo_change" in ROLE_DENIED[role]


def test_the_vault_is_notes_and_is_treated_as_notes():
    """The guest style prompt says "no access to the owner's notes". The
    vault is the owner's notes, and all of it was readable and writable."""
    from thursday.people import ROLE_DENIED

    for tool_name in ("vault_read", "vault_search", "vault_write", "vault_map"):
        assert tool_name in ROLE_DENIED["guest"], tool_name
    # A member lives here and may read it, but not rewrite it, exactly as
    # they may read a file but not write one.
    assert "vault_write" in ROLE_DENIED["member"]
    assert "vault_read" not in ROLE_DENIED["member"]


def test_a_guest_cannot_read_what_the_owner_last_copied():
    """A clipboard holds whatever was copied last, which is regularly a
    password or an address someone is about to paste."""
    from thursday.people import ROLE_DENIED

    assert "read_clipboard" in ROLE_DENIED["guest"]
    assert "write_clipboard" in ROLE_DENIED["guest"]


def test_a_guest_cannot_read_the_owners_calendar_or_drafts():
    from thursday.people import ROLE_DENIED

    for tool_name in ("whats_on", "daily_brief", "list_drafts", "read_draft"):
        assert tool_name in ROLE_DENIED["guest"], tool_name


def test_denying_one_of_a_pair_denies_the_other(tmp_path):
    """The bug this list keeps having is a tool that does the same thing as a
    denied one under a different name. Adding a tool to SAME_ACT is what stops
    it happening again, so the wiring is checked rather than trusted."""
    from thursday.people import ROLE_DENIED, SAME_ACT

    for role, denied in ROLE_DENIED.items():
        if role == "owner":
            continue
        for name in denied:
            for twin in SAME_ACT.get(name, ()):
                assert twin in denied, f"{role} is denied {name} but allowed {twin}"


def test_every_tool_named_in_the_pairs_actually_exists(tmp_path):
    """A typo in this list is a rule that silently does nothing."""
    from thursday.config import Settings
    from thursday.people import SAME_ACT
    from thursday.tools import build_registry

    registry = build_registry(Settings(workspace=tmp_path, plugin_dirs=()))
    known = {found.name for found in registry}

    for name, twins in SAME_ACT.items():
        assert name in known, name
        for twin in twins:
            assert twin in known, twin


def test_the_guest_profile_and_the_guest_role_cannot_drift_apart():
    """Two copies of one list is how the vault ended up readable by someone
    who could not read a file."""
    from thursday.people import ROLE_DENIED
    from thursday.profiles import builtin_map

    assert set(builtin_map()["guest"].deny_tools) == set(ROLE_DENIED["guest"])
