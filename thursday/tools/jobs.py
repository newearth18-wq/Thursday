"""Work that takes longer than a conversation.

A turn has to finish while the user waits, and `max_tool_iterations` caps how
much can happen inside one. Anything bigger - "research these five things and
write it up", "go through that folder and summarise each file" - becomes a
job: queued here, worked on in the background, reported when it is done.
"""

from __future__ import annotations

from typing import Any

from . import ToolContext, ToolError, tool


def _memory(ctx: ToolContext | None):
    if ctx is None or ctx.memory is None:
        raise ToolError("persistent memory is unavailable")
    return ctx.memory


@tool
def start_job(title: str, instruction: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Take on a piece of work that will take a while, and report back later.

    Use this when the user asks for something too big to finish in one reply -
    research across several sources, going through many files, anything
    open-ended. Tell them it is running; they will be told when it is done.

    Args:
        title: A short name, e.g. "compare the three suppliers".
        instruction: The full brief, as if you were handing it to a colleague.
            Include everything needed - the job runs without this conversation.
    """
    if not instruction.strip():
        raise ToolError("a job needs an instruction to work from")

    memory = _memory(ctx)
    session = ctx.state.get("session_id", "") if ctx else ""
    job_id = memory.add_job(title, instruction, session)
    return {
        "id": job_id,
        "title": title.strip(),
        "status": "queued",
        "note": "working on it in the background; I will report when it is done",
    }


@tool
def check_jobs(limit: int = 10, ctx: ToolContext = None) -> list[dict[str, Any]]:
    """See what background work is queued, running or finished.

    Args:
        limit: How many to list, newest first.
    """
    return [
        {
            "id": job["id"],
            "title": job["title"],
            "status": job["status"],
            "finished": job["finished_at"],
            **({"result": job["result"][:800]} if job["result"] else {}),
        }
        for job in _memory(ctx).jobs(limit)
    ]


@tool
def job_result(job_id: int, ctx: ToolContext = None) -> dict[str, Any]:
    """Read what a finished job produced.

    Args:
        job_id: The id from start_job or check_jobs.
    """
    job = _memory(ctx).job(job_id)
    if job is None:
        raise ToolError(f"no job with id {job_id}")
    return job


@tool
def cancel_job(job_id: int, ctx: ToolContext = None) -> str:
    """Stop a job that is queued or running.

    Args:
        job_id: The id from start_job or check_jobs.
    """
    return "cancelled" if _memory(ctx).cancel_job(job_id) else "that job is already finished"
