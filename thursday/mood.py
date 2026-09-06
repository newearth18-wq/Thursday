"""What Thursday is doing, and how it feels about it.

Front ends should not each invent their own idea of the assistant's state, so
it is derived here from the same event stream everything else renders. The HUD
draws it as a readout; the avatar draws it as a face.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .events import Event

#: Moods, roughly ordered from resting to alarmed. The web UI maps each to a
#: face and a colour, so adding one here means adding one there.
MOODS = (
    "asleep",      # nothing has happened yet
    "calm",        # idle and ready
    "attentive",   # a question has arrived
    "thinking",    # reasoning, no tool running
    "working",     # a tool is running
    "pleased",     # finished, and it went well
    "concerned",   # something failed
    "apologetic",  # declined, cancelled, or out of budget
)

#: How each tool reads out loud. Anything unlisted falls back to its own name.
ACTIVITIES = {
    "system_status": "checking the machine",
    "list_processes": "looking at what is running",
    "open_app": "opening that for you",
    "which": "checking what is installed",
    "read_file": "reading a file",
    "write_file": "writing a file",
    "list_files": "looking through your files",
    "search_files": "searching your files",
    "run_shell": "running a command",
    "take_screenshot": "looking at your screen",
    "look_at_image": "looking at an image",
    "read_clipboard": "reading your clipboard",
    "write_clipboard": "copying that for you",
    "set_volume": "adjusting the volume",
    "media_control": "controlling playback",
    "show_notification": "sending a notification",
    "lock_screen": "locking the screen",
    "current_time": "checking the time",
    "set_timer": "setting a timer",
    "set_reminder": "setting a reminder",
    "list_reminders": "checking your reminders",
    "cancel_reminder": "cancelling a reminder",
    "remember_fact": "committing that to memory",
    "recall_facts": "recalling what I know",
    "forget_fact": "forgetting that",
    "add_note": "writing that down",
    "search_notes": "going through your notes",
    "delete_note": "deleting a note",
    "search_history": "searching our history",
    "index_documents": "reading your documents",
    "search_documents": "looking through your documents",
    "list_documents": "checking the library",
    "forget_document": "removing a document",
    "start_job": "taking that on in the background",
    "check_jobs": "checking on background work",
    "job_result": "reading back a finished job",
    "cancel_job": "stopping a job",
    "schedule_routine": "setting that to run on its own",
    "list_schedules": "checking what runs on its own",
    "cancel_schedule": "cancelling a schedule",
    "save_routine": "saving that routine",
    "run_routine": "running your routine",
    "list_routines": "checking your routines",
    "delete_routine": "deleting a routine",
    "whats_on": "checking your calendar",
    "check_mail": "checking your inbox",
    "draft_email": "writing that email for you to look over",
    "draft_event": "putting that in the diary for you to check",
    "list_drafts": "checking what is waiting to be sent",
    "read_draft": "reading a draft back",
    "revise_draft": "rewriting that draft",
    "discard_draft": "throwing that draft away",
    "send_draft": "sending it",
    "mail_setup": "checking whether I can send mail",
    "read_mail": "reading an email",
    "get_weather": "checking the weather",
    "fetch_url": "reading a page",
    "browse": "opening that in a browser",
    "browser_act": "clicking around the page",
    "browser_screenshot": "looking at the page",
    "close_browser": "closing the browser",
    "web_search": "searching the web",
    "web_fetch": "reading a page",
}


def describe_tool(name: str) -> str:
    """A human phrase for what a tool call is doing."""
    if name in ACTIVITIES:
        return ACTIVITIES[name]
    if "_" in name:  # an MCP tool, named <server>_<tool>
        server, _, tool = name.partition("_")
        return f"using {tool.replace('_', ' ')} on {server}"
    return f"using {name}"


@dataclass
class State:
    """A snapshot of what to show the user."""

    mood: str = "asleep"
    activity: str = "standing by"
    #: Extra line the HUD shows under the activity, e.g. a model name.
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"type": "state", "mood": self.mood, "activity": self.activity, "detail": self.detail}


class MoodTracker:
    """Turns a stream of agent events into a stream of states.

    Returns a new State only when something actually changed, so a front end
    can redraw on every emission without flickering through a whole reply.
    """

    def __init__(self, assistant_name: str = "Thursday") -> None:
        self.name = assistant_name
        self.state = State()
        self._spoke = False

    def start_turn(self, text: str = "") -> State:
        """The user has said something."""
        return self._set("attentive", "listening to you")

    def update(self, event: Event) -> State | None:
        kind = event.type

        if kind == "profile":
            data = event.data
            return self._set(
                "thinking",
                "deciding how to help",
                detail=f"{data.get('profile', '')} · {data.get('provider', '')}/{data.get('model', '')}",
            )

        if kind == "thinking":
            return self._set("thinking", "thinking it through")

        if kind == "text":
            # The first words of the reply are the moment it starts answering.
            if not self._spoke:
                self._spoke = True
                return self._set("thinking", "answering")
            return None

        if kind == "tool_start":
            return self._set("working", describe_tool(event.tool), detail=event.tool)

        if kind == "tool_end":
            return self._set("thinking", "reading the result", detail=event.tool)

        if kind == "tool_error":
            return self._set("concerned", f"{describe_tool(event.tool)} did not work", detail=event.tool)

        if kind == "usage":
            return None  # metering is not a mood

        if kind == "cancelled":
            self._spoke = False
            return self._set("apologetic", "stopped, as you asked")

        if kind == "error":
            self._spoke = False
            return self._set("concerned", event.text[:120] or "something went wrong")

        if kind == "done":
            self._spoke = False
            # An empty reply after an error should not look like success.
            if self.state.mood in {"concerned", "apologetic"}:
                return self._set(self.state.mood, "standing by")
            return self._set("pleased", "standing by")

        return None

    def idle(self) -> State:
        """Settle back down after a while with nothing happening."""
        return self._set("calm", "standing by")

    def _set(self, mood: str, activity: str, detail: str = "") -> State | None:
        candidate = State(mood=mood, activity=activity, detail=detail)
        if candidate == self.state:
            return None
        self.state = candidate
        return candidate
