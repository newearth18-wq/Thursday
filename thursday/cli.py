"""Terminal chat front end.

Plain ANSI - no extra dependencies, so `thursday chat` works on a fresh install.
"""

from __future__ import annotations

import asyncio
import signal
import sys
import time

from .agent import Agent
from .config import Settings
from .events import Event
from .proactive import Proactive

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
  /profile [name]    show or pin the profile (empty name unpins)
  /profiles          list profiles and the model behind each
  /providers         which backends are reachable right now
  /mcp               MCP servers and what they contributed
  /tools             list the tools I can use
  /see <path> [ask]  show me an image and ask about it
  /memory            show what I remember about you
  /forget <key>      make me forget one thing
  /reminders         list pending reminders
  /drafts            mail and diary entries waiting for you
  /approve <id>      approve a draft, then /send it
  /send <id>         send a draft you have approved
  /discard <id>      throw a draft away
  /usage [days]      tokens and cost, by model
  /audit [n]         what reached for this machine, and what happened
  /permissions       what Thursday may do to this machine
  /routines          list saved routines
  /clear             wipe this session's history
  /thinking          toggle showing my reasoning
  /quit              exit

Ctrl-C stops the answer in progress; Ctrl-D leaves.
"""


def supports_color() -> bool:
    return sys.stdout.isatty()


class Printer:
    """Prints agent events, keeping the streamed reply on one flowing line."""

    def __init__(self, color: bool = True, show_profile: bool = True) -> None:
        self.color = color
        self.show_profile = show_profile
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
        elif event.type == "profile":
            if self.show_profile:
                data = event.data
                self._newline()
                print(
                    self.paint(
                        f"  ▸ {data['profile']} · {data['provider']}/{data['model']} ({data['reason']})",
                        DIM,
                    )
                )
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
        elif event.type == "usage":
            if event.text:
                data = event.data
                self._newline()
                print(
                    self.paint(
                        f"  ∑ {data['input']:,} in / {data['output']:,} out"
                        + (f" / {data['cached']:,} cached" if data["cached"] else "")
                        + f" · {event.text}",
                        DIM,
                    )
                )
        elif event.type == "cancelled":
            self._newline()
            print(self.paint("  ⏹ stopped", YELLOW))
        elif event.type == "done":
            self._newline()

    def _newline(self) -> None:
        if self._in_text:
            print()
            self._in_text = False


def load_image(agent: Agent, path: str) -> tuple[str, str]:
    """Read an image off disk for attaching to a turn."""
    from .tools.vision import encode
    from .tools.files import resolve

    return encode(resolve(agent.context, path))


async def confirm_in_terminal(title: str, detail: str) -> bool:
    """Ask the user to approve a dangerous tool call."""
    color = supports_color()
    banner = f"\n{YELLOW}⚠ {title}{RESET}" if color else f"\n! {title}"
    print(banner)
    if detail:
        print(f"{DIM}{detail}{RESET}" if color else detail)
    answer = await asyncio.to_thread(input, "  approve? [y/N] ")
    return answer.strip().lower() in {"y", "yes"}


async def check_providers(settings: Settings) -> list[tuple[str, bool, str]]:
    """Ask every known backend whether it is usable right now."""
    from .providers import build_provider, has_credentials, key_env_for, provider_names

    results: list[tuple[str, bool, str]] = []
    for name in provider_names():
        if not has_credentials(name):
            results.append((name, False, f"{key_env_for(name)} is not set"))
            continue
        try:
            provider = build_provider(name, base_url=settings.base_url or None)
        except Exception as exc:
            results.append((name, False, str(exc)))
            continue
        try:
            ok, detail = await provider.available()
        except Exception as exc:
            ok, detail = False, str(exc)
        finally:
            await provider.close()
        results.append((name, ok, detail))
    return results


async def run_turn(
    agent: Agent,
    text: str,
    session_id: str,
    printer: Printer,
    images: list[tuple[str, str]] | None = None,
) -> str:
    """Run one turn with Ctrl-C wired to stopping it rather than quitting.

    A long answer from the `deep` profile should be interruptible the way any
    other long-running terminal command is.
    """
    loop = asyncio.get_running_loop()
    turn = asyncio.ensure_future(
        agent.run(text, session_id=session_id, on_event=printer, images=images)
    )

    def interrupt() -> None:
        if not agent.cancel():
            turn.cancel()

    try:
        loop.add_signal_handler(signal.SIGINT, interrupt)
    except (NotImplementedError, RuntimeError):  # Windows, or no running loop
        return await turn

    try:
        return await turn
    except asyncio.CancelledError:
        return ""
    finally:
        try:
            loop.remove_signal_handler(signal.SIGINT)
        except (NotImplementedError, RuntimeError):
            pass


def build_proactive(agent: Agent, printer: Printer) -> Proactive:
    """Reminders and scheduled routines, printed as they happen."""

    async def announce(kind: str, text: str) -> None:
        colour = {"reminder": YELLOW, "schedule": CYAN}.get(kind, GREEN)
        mark = {"reminder": "⏰", "schedule": "▶", "result": "↳"}.get(kind, "·")
        print(printer.paint(f"\n{mark} {text}", colour))

    return Proactive(agent, announce=announce)


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
    elif command == "profile":
        if not argument.strip():
            agent.router.pin(None)
            print("  routing is back to automatic")
        else:
            try:
                pinned = agent.router.pin(argument.strip())
            except KeyError:
                print(f"  no profile called {argument.strip()!r}; try /profiles")
            else:
                print(
                    f"  pinned to {printer.paint(pinned.name, BOLD)} "
                    f"({agent.provider_name_for(pinned)}/{agent.model_for(pinned)})"
                )
    elif command == "profiles":
        for profile in agent.profiles.values():
            marker = "*" if profile.name == agent.router.pinned else " "
            head = f"{marker} {printer.paint(profile.name, BOLD)}"
            print(f"{head} - {agent.provider_name_for(profile)}/{agent.model_for(profile)}")
            if profile.description:
                print(f"    {profile.description}")
            limits = []
            if profile.tools:
                limits.append(f"only {len(profile.tools)} tools")
            if profile.deny_tools:
                limits.append(f"blocks {', '.join(profile.deny_tools[:4])}")
            if not profile.web_search:
                limits.append("no web search")
            if limits:
                print(printer.paint(f"    {'; '.join(limits)}", DIM))
    elif command == "providers":
        results = asyncio.run(check_providers(agent.settings))
        for name, ok, detail in results:
            mark = printer.paint("ok", GREEN) if ok else printer.paint("--", RED)
            print(f"  [{mark}] {name}{f' - {detail}' if detail else ''}")
    elif command == "memory":
        facts = agent.memory.all_facts()
        print("\n".join(f"  {k}: {v}" for k, v in facts.items()) or "  (nothing yet)")
    elif command == "forget":
        print("  forgotten" if agent.memory.forget(argument) else "  no such fact")
    elif command == "reminders":
        pending = agent.memory.pending_reminders()
        lines = []
        for reminder in pending:
            detail = reminder.as_dict()
            repeat = f" (every {round(reminder.repeat_seconds / 3600)}h)" if reminder.repeat_seconds else ""
            lines.append(f"  [{reminder.id}] {reminder.text} - {detail['due_at']}{repeat}")
        print("\n".join(lines) or "  (none)")
    elif command == "mcp":
        rows = agent.mcp.status()
        if not rows:
            print("  no MCP servers configured (see mcp.example.json)")
        for row in rows:
            mark = printer.paint("ok", GREEN) if row["connected"] else printer.paint("--", RED)
            detail = f"{row['tools']} tools" if row["connected"] else row["problem"]
            print(f"  [{mark}] {row['name']} ({row['kind']}) - {detail}")
    elif command == "usage":
        from .pricing import format_cost

        try:
            days = max(1, int(argument.strip() or 1))
        except ValueError:
            days = 1
        since = time.time() - days * 86400
        rows = agent.memory.usage_summary(since=since)
        if not rows:
            print(f"  nothing recorded in the last {days} day(s)")
        else:
            print(f"  last {days} day(s):")
            total = 0.0
            for row in rows:
                cost = format_cost(row["cost"]) + ("+" if row["partial"] else "")
                print(
                    f"    {row['key']:26} {row['turns']:>4} turns  "
                    f"{row['input_tokens']:>9,} in  {row['output_tokens']:>8,} out  {cost:>10}"
                )
                total += row["cost"] or 0.0
            print(f"    {'total':26} {'':>4}        {'':>9}     {'':>8}      {format_cost(total):>10}")
    elif command == "audit":
        try:
            count = max(1, int(argument.strip() or 20))
        except ValueError:
            count = 20
        rows = agent.memory.access_log(count)
        if not rows:
            print("  nothing has touched the machine yet")
        for row in rows:
            colour = {"denied": RED, "failed": RED, "confirmed": YELLOW}.get(row["outcome"], DIM)
            detail = f" — {row['reason']}" if row["reason"] else ""
            outcome = printer.paint(f"{row['outcome']:<9}", colour)
            print(f"  {row['when'][11:19]} {outcome} {row['tool']} {row['arguments'][:60]}{detail}")
    elif command == "permissions":
        rules = agent.policy.describe()
        print(f"  {rules['protected_paths']} protected path patterns (secrets, and my own files)")
        print(f"  confirmations: {'on' if rules['confirmations'] else 'OFF'}")
        for name, rule in rules["tools"].items():
            colour = {"deny": RED, "confirm": YELLOW}.get(rule, GREEN)
            print(f"    {name:22} {printer.paint(rule, colour)}")
        if rules["extra_readable"]:
            print(f"  also readable: {', '.join(rules['extra_readable'])}")
        if rules["extra_writable"]:
            print(f"  also writable: {', '.join(rules['extra_writable'])}")
        if rules["denied_tools"]:
            print(f"  switched off: {', '.join(rules['denied_tools'])}")
    elif command in {"drafts", "approve", "send", "discard"}:
        from .drafts import DraftError, Outbox

        outbox = agent.context.state.get("outbox") or Outbox(
            agent.memory, out_dir=agent.settings.data_dir / "invites"
        )
        agent.context.state["outbox"] = outbox
        target = argument.strip()
        try:
            if command == "drafts" and not target:
                drafts = outbox.list()
                if not drafts:
                    print("  nothing waiting")
                for draft in drafts:
                    colour = {"draft": YELLOW, "approved": GREEN, "sent": DIM,
                              "failed": RED}.get(draft.status, DIM)
                    where = ", ".join(draft.to) or draft.location or "-"
                    print(f"  {printer.paint(draft.id, BOLD)} {printer.paint(draft.status, colour)}"
                          f"  {draft.kind:5} {draft.subject[:44]}  -> {where}")
                if drafts:
                    print(printer.paint("  /approve <id> then /send <id>", DIM))
            elif command == "drafts":
                draft = outbox.get(target)
                print(f"  {printer.paint(draft.subject, BOLD)}")
                for key, value in draft.as_dict(full=False).items():
                    if key not in {"subject", "id"}:
                        print(f"    {key:10} {value}")
                print()
                for line in draft.body.splitlines():
                    print(f"    {line}")
            elif command == "approve":
                draft = outbox.approve(target)
                print(printer.paint(f"  approved. /send {draft.id} to send it.", GREEN))
            elif command == "discard":
                outbox.discard(target)
                print(printer.paint("  thrown away", DIM))
            else:
                result = outbox.send(target)
                print(printer.paint(f"  {result}", GREEN))
        except DraftError as exc:
            print(printer.paint(f"  {exc}", RED))
    elif command == "routines":
        routines = agent.memory.list_routines()
        for routine in routines:
            print(f"  {printer.paint(routine['name'], BOLD)} (used {routine['uses']}x)")
            print(f"    {routine['instruction'][:160]}")
        if not routines:
            print("  (none yet - just tell me to remember a routine)")
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
    print(BANNER if printer.color else f"{settings.assistant_name} at your service - /help for commands")

    mcp_tools = await agent.start()
    for row in agent.mcp.status():
        if row["problem"]:
            print(f"{YELLOW}  MCP {row['name']}: {row['problem']}{RESET}")
    if mcp_tools:
        print(f"{DIM}  MCP added {len(mcp_tools)} tools{RESET}")
    default_profile = agent.profiles[agent.router.default_name]
    print(
        f"{DIM}{agent.provider_name_for(default_profile)}/{agent.model_for(default_profile)} · "
        f"{len(agent.profiles)} profiles ({agent.router.mode} routing) · "
        f"{len(agent.registry)} tools · session {session_id}{RESET}\n"
    )

    watcher = build_proactive(agent, printer).start()
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
            if line.startswith("/see "):
                path, _, question = line[5:].strip().partition(" ")
                try:
                    images = [load_image(agent, path)]
                except Exception as exc:
                    print(printer.paint(f"  {exc}", RED))
                    continue
                await run_turn(
                    agent,
                    question.strip() or "What am I looking at?",
                    session_id,
                    printer,
                    images=images,
                )
                continue

            if line.startswith("/"):
                if not handle_command(line, agent, session_id, printer):
                    break
                continue

            await run_turn(agent, line, session_id, printer)
    finally:
        watcher.cancel()
        await agent.close()
        print(f"{DIM}Goodbye.{RESET}")


def main(settings: Settings | None = None, session_id: str = "cli") -> None:
    try:
        asyncio.run(chat(settings, session_id))
    except KeyboardInterrupt:  # pragma: no cover
        pass
