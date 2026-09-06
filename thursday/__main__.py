"""Command line entry point: `thursday <mode>`."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
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
        choices=[
            "chat", "voice", "serve", "tools", "ask",
            "providers", "profiles", "models", "usage", "config", "service",
            "audit", "permissions", "mcp", "watching", "pair", "vault",
        ],
        help="chat: terminal · voice: wake word + speech · serve: web UI · "
        "tools: list capabilities · ask: one-shot question · "
        "providers: which backends are reachable · profiles: task profiles · "
        "models: models a provider offers · usage: tokens and cost · "
        "config: current settings and where each came from · "
        "service: run in the background from login · "
        "audit: what has touched this machine · permissions: what it may do · "
        "mcp: serve Thursday's memory to other apps over MCP · "
        "watching: what it is keeping an eye on · "
        "pair: a QR code that puts it on your phone · "
        "vault: your Obsidian vault, and how connected it is",
    )
    parser.add_argument("question", nargs="*", help="the question, for `ask`")
    parser.add_argument("--model", help="override the model id")
    parser.add_argument(
        "--provider",
        help="backend to use: anthropic, openai, gemini, groq, openrouter, "
        "deepseek, mistral, xai, together, ollama, lmstudio, llamacpp, vllm, custom",
    )
    parser.add_argument("--base-url", help="endpoint for a custom OpenAI-compatible server")
    parser.add_argument("--profile", help="profile to start pinned to")
    parser.add_argument(
        "--routing",
        choices=["off", "keyword", "llm"],
        help="how a profile is chosen per turn",
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="shorthand for --provider ollama: nothing leaves this machine",
    )
    parser.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--session", default=None, help="conversation to continue")
    parser.add_argument("--days", type=int, default=7, help="window for `usage`")
    parser.add_argument("--apply", action="store_true", help="`service`: actually enable it")
    parser.add_argument("--remove", action="store_true", help="`service`: uninstall it")
    parser.add_argument("--host", help="web UI bind address")
    parser.add_argument("--port", type=int, help="web UI port")
    parser.add_argument("--no-confirm", action="store_true", help="do not ask before risky tools")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def apply_overrides(settings: Settings, args: argparse.Namespace) -> Settings:
    if args.local:
        settings.provider = "ollama"
    if args.provider:
        settings.provider = args.provider.strip().lower()
    if args.base_url:
        settings.base_url = args.base_url
    if args.profile:
        settings.profile = args.profile.strip().lower()
    if args.routing:
        settings.routing = args.routing
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


def list_providers(settings: Settings) -> None:
    """Show which backends are usable right now."""
    from .cli import check_providers
    from .providers import PRESETS

    for name, ok, detail in asyncio.run(check_providers(settings)):
        mark = "ok" if ok else "--"
        preset = PRESETS.get(name)
        kind = "local" if preset and preset.local else "hosted"
        print(f"[{mark}] {name:12} {kind:7} {detail}")
    print("\nAnything else that speaks the OpenAI API: --provider custom --base-url URL")


def list_profiles(settings: Settings) -> None:
    """Show the task profiles and what each one runs on."""
    from .agent import Agent

    agent = Agent(settings=settings)
    for profile in agent.profiles.values():
        marker = "*" if profile.name == agent.router.default_name else " "
        print(f"{marker} {profile.name:9} {agent.provider_name_for(profile)}/{agent.model_for(profile)}")
        if profile.description:
            print(f"    {profile.description}")
        if profile.triggers:
            print(f"    triggers: {', '.join(profile.triggers)}")
    print(f"\nrouting: {agent.router.mode}   (* = default)")


def list_models(settings: Settings) -> None:
    """Ask a provider which models it can serve."""
    from .providers import build_provider

    async def fetch() -> list[str]:
        provider = build_provider(settings.provider, base_url=settings.base_url or None)
        try:
            return await provider.list_models()
        finally:
            await provider.close()

    models = asyncio.run(fetch())
    if not models:
        print(f"{settings.provider} returned no models (unreachable, or it does not list them)")
        return
    print(f"{len(models)} models on {settings.provider}:")
    for model in models:
        print(f"  {model}")


def show_audit(settings: Settings, limit: int = 40) -> None:
    """What has reached for this machine, and how it went."""
    from .memory import Memory

    memory = Memory(settings.db_path)
    rows = memory.access_log(limit)
    if not rows:
        print("nothing has touched the machine yet")
        return

    for row in rows:
        detail = f" — {row['reason']}" if row["reason"] else ""
        print(f"{row['when'][:19]}  {row['outcome']:<9} {row['tool']:<20} "
              f"{row['arguments'][:70]}{detail}")

    print("\nby tool:")
    for entry in memory.access_summary():
        print(f"  {entry['tool']:<22} {entry['outcome']:<10} {entry['count']}")


def show_pairing(settings: Settings, host: str = "", port: int = 0) -> int:
    """A QR code that points a phone at this machine, token and all."""
    from .auth import ensure_token
    from .pairing import PairingError, build, instructions, qr_lines

    token = os.environ.get("THURSDAY_ACCESS_TOKEN", "").strip()
    if not token and settings.auth != "off":
        token, made = ensure_token()
        if made:
            print("  (generated an access token for you)")

    try:
        pairing = build(host=host, port=port or settings.port, token=token)
    except PairingError as exc:
        print(f"  {exc}")
        return 1

    lines = qr_lines(pairing.link)
    print()
    for line in lines:
        print(f"  {line}")
    if lines:
        print()
    for line in instructions(pairing, bool(lines)):
        print(f"  {line}")
    print()
    if len(pairing.addresses) > 1:
        others = ", ".join(pairing.addresses[1:])
        print(f"  (other addresses on this machine: {others})")
    if settings.auth == "off":
        print("  Note: THURSDAY_AUTH is off, so anyone on this network can use it.")
    print("  Thursday must be running: thursday serve")
    print()
    return 0


def show_vault(settings: Settings) -> int:
    """How big the second brain is, and how much of it is adrift."""
    from .vault import Vault, VaultError

    if not settings.vault_path:
        print("  no vault set. Point THURSDAY_VAULT at your Obsidian folder -")
        print("  the one with .obsidian in it.")
        return 1
    try:
        facts = Vault(settings.vault_path).describe()
        adrift = Vault(settings.vault_path).orphans()
    except VaultError as exc:
        print(f"  {exc}")
        return 1

    print(f"  {facts['root']}")
    print(f"  {facts['notes']} notes · {facts['links']} links · {facts['tags']} tags")
    print(f"  {facts['connected']} connected · {facts['orphans']} adrift")
    for title in adrift[:10]:
        print(f"      {title}")
    if facts["orphans"]:
        print("  `thursday` then /connect finds links between them.")
    return 0


def show_watching(settings: Settings) -> None:
    """What Thursday is keeping an eye on."""
    from .memory import Memory
    from .watchers import Watch

    memory = Memory(settings.db_path)
    try:
        entries = Watch(memory).all()
    finally:
        memory.close()
    if not entries:
        print("  nothing - try \"tell me when a pdf lands in Downloads\"")
        return
    for entry in entries:
        state = "on " if entry["enabled"] else "off"
        does = "runs" if entry["action"] == "run" else "tells"
        print(f"  {state} {entry['name']:18} {entry['kind']:9} {entry['target'][:44]}")
        print(f"      {does}, every {int(entry['every_seconds'])}s")
        if entry["last_error"]:
            print(f"      last error: {entry['last_error'][:120]}")


def show_permissions(settings: Settings) -> None:
    """What Thursday may do to this machine."""
    from .permissions import Policy

    policy = Policy.from_settings(settings)
    rules = policy.describe()

    print(f"workspace: {settings.workspace}")
    print(f"protected path patterns: {rules['protected_paths']} "
          "(secrets, and my own settings, database and enrolment)")
    print(f"confirmations: {'on' if rules['confirmations'] else 'OFF'}\n")

    print("tools:")
    for name, rule in rules["tools"].items():
        print(f"  {name:<22} {rule}")
    if rules["denied_tools"]:
        print(f"\nswitched off: {', '.join(rules['denied_tools'])}")
    if rules["extra_readable"]:
        print(f"also readable: {', '.join(rules['extra_readable'])}")
    if rules["extra_writable"]:
        print(f"also writable: {', '.join(rules['extra_writable'])}")
    print(f"\nedit {settings.permission_paths[0]} to change this "
          "(see permissions.example.json)")


def manage_service(settings: Settings, apply: bool, remove: bool) -> int:
    """Install or remove the background service."""
    from .service import install, supported, uninstall

    if remove:
        print(uninstall())
        return 0

    ok, why = supported()
    if not ok:
        print(why, file=sys.stderr)
        return 1

    print(install(settings.assistant_name, apply=apply))
    if apply:
        print(f"\n{settings.assistant_name} will be at http://{settings.host}:{settings.port}")
    return 0


def show_config(settings: Settings) -> None:
    """Print every editable setting, its value, and where it came from."""
    from .settings_store import describe

    payload = describe()
    print(f"editable in the web UI, saved to {settings.settings_path}\n")
    for group in payload["groups"]:
        print(group)
        for entry in payload["fields"]:
            if entry["group"] != group:
                continue
            value = entry["value"] or "—"
            mark = {"settings": "*", "env": "e", "default": " "}.get(entry["source"], " ")
            print(f"  {mark} {entry['label']:24} {value:<28} {entry['key']}")
        print()
    print("* set in the web UI   e from the environment or .env   (blank) default")


def show_usage(settings: Settings, days: int = 7) -> None:
    """Report tokens and cost over the last few days."""
    import time

    from .memory import Memory
    from .pricing import format_cost

    memory = Memory(settings.db_path)
    since = time.time() - max(1, days) * 86400

    if not memory.usage_summary(since=since):
        print(f"nothing recorded in the last {days} day(s)")
        return

    for group in ("model", "profile", "provider"):
        rows = memory.usage_summary(since=since, group_by=group)
        if not rows:
            continue
        print(f"\nby {group}:")
        for row in rows:
            cost = format_cost(row["cost"]) + ("+" if row["partial"] else "")
            print(
                f"  {row['key']:28} {row['turns']:>4} turns  "
                f"{row['input_tokens']:>10,} in  {row['output_tokens']:>9,} out  {cost:>10}"
            )

    total = memory.spend_since(since)
    print(f"\nlast {days} day(s): {format_cost(total)}")
    print("(+ means some turns ran on a model with no price in the table)")


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
    await agent.start()
    printer = Printer(color=supports_color())
    try:
        await agent.run(question, session_id=session, on_event=printer)
    finally:
        await agent.close()
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
    if args.mode == "providers":
        list_providers(settings)
        return 0
    if args.mode == "profiles":
        list_profiles(settings)
        return 0
    if args.mode == "models":
        list_models(settings)
        return 0
    if args.mode == "usage":
        show_usage(settings, args.days)
        return 0
    if args.mode == "config":
        show_config(settings)
        return 0
    if args.mode == "service":
        return manage_service(settings, args.apply, args.remove)
    if args.mode == "audit":
        show_audit(settings, args.days * 10)
        return 0
    if args.mode == "permissions":
        show_permissions(settings)
        return 0
    if args.mode == "watching":
        show_watching(settings)
        return 0
    if args.mode == "pair":
        return show_pairing(settings, args.host, args.port)
    if args.mode == "vault":
        return show_vault(settings)
    if args.mode == "mcp":
        from .mcp_server import serve as serve_mcp

        # stdout belongs to the protocol from here on, so nothing is printed.
        serve_mcp(settings)
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
