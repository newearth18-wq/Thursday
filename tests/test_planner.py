"""Work too big for one turn, made visible."""

from __future__ import annotations

import asyncio

import pytest

from thursday.config import Settings
from thursday.memory import Memory
from thursday.planner import MAX_STEPS, PlanError, Planner
from thursday.tools import ToolContext, ToolError, build_registry


@pytest.fixture()
def planner():
    return Planner(Memory(":memory:"))


@pytest.fixture()
def context(tmp_path, planner):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=planner.memory)
    context.state["planner"] = planner
    return context


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


# ------------------------------------------------------------- the shape


def test_a_plan_knows_which_step_is_next(planner):
    plan = planner.start("Tidy downloads", ["sort by type", "delete duplicates", "report"])

    assert plan.current.number == 1
    assert plan.done_count == 0

    plan = planner.finish_step(plan.id, "sorted 40 files")
    assert plan.current.text == "delete duplicates"
    assert plan.done_count == 1


def test_progress_survives_being_read_back(planner):
    """The point of storing it: a new turn, or a restart, finds the same place."""
    plan = planner.start("Research", ["read the papers", "write it up"])
    planner.begin_step(plan.id)

    fresh = Planner(planner.memory).current()

    assert fresh is not None
    assert fresh.id == plan.id
    assert fresh.current.state == "doing"
    assert fresh.current.text == "read the papers"


def test_a_finished_plan_closes_itself(planner):
    """So the model never has to remember to tidy up after itself."""
    plan = planner.start("Two things", ["one", "two"])
    planner.finish_step(plan.id, "did one")
    plan = planner.finish_step(plan.id, "did two")

    assert plan.state == "finished"
    assert planner.current() is None


def test_a_skipped_step_still_counts_as_settled(planner):
    plan = planner.start("Two things", ["one", "two"])
    planner.finish_step(plan.id, "did one")
    plan = planner.skip_step(plan.id, "not needed after all")

    assert plan.state == "finished"
    assert plan.steps[1].result == "not needed after all"


def test_a_failed_step_leaves_the_plan_open(planner):
    """The rest may still be worth doing, and that is the user's call."""
    plan = planner.start("Two things", ["one", "two"])
    plan = planner.fail_step(plan.id, "the server was down")

    assert plan.state == "open"
    assert plan.steps[0].state == "failed"
    assert plan.current.number == 2       # it moves on rather than sticking


def test_only_one_step_is_ever_in_flight(planner):
    """Two 'doing' steps would leave one silently abandoned."""
    plan = planner.start("Three", ["a", "b", "c"])
    planner.begin_step(plan.id, 1)
    plan = planner.begin_step(plan.id, 3)

    doing = [step.number for step in plan.steps if step.state == "doing"]
    assert doing == [3]
    assert plan.steps[0].state == "todo"


def test_starting_a_plan_puts_the_last_one_aside(planner):
    """Two open plans and neither the user nor the model can say which is meant."""
    first = planner.start("Old work", ["a"])
    second = planner.start("New work", ["b"])

    assert planner.get(first.id).state == "abandoned"
    assert planner.current().id == second.id


def test_a_step_can_be_added_mid_plan(planner):
    plan = planner.start("Tidy", ["sort"])
    plan = planner.add_step(plan.id, "back up first")

    assert [step.text for step in plan.steps] == ["sort", "back up first"]


# -------------------------------------------------------------- refusals


def test_a_plan_needs_steps(planner):
    with pytest.raises(PlanError, match="at least one step"):
        planner.start("Empty", [])
    with pytest.raises(PlanError, match="at least one step"):
        planner.start("Blank", ["", "   "])


def test_a_plan_needs_a_title(planner):
    with pytest.raises(PlanError, match="title"):
        planner.start("  ", ["do the thing"])


def test_a_plan_is_capped(planner):
    with pytest.raises(PlanError, match="steps"):
        planner.start("Everything", [f"step {n}" for n in range(MAX_STEPS + 1)])


def test_an_unknown_step_is_refused(planner):
    plan = planner.start("Two", ["a", "b"])

    with pytest.raises(PlanError, match="no step 9"):
        planner.begin_step(plan.id, 9)


# ----------------------------------------------------------------- tools


def test_the_tools_walk_a_plan_through(context):
    registry = build_registry(context.settings)

    call(registry, "make_plan",
         {"title": "Tidy downloads", "steps": ["sort", "delete duplicates"]}, context)
    call(registry, "start_step", {}, context)
    call(registry, "finish_step", {"result": "sorted 40 files"}, context)
    shown = call(registry, "show_plan", {}, context)

    assert "delete duplicates" in shown
    assert "sorted 40 files" in shown

    finished = call(registry, "finish_step", {"result": "removed 3"}, context)
    assert "finished" in finished
    assert context.state["planner"].current() is None


def test_the_step_tools_refuse_when_nothing_is_planned(context):
    registry = build_registry(context.settings)

    with pytest.raises(ToolError, match="no plan open"):
        call(registry, "start_step", {}, context)
    with pytest.raises(ToolError, match="no plan open"):
        call(registry, "finish_step", {"result": "x"}, context)


def test_show_plan_says_so_when_there_is_nothing(context):
    registry = build_registry(context.settings)

    assert "nothing is in progress" in call(registry, "show_plan", {}, context)


def test_a_plan_can_be_abandoned(context):
    registry = build_registry(context.settings)
    call(registry, "make_plan", {"title": "Nope", "steps": ["a", "b"]}, context)

    call(registry, "abandon_plan", {"why": "the user changed their mind"}, context)

    assert context.state["planner"].current() is None


def test_the_plan_reaches_the_front_ends_as_an_event(context, tmp_path):
    """The HUD redraws from this rather than polling."""
    from tests.test_agent import Block, Reply, StubClient
    from thursday.agent import Agent

    agent = Agent(
        settings=context.settings,
        client=StubClient([
            Reply([Block("tool_use", id="t1", name="make_plan",
                         input={"title": "Tidy", "steps": ["sort", "report"]})], "tool_use"),
            Reply([Block("text", "Here is the plan.")]),
        ]),
    )
    events = []

    async def collect(event):
        events.append(event)

    asyncio.run(agent.run("tidy my downloads", on_event=collect))

    plans = [event for event in events if event.type == "plan"]
    assert plans, "no plan event was emitted"
    assert plans[-1].data["title"] == "Tidy"
    assert plans[-1].data["total"] == 2
    assert plans[-1].data["current"]["text"] == "sort"
