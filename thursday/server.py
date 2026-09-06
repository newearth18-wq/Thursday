"""FastAPI front end: a browser UI over a WebSocket.

The page streams the same events the CLI renders, and uses the browser's own
Web Speech API for microphone input and speech output, so the web UI needs no
audio stack on the server.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any

from .agent import Agent
from .config import Settings
from .events import Event
from .auth import COOKIE, Gate, ensure_token
from .identity import Doorman, Enrolment, MissingBackend, build_encoder, decode_data_url
from .drafts import DraftError, Outbox
from .memory import Memory
from .mood import MoodTracker
from .proactive import Proactive
from .permissions import Policy
from .persona import system_prompt
from .settings_store import describe as describe_settings
from .settings_store import update as update_settings
from .settings_store import validate as validate_settings

WEB_DIR = Path(__file__).parent / "web"

# Imported at module scope because FastAPI resolves route annotations (such as
# `websocket: WebSocket`) against this module's globals.
try:
    from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
    from fastapi.responses import HTMLResponse, JSONResponse

    FASTAPI_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on the install
    FASTAPI_AVAILABLE = False

LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}

ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#02060c"/>
  <circle cx="256" cy="256" r="180" fill="none" stroke="#5eeaff" stroke-width="10"
          stroke-dasharray="330 90"/>
  <circle cx="256" cy="256" r="130" fill="none" stroke="#5eeaff" stroke-width="6" opacity=".6"/>
  <circle cx="256" cy="256" r="86" fill="#ffb347" opacity=".35"/>
  <circle cx="256" cy="256" r="46" fill="#fff6e6"/>
</svg>"""

# An assistant whose answers come live over a socket gains nothing from
# caching them, and a stale shell is worse than a slow one. This exists so the
# page is installable, and gets out of the way otherwise.
SERVICE_WORKER = """\
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
"""


