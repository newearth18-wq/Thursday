"""What Thursday may do to this machine, and what it is kept away from."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from thursday.config import Settings
from thursday.memory import Memory
from thursday.permissions import DEFAULT_TOOL_RULES, SECRET_PATTERNS, Policy
from thursday.tools import ToolContext, ToolError, build_registry


@pytest.fixture()
def workspace(tmp_path):
    """A workspace containing exactly the files that must not leak."""
    data = tmp_path / "data"
    data.mkdir()
    (data / "settings.json").write_text('{"ANTHROPIC_API_KEY": "sk-ant-REALSECRET"}', encoding="utf-8")
    (data / "people.json").write_text('{"people": {"me": {"face": [[0.1]]}}}', encoding="utf-8")
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-DOTENV\n", encoding="utf-8")
    (tmp_path / "notes.md").write_text("just some notes\n", encoding="utf-8")
    return tmp_path


@pytest.fixture()
def context(workspace):
    settings = Settings(workspace=workspace, data_dir=workspace / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=Memory(":memory:"))
    context.state["policy"] = Policy.from_settings(settings)
    return context


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


# ------------------------------------------------------- the actual leak


def test_thursdays_own_secrets_cannot_be_read(context):
    """This was readable before the policy existed: it holds every API key."""
    registry = build_registry(context.settings)

    with pytest.raises(ToolError, match="protected"):
        call(registry, "read_file", {"path": "data/settings.json"}, context)
    with pytest.raises(ToolError, match="protected"):
        call(registry, "read_file", {"path": ".env"}, context)
    with pytest.raises(ToolError, match="protected"):
        call(registry, "read_file", {"path": "data/people.json"}, context)


def test_ordinary_files_still_work(context):
    registry = build_registry(context.settings)
    assert "just some notes" in call(registry, "read_file", {"path": "notes.md"}, context)


def test_secrets_cannot_be_grepped_out_either(context):
    """Reading a secret a line at a time is still reading it."""
    registry = build_registry(context.settings)

    found = call(registry, "search_files", {"query": "sk-ant"}, context)
    assert "REALSECRET" not in found
    assert "DOTENV" not in found


def test_protected_files_are_not_even_listed(context):
    registry = build_registry(context.settings)
    listing = call(registry, "list_files", {"path": "."}, context)

    assert "notes.md" in listing
    assert "settings.json" not in listing


def test_the_shell_cannot_be_used_to_read_them(context):
    """`cat .env` is the same act as read_file('.env')."""
    policy = context.state["policy"]

    assert policy.command_refused("cat .env")
    assert policy.command_refused("grep -r sk- .env")
    assert policy.command_refused("cat ~/.ssh/id_rsa")
    assert policy.command_refused("ls -la") == ""


def test_secrets_are_kept_out_of_the_document_index(workspace):
    """An indexed secret would be embedded and quoted back in answers."""
    from thursday.documents import Library, Unreadable

    settings = Settings(workspace=workspace, data_dir=workspace / "data", plugin_dirs=())
    library = Library(Memory(":memory:"), policy=Policy.from_settings(settings))

    result = library.index_tree(workspace)
    indexed = [Path(entry["path"]).name for entry in result["indexed"]]
    assert indexed == ["notes.md"]

    with pytest.raises(Unreadable, match="protected"):
        library.index(workspace / ".env")


# -------------------------------------------------------------- the rules


@pytest.mark.parametrize(
    "path",
    [
        "/home/me/.env",
        "/home/me/project/.env.production",
        "/home/me/.ssh/id_rsa",
        "/home/me/.aws/credentials",
        "/home/me/.git-credentials",
        "/home/me/certs/key.pem",
        "/home/me/.config/gh/hosts.yml",
    ],
)
def test_conventional_secrets_are_protected(path):
    assert Policy().may_read(path) is False


@pytest.mark.parametrize("path", ["/home/me/notes.md", "/etc/hosts", "/home/me/code/main.py"])
def test_ordinary_paths_are_not(path):
    assert Policy().may_read(path) is True


def test_a_relative_name_resolves_against_the_workspace():
    policy = Policy(workspace=Path("/home/me/project"))
    assert policy.secret(".env") is True
    assert policy.secret("notes.md") is False


def test_a_config_file_cannot_unprotect_the_built_ins(tmp_path):
    """A typo in permissions.json must not expose your SSH keys."""
    config = tmp_path / "permissions.json"
    config.write_text(json.dumps({"deny_paths": ["**/only-this"]}), encoding="utf-8")

    policy = Policy.load([config])

    assert policy.may_read("/home/me/.ssh/id_rsa") is False   # still protected
    assert policy.may_read("/home/me/only-this") is False      # and the new one


def test_a_broken_config_falls_back_to_the_defaults(tmp_path):
    bad = tmp_path / "permissions.json"
    bad.write_text("{not json", encoding="utf-8")

    policy = Policy.load([bad])
    assert policy.deny_paths == SECRET_PATTERNS
    assert policy.tool_rules == DEFAULT_TOOL_RULES


def test_extra_directories_can_be_opened_up(tmp_path):
    config = tmp_path / "permissions.json"
    config.write_text(json.dumps({"read_paths": [str(tmp_path / "docs")]}), encoding="utf-8")

    policy = Policy.load([config])
    assert (tmp_path / "docs").resolve() in policy.extra_roots()


def test_reading_outside_the_workspace_needs_permission(tmp_path):
    """The allow list is what opens a directory up, not the absence of a rule."""
    workspace = tmp_path / "work"
    workspace.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "report.md").write_text("figures", encoding="utf-8")

    settings = Settings(workspace=workspace, data_dir=workspace / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=Memory(":memory:"))
    context.state["policy"] = Policy.from_settings(settings)
    registry = build_registry(settings)

    with pytest.raises(ToolError, match="outside the workspace"):
        call(registry, "read_file", {"path": str(outside / "report.md")}, context)

    context.state["policy"].read_paths = (str(outside),)
    assert "figures" in call(registry, "read_file", {"path": str(outside / "report.md")}, context)


# ------------------------------------------------------------- decisions


def test_a_denied_tool_is_never_run():
    policy = Policy(denied_tools=("run_shell",))
    decision = policy.decide("run_shell", {"command": "ls"})

    assert decision.refused is True
    assert "switched off" in decision.reason


def test_tools_default_to_asking_or_allowing():
    policy = Policy()
    assert policy.decide("run_shell", {"command": "ls"}).needs_asking is True
    assert policy.decide("current_time", {}).allowed is True


def test_an_unlisted_tool_follows_its_own_dangerous_flag():
    policy = Policy()
    assert policy.decide("something_new", {}, dangerous=True).needs_asking is True
    assert policy.decide("something_new", {}, dangerous=False).allowed is True


def test_a_rule_can_forbid_a_tool_outright(tmp_path):
    config = tmp_path / "permissions.json"
    config.write_text(json.dumps({"tools": {"lock_screen": "deny"}}), encoding="utf-8")

    assert Policy.load([config]).decide("lock_screen", {}).refused is True


def test_turning_off_confirmations_is_honoured_but_not_for_denials():
    policy = Policy(trust_everything=True)

    assert policy.decide("run_shell", {"command": "ls"}).allowed is True
    # Off does not mean "and read my SSH keys too".
    assert policy.decide("read_file", {"path": "/home/me/.ssh/id_rsa"}).refused is True


def test_settings_that_disable_the_shell_reach_the_policy(tmp_path):
    settings = Settings(workspace=tmp_path, plugin_dirs=(), allow_shell=False)
    assert "run_shell" in Policy.from_settings(settings).denied_tools


def test_extra_command_patterns_are_refused(tmp_path):
    config = tmp_path / "permissions.json"
    config.write_text(json.dumps({"denied_commands": ["git push --force"]}), encoding="utf-8")

    policy = Policy.load([config])
    assert policy.command_refused("git push --force origin main")
    assert policy.command_refused("git push origin main") == ""


# ----------------------------------------------------------------- audit


def test_every_decision_is_recorded():
    memory = Memory(":memory:")
    memory.record_access("read_file", {"path": ".env"}, "denied", "protected", "s")
    memory.record_access("run_shell", {"command": "ls"}, "allowed", "", "s")

    log = memory.access_log()
    assert [row["outcome"] for row in log] == ["allowed", "denied"]
    assert log[1]["reason"] == "protected"


def test_the_audit_can_be_summarised():
    memory = Memory(":memory:")
    for _ in range(3):
        memory.record_access("run_shell", {}, "allowed")
    memory.record_access("read_file", {}, "denied", "protected")

    summary = {(row["tool"], row["outcome"]): row["count"] for row in memory.access_summary()}
    assert summary[("run_shell", "allowed")] == 3
    assert summary[("read_file", "denied")] == 1


def test_unserialisable_arguments_do_not_break_the_log():
    memory = Memory(":memory:")
    memory.record_access("odd", {"thing": object()}, "allowed")
    assert memory.access_log()[0]["tool"] == "odd"


def test_the_agent_refuses_and_records(tmp_path, workspace):
    """The policy is enforced in the loop, not only inside the tools."""
    from tests.test_agent import Block, Reply, StubClient, collect
    from thursday.agent import Agent
    from thursday.tools import ToolRegistry, tool

    registry = ToolRegistry()
    ran = []

    @tool(registry=registry)
    def read_file(path: str) -> str:
        """Read a file."""
        ran.append(path)
        return "sk-ant-REALSECRET"

    settings = Settings(workspace=workspace, data_dir=workspace / "data", plugin_dirs=())
    agent = Agent(
        settings=settings,
        memory=Memory(":memory:"),
        registry=registry,
        client=StubClient(
            [
                Reply([Block("tool_use", id="t1", name="read_file", input={"path": ".env"})], "tool_use"),
                Reply([Block("text", "I cannot read that.")]),
            ]
        ),
    )
    reply, events = collect(agent, "read the env file")

    assert ran == []                      # the function never ran
    assert reply == "I cannot read that."
    assert any(e.type == "tool_error" and "protected" in e.result for e in events)

    logged = agent.memory.access_log()
    assert logged[0]["outcome"] == "denied"
    assert logged[0]["tool"] == "read_file"


def test_an_allowed_call_is_recorded_too(tmp_path):
    from tests.test_agent import Block, Reply, StubClient, collect
    from thursday.agent import Agent
    from thursday.tools import ToolRegistry, tool

    registry = ToolRegistry()

    @tool(registry=registry)
    def current_time() -> str:
        """The time."""
        return "12:00"

    agent = Agent(
        settings=Settings(workspace=tmp_path, data_dir=tmp_path, plugin_dirs=()),
        memory=Memory(":memory:"),
        registry=registry,
        client=StubClient(
            [
                Reply([Block("tool_use", id="t1", name="current_time", input={})], "tool_use"),
                Reply([Block("text", "Noon.")]),
            ]
        ),
    )
    collect(agent, "what time is it")

    assert agent.memory.access_log()[0]["outcome"] == "allowed"
