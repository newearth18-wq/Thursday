"""FastAPI front end: a browser UI over a WebSocket.

The page streams the same events the CLI renders, and uses the browser's own
Web Speech API for microphone input and speech output, so the web UI needs no
audio stack on the server.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from .agent import Agent
from .config import Settings
from .events import Event
from .persona import system_prompt

WEB_DIR = Path(__file__).parent / "web"

# Imported at module scope because FastAPI resolves route annotations (such as
# `websocket: WebSocket`) against this module's globals.
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import HTMLResponse, JSONResponse

    FASTAPI_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on the install
    FASTAPI_AVAILABLE = False


def create_app(settings: Settings | None = None) -> Any:
    """Build the FastAPI app that serves the browser UI."""
    if not FASTAPI_AVAILABLE:
        raise RuntimeError("fastapi is not installed; run: pip install 'thursday[web]'")

    settings = settings or Settings.from_env()
    app = FastAPI(title="Thursday", version="0.1.0")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> Any:
        return HTMLResponse((WEB_DIR / "index.html").read_text(encoding="utf-8"))

    @app.get("/api/status")
    async def status() -> Any:
        agent = Agent(settings=settings)
        return JSONResponse(
            {
                "name": settings.assistant_name,
                "model": settings.model,
                "tools": [
                    {"name": t.name, "description": t.description, "dangerous": t.dangerous,
                     "source": t.source}
                    for t in sorted(agent.registry, key=lambda t: t.name)
                ],
                "web_search": settings.enable_web_search,
            }
        )

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        session_id = websocket.query_params.get("session") or f"web-{uuid.uuid4().hex[:8]}"
        agent = Agent(settings=settings)

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

        async def on_event(event: Event) -> None:
            await websocket.send_text(json.dumps(event.as_dict(), ensure_ascii=False))

        async def push_reminders() -> None:
            while True:
                try:
                    for reminder in agent.memory.due_reminders():
                        await websocket.send_text(
                            json.dumps({"type": "reminder", "text": reminder.text})
                        )
                        agent.memory.mark_fired(reminder.id)
                except Exception:
                    return
                await asyncio.sleep(15)

        # Turns run in a worker so the receive loop stays free - a confirmation
        # reply arrives *while* the turn that asked for it is still waiting.
        turns: asyncio.Queue[tuple[str, bool]] = asyncio.Queue()

        async def worker() -> None:
            while True:
                text, spoken = await turns.get()
                try:
                    # Spoken input gets the shorter, markdown-free persona.
                    if spoken != agent.voice:
                        agent.voice = spoken
                        agent.system = system_prompt(settings, voice=spoken)
                    await agent.run(text, session_id=session_id, on_event=on_event)
                except Exception as exc:  # one bad turn must not drop the socket
                    await websocket.send_text(
                        json.dumps({"type": "error", "text": f"{type(exc).__name__}: {exc}"})
                    )
                finally:
                    turns.task_done()

        reminder_task = asyncio.create_task(push_reminders())
        worker_task = asyncio.create_task(worker())
        await websocket.send_text(
            json.dumps({"type": "ready", "session": session_id, "model": settings.model})
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
                if kind == "clear":
                    agent.memory.clear_session(session_id)
                    await websocket.send_text(json.dumps({"type": "cleared"}))
                    continue

                text = (payload.get("text") or "").strip()
                if text:
                    await turns.put((text, bool(payload.get("voice"))))
        except WebSocketDisconnect:
            pass
        finally:
            reminder_task.cancel()
            worker_task.cancel()

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
