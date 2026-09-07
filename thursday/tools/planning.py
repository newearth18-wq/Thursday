"""Saying what you are going to do, then showing where you have got to.

These tools write nothing to the machine and run nothing. They exist so that
big work is legible: the user reads the plan before it starts, watches the
step counter move, and can pick it up again tomorrow.
"""

from __future__ import annotations

from typing import Any

from ..planner import Plan, PlanError, Planner
from . import ToolContext, ToolError, tool


def _planner(ctx: ToolContext) -> Planner:
    if ctx is None or ctx.memory is None:
        raise ToolError("plans need memory, which is not available here")
    existing = ctx.state.get("planner")
    if isinstance(existing, Planner):
        return existing
    planner = Planner(ctx.memory)
    ctx.state["planner"] = planner
    return planner


def _shown(plan: Plan, hint: str = "") -> dict[str, Any]:
    payload = plan.as_dict()
    if hint:
        payload["next"] = hint
    return payload


@tool
def make_plan(title: str, steps: list[str], ctx: ToolContext = None) -> dict[str, Any]:
    """Write down the steps for a piece of work before starting it.

    Use this when a request needs several distinct actions, or more than one
    turn - "tidy my downloads then summarise what you found", "research this
    and write it up". Do not use it for something you can do in one step.

    Starting a plan puts any earlier open one aside, so there is only ever one
    thing being worked on.

    Args:
        title: What the whole job is, in a few words.
        steps: The steps, in order. Each one an action, not a heading.
    """
    planner = _planner(ctx)
    try:
        plan = planner.start(title, list(steps))
    except PlanError as exc:
        raise ToolError(str(exc)) from exc
    return _shown(
        plan,
        "Tell the user the plan, then call start_step and do the first one. "
        "Call finish_step with what came of it before moving on.",
    )


@tool
def start_step(step: int = 0, ctx: ToolContext = None) -> dict[str, Any]:
    """Mark which step of the plan you are on now.

    Args:
        step: Which step number. Leave at 0 for the next one waiting.
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        raise ToolError("there is no plan open; call make_plan first")
    try:
        plan = planner.begin_step(plan.id, step)
    except PlanError as exc:
        raise ToolError(str(exc)) from exc
    return _shown(plan)


@tool
def finish_step(result: str, step: int = 0, ctx: ToolContext = None) -> dict[str, Any]:
    """Record that a step is done, and what came of it.

    The result is what the user would want to know - "renamed 40 files",
    "found three quotes over budget" - not "completed successfully".

    Args:
        result: What actually happened.
        step: Which step. Leave at 0 for the one in progress.
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        raise ToolError("there is no plan open")
    try:
        plan = planner.finish_step(plan.id, result, step)
    except PlanError as exc:
        raise ToolError(str(exc)) from exc
    hint = (
        "Every step is settled - tell the user what you found overall."
        if plan.state == "finished"
        else "Call start_step for the next one."
    )
    return _shown(plan, hint)


@tool
def skip_step(why: str, step: int = 0, ctx: ToolContext = None) -> dict[str, Any]:
    """Record that a step turned out not to be needed, and why.

    Args:
        why: Why it can be skipped.
        step: Which step. Leave at 0 for the current one.
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        raise ToolError("there is no plan open")
    try:
        return _shown(planner.skip_step(plan.id, why, step))
    except PlanError as exc:
        raise ToolError(str(exc)) from exc


@tool
def fail_step(why: str, step: int = 0, ctx: ToolContext = None) -> dict[str, Any]:
    """Record that a step could not be done.

    The plan stays open: the remaining steps may still be worth doing, and
    that is the user's call, not yours. Say what blocked you.

    Args:
        why: What stopped it.
        step: Which step. Leave at 0 for the current one.
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        raise ToolError("there is no plan open")
    try:
        return _shown(
            planner.fail_step(plan.id, why, step),
            "Tell the user what blocked this and ask whether to carry on with the rest.",
        )
    except PlanError as exc:
        raise ToolError(str(exc)) from exc


@tool
def add_plan_step(text: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Add a step that turned out to be needed after the plan was written.

    Args:
        text: The action to add, at the end.
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        raise ToolError("there is no plan open")
    try:
        return _shown(planner.add_step(plan.id, text))
    except PlanError as exc:
        raise ToolError(str(exc)) from exc


@tool
def show_plan(ctx: ToolContext = None) -> dict[str, Any]:
    """Look at the plan in progress, including after a break or a restart.

    Call this at the start of a turn when the user refers to work already
    under way - "carry on", "where were we", "ทำต่อ".
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        recent = planner.recent(3)
        return {
            "open": False,
            "detail": "nothing is in progress",
            "recent": [entry.as_dict() for entry in recent],
        }
    return _shown(plan, "Carry on from the current step.")


@tool
def abandon_plan(why: str = "", ctx: ToolContext = None) -> dict[str, Any]:
    """Drop the plan in progress, when the user says to stop or changes course.

    Args:
        why: Why it is being dropped.
    """
    planner = _planner(ctx)
    plan = planner.current()
    if plan is None:
        raise ToolError("there is no plan open")
    try:
        plan = planner.finish(plan.id, "abandoned")
    except PlanError as exc:
        raise ToolError(str(exc)) from exc
    return {"id": plan.id, "title": plan.title, "state": plan.state, "why": why}