def is_local(client_host: str | None) -> bool:
    """Whether a request came from this machine.

    Settings carry API keys, so only a local browser may change them unless
    the operator has explicitly opened that up.
    """
    if os.environ.get("THURSDAY_ALLOW_REMOTE_CONFIG", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    return (client_host or "") in LOOPBACK


ALLOWED_MEDIA = {"image/png", "image/jpeg", "image/gif", "image/webp"}
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5_000_000


def _backend_state(modality: str) -> dict[str, Any]:
    """Whether the model for a modality is installed, and why not if it isn't."""
    try:
        build_encoder(modality)
    except MissingBackend as exc:
        return {"available": False, "detail": str(exc)}
    except Exception as exc:  # pragma: no cover - a model that fails to load
        return {"available": False, "detail": str(exc)}
    return {"available": True, "detail": ""}


def parse_attachments(raw: Any) -> list[tuple[str, str]]:
    """Validate the browser's image attachments into (media_type, base64) pairs.

    Anything unrecognised is dropped rather than forwarded - the payload comes
    from the page, so it does not get to choose what we send to the API.
    """
    if not isinstance(raw, list):
        return []
    images: list[tuple[str, str]] = []
    for item in raw[:MAX_IMAGES]:
        if not isinstance(item, dict):
            continue
        media_type = item.get("media_type")
        data = item.get("data")
        if media_type not in ALLOWED_MEDIA or not isinstance(data, str):
            continue
        # base64 inflates by 4/3; check the decoded size.
        if len(data) * 3 // 4 > MAX_IMAGE_BYTES:
            continue
        images.append((media_type, data))
    return images


def create_app(settings: Settings | None = None) -> Any:
    """Build the FastAPI app that serves the browser UI."""
    if not FASTAPI_AVAILABLE:
        raise RuntimeError("fastapi is not installed; run: pip install 'thursday[web]'")

    # Held in a cell so a settings change can swap it without restarting.
    state: dict[str, Settings] = {"settings": settings or Settings.from_env()}

    def current() -> Settings:
        return state["settings"]

    boot = state["settings"]
    gate = Gate(token=os.environ.get("THURSDAY_ACCESS_TOKEN", "").strip(), mode=boot.auth)
    if gate.mode != "off" and not gate.token:
        gate.token, made = ensure_token()
        if made:
            print(f"\n  access token: {gate.token}\n  (needed from other machines; change it under Config)\n")
    enrolment = Enrolment.load(boot.enrolment_path)

    def client_host(request: Any) -> str | None:
        return request.client.host if request.client else None

    def guard(request: Any) -> bool:
        """Whether this request may proceed."""
        return gate.allows(client_host(request), request.cookies.get(COOKIE))

    app = FastAPI(title="Thursday", version="0.1.0")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> Any:
        return HTMLResponse((WEB_DIR / "index.html").read_text(encoding="utf-8"))

    @app.get("/manifest.webmanifest")
    async def manifest() -> Any:
        """Lets a phone install Thursday to its home screen."""
        name = current().assistant_name
        return JSONResponse(
            {
                "name": name,
                "short_name": name,
                "description": f"{name}, your assistant",
                "start_url": "/",
                "display": "standalone",
                "orientation": "any",
                "background_color": "#02060c",
                "theme_color": "#02060c",
                "icons": [
                    {
                        "src": "/icon.svg",
                        "sizes": "any",
                        "type": "image/svg+xml",
                        "purpose": "any maskable",
                    }
                ],
            },
            media_type="application/manifest+json",
        )

    @app.get("/icon.svg")
    async def icon() -> Any:
        """The home-screen icon: the reactor, drawn small."""
        return HTMLResponse(ICON_SVG, media_type="image/svg+xml")

    @app.get("/sw.js")
    async def service_worker() -> Any:
        """A deliberately minimal worker - enough to install, no stale caching."""
        return HTMLResponse(SERVICE_WORKER, media_type="application/javascript")

    # ------------------------------------------------------------- settings

    @app.get("/api/settings")
    async def read_settings(request: Request) -> Any:
        local = is_local(request.client.host if request.client else None)
        return JSONResponse(
            {
                **describe_settings(),
                "editable": local,
                "path": str(current().settings_path),
                "note": "" if local else "settings can only be changed from this machine",
            }
        )

    @app.post("/api/settings")
    async def write_settings(request: Request) -> Any:
        if not is_local(request.client.host if request.client else None):
            return JSONResponse(
                {"error": "settings can only be changed from this machine"}, status_code=403
            )
        try:
            changes = await request.json()
        except Exception:
            return JSONResponse({"error": "expected a JSON object"}, status_code=400)
        if not isinstance(changes, dict):
            return JSONResponse({"error": "expected a JSON object"}, status_code=400)

        problems = validate_settings(changes)
        if problems:
            return JSONResponse({"error": "; ".join(problems), "problems": problems}, status_code=400)

        update_settings(changes)
        # Rebuild so the next connection - and the status endpoint - see it.
        state["settings"] = Settings.from_env()
        return JSONResponse({**describe_settings(), "saved": True, "editable": True})

    @app.post("/api/settings/test")
    async def test_provider(request: Request) -> Any:
        """Check whether a backend is reachable with what is configured now."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str((body or {}).get("provider") or current().provider)

        from .providers import ProviderError, build_provider

        try:
            provider = build_provider(name, base_url=current().base_url or None)
        except ProviderError as exc:
            return JSONResponse({"provider": name, "ok": False, "detail": str(exc)})
        try:
            ok, detail = await provider.available()
            models = await provider.list_models() if ok else []
        except Exception as exc:
            ok, detail, models = False, str(exc), []
        finally:
            await provider.close()
        return JSONResponse({"provider": name, "ok": ok, "detail": detail, "models": models[:50]})

    @app.get("/api/auth")
    async def auth_state(request: Request) -> Any:
        """What the page needs to know before it tries to connect."""
        return JSONResponse(
            {
                "required": gate.needs_token(client_host(request)),
                "authenticated": guard(request),
                "identity": Doorman(policy=current().identity, enrolment=enrolment).policy,
                "enrolled": enrolment.summary(),
            }
        )

    @app.post("/api/login")
    async def login(request: Request) -> Any:
        try:
            body = await request.json()
        except Exception:
            body = {}
        host = client_host(request)
        if gate.locked_out(host):
            return JSONResponse({"error": "too many attempts; wait a few minutes"}, status_code=429)

        session = gate.login(str((body or {}).get("token") or ""), host)
        if session is None:
            return JSONResponse({"error": "that token is not right"}, status_code=401)

        response = JSONResponse({"ok": True})
        response.set_cookie(COOKIE, session, httponly=True, samesite="lax", max_age=30 * 86400)
        return response

    @app.post("/api/logout")
    async def logout(request: Request) -> Any:
        gate.logout(request.cookies.get(COOKIE))
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE)
        return response

    # ------------------------------------------------------------- identity

    @app.get("/api/identity")
    async def identity_state(request: Request) -> Any:
        if not guard(request):
            return JSONResponse({"error": "not authorised"}, status_code=401)
        doorman = Doorman(policy=current().identity, enrolment=enrolment)
        return JSONResponse(
            {
                "policy": doorman.policy,
                "enforced": doorman.enforced(),
                "people": enrolment.summary(),
                "backends": {
                    modality: _backend_state(modality) for modality in ("face", "voice")
                },
            }
        )

    @app.post("/api/identity/enrol")
    async def enrol(request: Request) -> Any:
        """Register a face for someone. Only from this machine."""
        if not guard(request) or not is_local(client_host(request)):
            return JSONResponse({"error": "enrolment is only allowed from this machine"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str((body or {}).get("name") or "").strip()
        image = str((body or {}).get("image") or "")
        if not name or not image:
            return JSONResponse({"error": "a name and an image are needed"}, status_code=400)

        try:
            encoder = build_encoder("face")
            embedding = encoder.encode(decode_data_url(image))
        except MissingBackend as exc:
            return JSONResponse({"error": str(exc)}, status_code=501)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        samples = enrolment.add(name, "face", embedding)
        return JSONResponse({"ok": True, "name": name, "samples": samples, "people": enrolment.summary()})

    @app.post("/api/identity/verify")
    async def verify(request: Request) -> Any:
        if not guard(request):
            return JSONResponse({"error": "not authorised"}, status_code=401)
        try:
            body = await request.json()
        except Exception:
            body = {}
        image = str((body or {}).get("image") or "")
        if not image:
            return JSONResponse({"error": "an image is needed"}, status_code=400)

        try:
            encoder = build_encoder("face")
            embedding = encoder.encode(decode_data_url(image))
        except MissingBackend as exc:
            return JSONResponse({"error": str(exc)}, status_code=501)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        match = enrolment.identify(embedding, "face")
        return JSONResponse(match.as_dict())

    @app.post("/api/identity/forget")
    async def forget(request: Request) -> Any:
        if not guard(request) or not is_local(client_host(request)):
            return JSONResponse({"error": "only allowed from this machine"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str((body or {}).get("name") or "").strip()
        removed = enrolment.forget(name, str((body or {}).get("modality") or ""))
        return JSONResponse({"ok": removed, "people": enrolment.summary()})

    @app.get("/api/permissions")
    async def permissions(request: Request) -> Any:
        """What Thursday may do to this machine, and what it has tried."""
        if not guard(request):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
        settings = current()
        policy = Policy.from_settings(settings)
        memory = Memory(settings.db_path)
        try:
            recent = memory.access_log(limit=60)
            summary = memory.access_summary()
        finally:
            memory.close()
        return JSONResponse(
            {
                **policy.describe(),
                "workspace": str(policy.workspace),
                "config": [str(path) for path in settings.permission_paths],
                "recent": recent,
                "summary": summary,
            }
        )

    def _outbox(settings: Settings) -> Any:
        return Outbox(Memory(settings.db_path), out_dir=settings.data_dir / "invites")

    @app.get("/api/drafts")
    async def read_drafts(request: Request) -> Any:
        """What Thursday has written and is waiting on you for."""
        if not guard(request):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
        outbox = _outbox(current())
        try:
            drafts = outbox.list()
        finally:
            outbox.memory.close()
        return JSONResponse(
            {
                "count": len(drafts),
                "waiting": sum(1 for draft in drafts if draft.status == "draft"),
                "drafts": [draft.as_dict() for draft in drafts],
            }
        )

    @app.post("/api/drafts/{draft_id}/{decision}")
    async def decide_draft(request: Request, draft_id: str, decision: str) -> Any:
        """Approve, send or discard one draft.

        Approval lives here rather than in a tool because a person has to be
        the one who does it - and, like settings, it is refused from anywhere
        but this machine, so a stolen session cannot post your mail.
        """
        if not guard(request):
            return JSONResponse({"error": "unauthorised"}, status_code=401)
        if not is_local(client_host(request)):
            return JSONResponse(
                {"error": "drafts can only be approved from this machine"}, status_code=403
            )
        if decision not in {"approve", "send", "discard"}:
            return JSONResponse({"error": f"unknown decision {decision}"}, status_code=400)

        outbox = _outbox(current())
        try:
            if decision == "approve":
                return JSONResponse({"draft": outbox.approve(draft_id).as_dict()})
            if decision == "discard":
                return JSONResponse({"draft": outbox.discard(draft_id).as_dict()})
            return JSONResponse({"sent": outbox.send(draft_id)})
        except DraftError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        finally:
            outbox.memory.close()

    @app.get("/api/status")
    async def status() -> Any:
        agent = Agent(settings=current())
        default = agent.profiles[agent.router.default_name]
        return JSONResponse(
            {
                "name": current().assistant_name,
                "provider": agent.provider_name_for(default),
                "model": agent.model_for(default),
                "profile": default.name,
                "routing": agent.router.mode,
                "profiles": [
                    {
                        "name": profile.name,
                        "description": profile.description,
                        "provider": agent.provider_name_for(profile),
                        "model": agent.model_for(profile),
                    }
                    for profile in agent.profiles.values()
                ],
                "tools": [
                    {"name": t.name, "description": t.description, "dangerous": t.dangerous,
                     "source": t.source}
                    for t in sorted(agent.registry, key=lambda t: t.name)
                ],
                "web_search": current().enable_web_search,
            }
        )

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        host = websocket.client.host if websocket.client else None
        if not gate.allows(host, websocket.cookies.get(COOKIE)):
            await websocket.send_text(json.dumps({"type": "unauthorised"}))
            await websocket.close(code=4401)
            return

        session_id = websocket.query_params.get("session") or f"web-{uuid.uuid4().hex[:8]}"
        settings = current()   # this connection's snapshot
        agent = Agent(settings=settings)
        await agent.start()

        # Pending confirmations, keyed by request id, resolved by the browser.
        pending: dict[str, asyncio.Future[bool]] = {}

        async def confirm(title: str, detail: str) -> bool:
            request_id = uuid.uuid4().hex
            future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
            pending[request_id] = future
            await websocket.send_text(
                json.dumps(
                    {"type": "confirm", "id": request_id, "title": title, "detail": detail}
                )
            )
            try:
                return await asyncio.wait_for(future, timeout=300)
            except asyncio.TimeoutError:
                return False
            finally:
                pending.pop(request_id, None)

        agent.set_confirm_handler(confirm)

        mood = MoodTracker(settings.assistant_name)

        async def on_event(event: Event) -> None:
            await websocket.send_text(json.dumps(event.as_dict(), ensure_ascii=False))
            # The page draws the state as a HUD readout and as the avatar's
            # face, so it comes from here rather than being guessed there.
            changed = mood.update(event)
            if changed is not None:
                await websocket.send_text(json.dumps(changed.as_dict(), ensure_ascii=False))

        async def settle() -> None:
            """Drift back to calm after a spell of quiet."""
            while True:
                await asyncio.sleep(20)
                if agent.busy or turns.qsize():
                    continue
                if mood.state.mood in {"pleased", "concerned", "apologetic"}:
                    resting = mood.idle()
                    if resting is not None:
                        try:
                            await websocket.send_text(
                                json.dumps(resting.as_dict(), ensure_ascii=False)
                            )
                        except Exception:
                            return

        async def announce(kind: str, text: str) -> None:
            """Reminders and scheduled routines, pushed to the page."""
            await websocket.send_text(
                json.dumps({"type": "proactive", "kind": kind, "text": text}, ensure_ascii=False)
            )

        proactive = Proactive(agent, announce=announce, on_event=on_event)

        # Turns run in a worker so the receive loop stays free - a confirmation
        # reply arrives *while* the turn that asked for it is still waiting.
        turns: asyncio.Queue[tuple[str, bool, list[tuple[str, str]], str]] = asyncio.Queue()

        async def worker() -> None:
            while True:
                text, spoken, images, profile = await turns.get()
                started = mood.start_turn(text)
                if started is not None:
                    await websocket.send_text(json.dumps(started.as_dict(), ensure_ascii=False))
                try:
                    # Spoken input gets the shorter, markdown-free persona.
                    if spoken != agent.voice:
                        agent.voice = spoken
                        agent.system = system_prompt(settings, voice=spoken)
                    await agent.run(
                        text,
                        session_id=session_id,
                        on_event=on_event,
                        images=images or None,
                        profile=profile or None,
                    )
                except Exception as exc:  # one bad turn must not drop the socket
                    await websocket.send_text(
                        json.dumps({"type": "error", "text": f"{type(exc).__name__}: {exc}"})
                    )
                finally:
                    turns.task_done()

        reminder_task = proactive.start()
        worker_task = asyncio.create_task(worker())
        settle_task = asyncio.create_task(settle())
        default_profile = agent.profiles[agent.router.default_name]
        await websocket.send_text(
            json.dumps(
                {
                    "type": "ready",
                    "session": session_id,
                    "name": settings.assistant_name,
                    "wake_words": list(settings.voice.wake_words),
                    "provider": agent.provider_name_for(default_profile),
                    "model": agent.model_for(default_profile),
                    "routing": agent.router.mode,
                    "profiles": [
                        {
                            "name": profile.name,
                            "description": profile.description,
                            "provider": agent.provider_name_for(profile),
                            "model": agent.model_for(profile),
                        }
                        for profile in agent.profiles.values()
                    ],
                }
            )
        )

        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = {"type": "message", "text": raw}

                kind = payload.get("type", "message")
                if kind == "confirm_response":
                    future = pending.get(payload.get("id", ""))
                    if future is not None and not future.done():
                        future.set_result(bool(payload.get("approved")))
                    continue
                if kind == "cancel":
                    stopped = agent.cancel()
                    await websocket.send_text(
                        json.dumps({"type": "cancel_ack", "stopped": stopped})
                    )
                    continue
                if kind == "clear":
                    agent.memory.clear_session(session_id)
                    await websocket.send_text(json.dumps({"type": "cleared"}))
                    continue

                images = parse_attachments(payload.get("images"))
                text = (payload.get("text") or "").strip()
                # The page may name a profile; an unknown one falls through to
                # the router rather than erroring the turn.
                requested = str(payload.get("profile") or "").strip().lower()
                profile = requested if requested in agent.profiles else ""
                if text or images:
                    await turns.put(
                        (
                            text or "What am I looking at?",
                            bool(payload.get("voice")),
                            images,
                            profile,
                        )
                    )
        except WebSocketDisconnect:
            pass
        finally:
            reminder_task.cancel()
            worker_task.cancel()
            settle_task.cancel()
            await agent.close()

    return app


def serve(settings: Settings | None = None) -> None:
    """Run the web UI."""
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("uvicorn is not installed; run: pip install 'thursday[web]'") from exc

    settings = settings or Settings.from_env()
    print(f"Thursday is listening on http://{settings.host}:{settings.port}")
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="warning")
