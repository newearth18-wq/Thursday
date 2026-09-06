"""Work that is too big for one answer.

A turn has a budget: `max_tool_iterations` bounds it, and past that the
assistant either stops half-done or hands the whole thing to a background job
whose insides nobody can see. Both are bad answers to "tidy up my downloads
folder, then write me a summary of what you found".

A plan is the middle: a titled list of steps, written down before the work
starts, worked through one at a time, and kept in the database so it survives
a turn ending, the process restarting, or the work moving to a background
job. You can see what it means to do before it does it, watch which step it
is on, and pick the work back up tomorrow.

Nothing here runs anything. The planner records intent and progress; the
agent's ordinary tool loop does the work. That split is deliberate - a plan
that could execute itself would be a second, invisible agent loop.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

#: A step is waiting, being worked on, finished, skipped, or it went wrong.
STEP_STATES = ("todo", "doing", "done", "skipped", "failed")

#: A plan is open until every step has been settled one way or another.
PLAN_STATES = ("open", "finished", "abandoned")

#: Long enough for real work, short enough that a plan stays a plan rather
#: than becoming a project the model loses the thread of.
MAX_STEPS = 24


class PlanError(Exception):
    """The plan cannot do what was asked of it."""


@dataclass
class Step:
    number: int
    text: str
    state: str = "todo"
    result: str = ""

    def as_dict(self) -> dict[str, Any]:
        payload = {"number": self.number, "text": self.text, "state": self.state}
        if self.result:
            payload["result"] = self.result
        return payload


@dataclass
class Plan:
    id: int = 0
    title: str = ""
    state: str = "open"
    steps: list[Step] = field(default_factory=list)

    # ------------------------------------------------------------- reading

    @property
    def current(self) -> Step | None:
        """The step being worked on, or the next one waiting."""
        for step in self.steps:
            if step.state == "doing":
                return step
        for step in self.steps:
            if step.state == "todo":
                return step
        return None

    @property
    def done_count(self) -> int:
        return sum(1 for step in self.steps if step.state in {"done", "skipped"})

    @property
    def settled(self) -> bool:
        return all(step.state in {"done", "skipped", "failed"} for step in self.steps)

    def as_dict(self) -> dict[str, Any]:
        current = self.current
        return {
            "id": self.id,
            "title": self.title,
            "state": self.state,
            "done": self.done_count,
            "total": len(self.steps),
            "current": current.as_dict() if current else None,
            "steps": [step.as_dict() for step in self.steps],
        }

    def summary(self) -> str:
        """One line, for a notification or a spoken update."""
        if self.state != "open":
            return f"{self.title} — {self.state} ({self.done_count}/{len(self.steps)})"
        current = self.current
        where = f": {current.text}" if current else ""
        return f"{self.title} — step {self.done_count + 1} of {len(self.steps)}{where}"


class Planner:
    """Plans, kept in the same database as everything else."""

    def __init__(self, memory: Any) -> None:
        self.memory = memory

    # ------------------------------------------------------------- writing

    def start(self, title: str, steps: list[str], session_id: str = "") -> Plan:
        cleaned = [text.strip() for text in steps if text and text.strip()]
        if not cleaned:
            raise PlanError("a plan needs at least one step")
        if len(cleaned) > MAX_STEPS:
            raise PlanError(
                f"that is {len(cleaned)} steps; keep a plan to {MAX_STEPS} or fewer "
                "and make the big ones their own plan later"
            )
        if not title.strip():
            raise PlanError("a plan needs a title")

        # One open plan at a time. Two would race for "the current step" and
        # neither the user nor the model could say which was meant.
        for open_plan in self.open_plans():
            self.memory.set_plan_state(open_plan.id, "abandoned")
            log.info("abandoning plan %s to start a new one", open_plan.id)

        plan_id = self.memory.add_plan(title.strip(), cleaned, session_id)
        return self.get(plan_id)

    def get(self, plan_id: int) -> Plan:
        row = self.memory.plan(plan_id)
        if row is None:
            raise PlanError(f"there is no plan {plan_id}")
        return self._build(row)

    def current(self) -> Plan | None:
        """The plan being worked on, if there is one."""
        plans = self.open_plans()
        return plans[0] if plans else None

    def open_plans(self) -> list[Plan]:
        return [self._build(row) for row in self.memory.plans("open")]

    def recent(self, limit: int = 5) -> list[Plan]:
        return [self._build(row) for row in self.memory.plans(limit=limit)]

    def _build(self, row: Any) -> Plan:
        steps = [
            Step(number=item["number"], text=item["text"], state=item["state"],
                 result=item["result"] or "")
            for item in self.memory.plan_steps(row["id"])
        ]
        return Plan(id=row["id"], title=row["title"], state=row["state"], steps=steps)

    # ------------------------------------------------------------ progress

    def begin_step(self, plan_id: int, number: int = 0) -> Plan:
        """Mark a step as the one being worked on."""
        plan = self.get(plan_id)
        step = self._find(plan, number) if number else plan.current
        if step is None:
            raise PlanError("every step is already settled")
        if step.state in {"done", "skipped"}:
            raise PlanError(f"step {step.number} is already {step.state}")
        # Only one step is ever in flight, so a half-finished one is visible
        # rather than silently abandoned.
        for other in plan.steps:
            if other.state == "doing" and other.number != step.number:
                self.memory.set_step(plan_id, other.number, "todo", "")
        self.memory.set_step(plan_id, step.number, "doing", "")
        return self.get(plan_id)

    def finish_step(self, plan_id: int, result: str = "", number: int = 0) -> Plan:
        plan = self.get(plan_id)
        step = self._find(plan, number) if number else plan.current
        if step is None:
            raise PlanError("there is no step left to finish")
        self.memory.set_step(plan_id, step.number, "done", result.strip())
        return self._settle(plan_id)

    def skip_step(self, plan_id: int, why: str = "", number: int = 0) -> Plan:
        plan = self.get(plan_id)
        step = self._find(plan, number) if number else plan.current
        if step is None:
            raise PlanError("there is no step left to skip")
        self.memory.set_step(plan_id, step.number, "skipped", why.strip())
        return self._settle(plan_id)

    def fail_step(self, plan_id: int, why: str, number: int = 0) -> Plan:
        """Record that a step could not be done. The plan stays open: the rest
        may still be worth doing, and the user decides."""
        plan = self.get(plan_id)
        step = self._find(plan, number) if number else plan.current
        if step is None:
            raise PlanError("there is no step left to fail")
        self.memory.set_step(plan_id, step.number, "failed", why.strip())
        return self.get(plan_id)

    def add_step(self, plan_id: int, text: str) -> Plan:
        """Something turned up mid-plan that has to happen too."""
        plan = self.get(plan_id)
        if plan.state != "open":
            raise PlanError(f"plan {plan_id} is {plan.state}")
        if len(plan.steps) >= MAX_STEPS:
            raise PlanError(f"a plan holds at most {MAX_STEPS} steps")
        if not text.strip():
            raise PlanError("a step needs some words")
        self.memory.add_plan_step(plan_id, text.strip())
        return self.get(plan_id)

    def finish(self, plan_id: int, state: str = "finished") -> Plan:
        if state not in PLAN_STATES:
            raise PlanError(f"a plan is one of {', '.join(PLAN_STATES)}")
        self.memory.set_plan_state(plan_id, state)
        return self.get(plan_id)

    # ------------------------------------------------------------- helpers

    def _find(self, plan: Plan, number: int) -> Step | None:
        for step in plan.steps:
            if step.number == number:
                return step
        raise PlanError(f"plan {plan.id} has no step {number}")

    def _settle(self, plan_id: int) -> Plan:
        """Close a plan the moment nothing is left to do, so the model does not
        have to remember to."""
        plan = self.get(plan_id)
        if plan.state == "open" and plan.settled and not any(
            step.state == "failed" for step in plan.steps
        ):
            self.memory.set_plan_state(plan_id, "finished")
            plan = self.get(plan_id)
        return plan
