"""Command line entry point: `thursday <mode>`."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .config import Settings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="thursday",
        description="Thursday - a Jarvis-like assistant with voice, terminal and web front ends.",
    )
    parser.add_argument(
        "mode",
        nargs="?",
        default="chat",
        choices=["chat", "voice", "serve", "tools", "ask"],
        help="chat: terminal · voice: wake word + speech · serve: web UI · "
        "tools: list capabilities · ask: one-shot question",
    )
    parser.add_argument("question", nargs="*", help="the question, for `ask`")
    parser.add_argument("--model", help="override the model id")
    parser.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--session", default=None, help="conversation to continue")
    parser.add_argument("--host", help="web UI bind address")
    parser.add_argument("--port", type=int, help="web UI port")
    parser.add_argument("--no-confirm", action="store_true", help="do not ask before risky tools")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def apply_overrides(settings: Settings, args: argparse.Namespace) -> Settings:
    if args.model:
        settings.model = args.model
    if args.effort:
        settings.effort = args.effort
    if args.host:
        settings.host = args.host
    if args.port:
        settings.port = args.port
    if args.no_confirm:
        settings.require_confirmation = False
    return settings


def list_tools(settings: Settings) -> None:
    from .agent import server_tools
    from .tools import build_registry

    registry = build_registry(settings)
    print(f"{len(registry)} local tools:\n")
    for tool_obj in sorted(registry, key=lambda t: (t.source, t.name)):
        flag = " [asks first]" if tool_obj.dangerous else ""
        summary = tool_obj.description.splitlines()[0]
        print(f"  {tool_obj.name}{flag}\n      {summary}\n      source: {tool_obj.source}")
    hosted = server_tools(settings)
    if hosted:
        print("\nserver-side tools: " + ", ".join(t["name"] for t in hosted))


async def ask_once(settings: Settings, question: str, session: str) -> int:
    from .agent import Agent
    from .cli import Printer, confirm_in_terminal, supports_color

    agent = Agent(settings=settings)
    agent.set_confirm_handler(confirm_in_terminal)
    printer = Printer(color=supports_color())
    await agent.run(question, session_id=session, on_event=printer)
    return 0


def run_voice(settings: Settings, session: str) -> int:
    from .agent import Agent
    from .voice.loop import VoiceLoop
    from .voice.stt import build_transcriber
    from .voice.tts import build_speaker

    transcriber = build_transcriber(settings.voice)
    if transcriber is None:
        print("Speech recognition is switched off (THURSDAY_STT_BACKEND=none).", file=sys.stderr)
        return 1

    agent = Agent(settings=settings, voice=True)
    speaker = build_speaker(settings.voice)

    def show(who: str, text: str) -> None:
        print(f"{'You' if who == 'you' else 'Thursday'}: {text}")

    loop = VoiceLoop(agent, transcriber, speaker, session_id=session, on_transcript=show)
    wake = ", ".join(settings.voice.wake_words)
    print(f"Listening. Say \"{wake}\" to wake me, Ctrl-C to stop.")
    try:
        asyncio.run(loop.run())
    except KeyboardInterrupt:
        print("\nStanding by.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    settings = apply_overrides(Settings.from_env(), args)
    settings.ensure_dirs()

    if args.mode == "tools":
        list_tools(settings)
        return 0
    if args.mode == "serve":
        from .server import serve

        serve(settings)
        return 0
    if args.mode == "voice":
        return run_voice(settings, args.session or "voice")
    if args.mode == "ask":
        question = " ".join(args.question).strip()
        if not question:
            print("usage: thursday ask <question>", file=sys.stderr)
            return 2
        return asyncio.run(ask_once(settings, question, args.session or "cli"))

    from .cli import main as chat_main

    chat_main(settings, args.session or "cli")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
