"""Terminal chat front end.

Plain ANSI - no extra dependencies, so `thursday chat` works on a fresh install.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from .agent import Agent
from .config import Settings
from .events import Event

RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
RED = "\033[31m"
GREEN = "\033[32m"

BANNER = f"""{CYAN}{BOLD}
 ████████ ██   ██ ██    ██ ██████  ███████ ██████   █████  ██    ██
    ██    ██   ██ ██    ██ ██   ██ ██      ██   ██ ██   ██  ██  ██
    ██    ███████ ██    ██ ██████  ███████ ██   ██ ███████   ████
    ██    ██   ██ ██    ██ ██   ██      ██ ██   ██ ██   ██    ██
    ██    ██   ██  ██████  ██   ██ ███████ ██████  ██   ██    ██
{RESET}{DIM}   at your service - /help for commands, /quit to leave{RESET}
"""

HELP = """
Commands:
  /help              show this
  /tools             list the tools I can use
  /memory            show what I remember about you
  /forget <key>      make me forget one thing
  /reminders         list pending reminders
  /clear             wipe this session's history
  /thinking          toggle showing my reasoning
  /quit              exit
"""


def supports_color() -> bool:
    return sys.stdout.isatty()


class Printer:
    """Prints agent events, keeping the streamed reply on one flowing line."""

    def __init__(self, color: bool = True) -> None:
        self.color = color
        self._in_text = False

    def paint(self, text: str, code: str) -> str:
        return f"{code}{text}{RESET}" if self.color else text

    async def __call__(self, event: Event) -> None:
        if event.type == "text":
            if not self._in_text:
                print(self.paint("Thursday: ", CYAN), end="")
                self._in_text = True
            print(event.text, end="", flush=True)
        elif event.type == "thinking":
            print(self.paint(event.text, DIM), end="", flush=True)
        elif event.type == "tool_start":
            self._newline()
            arguments = ", ".join(f"{k}={v!r}" for k, v in list(event.arguments.items())[:4])
            print(self.paint(f"  ⚙ {event.tool}({arguments})", DIM))
        elif event.type == "tool_end":
            preview = event.result.replace("\n", " ")[:120]
            print(self.paint(f"  ↳ {preview}", DIM))
        elif event.type == "tool_error":
            print(self.paint(f"  ✗ {event.tool}: {event.result}", RED))
        elif event.type == "error":
            self._newline()
            print(self.paint(event.text, RED))
        elif event.type == "done":
            self._newline()

    def _newline(self) -> None:
        if self._in_text:
            print()
            self._in_text = False


async def confirm_in_terminal(title: str, detail: str) -> bool:
    """Ask the user to approve a dangerous tool call."""
    color = supports_color()
    banner = f"\n{YELLOW}⚠ {title}{RESET}" if color else f"\n! {title}"
    print(banner)
    if detail:
        print(f"{DIM}{detail}{RESET}" if color else detail)
    answer = await asyncio.to_thread(input, "  approve? [y/N] ")
    return answer.strip().lower() in {"y", "yes"}


async def watch_reminders(agent: Agent, printer: Printer) -> None:
    """Announce reminders as they come due."""
    while True:
        try:
            for reminder in agent.memory.due_reminders():
                print(printer.paint(f"\n⏰ {reminder.text}", YELLOW))
                agent.memory.mark_fired(reminder.id)
        except Exception:
            pass
        await asyncio.sleep(15)


def handle_command(line: str, agent: Agent, session_id: str, printer: Printer) -> bool:
    """Run a /command. Returns False when the user wants to quit."""
    command, _, argument = line[1:].strip().partition(" ")
    command = command.lower()

    if command in {"quit", "exit", "q"}:
        return False
    if command == "help":
        print(HELP)
    elif command == "tools":
        for tool_obj in sorted(agent.registry, key=lambda t: t.name):
            mark = printer.paint(" (asks first)", YELLOW) if tool_obj.dangerous else ""
            origin = f"{DIM}[{tool_obj.source}]{RESET}" if printer.color else f"[{tool_obj.source}]"
            print(f"  {printer.paint(tool_obj.name, BOLD)}{mark} {origin}\n    {tool_obj.description.splitlines()[0]}")
        if agent.settings.enable_web_search:
            print(f"  {printer.paint('web_search, web_fetch', BOLD)} (server-side)")
    elif command == "memory":
        facts = agent.memory.all_facts()
        print("\n".join(f"  {k}: {v}" for k, v in facts.items()) or "  (nothing yet)")
    elif command == "forget":
        print("  forgotten" if agent.memory.forget(argument) else "  no such fact")
    elif command == "reminders":
        pending = agent.memory.pending_reminders()
        print("\n".join(f"  [{r.id}] {r.text} - {r.as_dict()['due_at']}" for r in pending) or "  (none)")
    elif command == "clear":
        removed = agent.memory.clear_session(session_id)
        print(f"  cleared {removed} messages")
    elif command == "thinking":
        agent.settings.show_thinking = not agent.settings.show_thinking
        print(f"  reasoning display: {'on' if agent.settings.show_thinking else 'off'}")
    else:
        print(f"  unknown command: /{command}")
    return True


async def chat(settings: Settings | None = None, session_id: str = "cli") -> None:
    """Run the terminal chat loop."""
    settings = settings or Settings.from_env()
    agent = Agent(settings=settings)
    agent.set_confirm_handler(confirm_in_terminal)

    printer = Printer(color=supports_color())
    print(BANNER if printer.color else "Thursday at your service - /help for commands")
    print(f"{DIM}model {settings.model} · {len(agent.registry)} tools · session {session_id}{RESET}\n")

    watcher = asyncio.create_task(watch_reminders(agent, printer))
    try:
        while True:
            try:
                line = await asyncio.to_thread(input, printer.paint("You: ", GREEN))
            except (EOFError, KeyboardInterrupt):
                print()
                break

            line = line.strip()
            if not line:
                continue
            if line.startswith("/"):
                if not handle_command(line, agent, session_id, printer):
                    break
                continue

            await agent.run(line, session_id=session_id, on_event=printer)
    finally:
        watcher.cancel()
        print(f"{DIM}Goodbye.{RESET}")


def main(settings: Settings | None = None, session_id: str = "cli") -> None:
    try:
        asyncio.run(chat(settings, session_id))
    except KeyboardInterrupt:  # pragma: no cover
        pass
