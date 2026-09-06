"""Calendar, mail, background jobs and the browser."""

from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from thursday.config import Settings
from thursday.memory import Memory
from thursday.proactive import Proactive
from thursday.tools import ToolContext, ToolError, build_registry
from thursday.tools.calendar import Event, parse_ics, within
from thursday.tools.mail import Mailbox, decode, strip_html

ICS = """BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Standup
DTSTART;TZID=Asia/Bangkok:20260906T090000
DTEND;TZID=Asia/Bangkok:20260906T091500
LOCATION:Zoom
END:VEVENT
BEGIN:VEVENT
SUMMARY:Dentist\\, second floor
DTSTART:20260907T140000Z
DESCRIPTION:Bring the referral\\nand the card
END:VEVENT
BEGIN:VEVENT
SUMMARY:Public holiday
DTSTART;VALUE=DATE:20260908
END:VEVENT
END:VCALENDAR"""


# ---------------------------------------------------------------- calendar


def test_events_are_read_out_of_an_ics_feed():
    events = parse_ics(ICS)

    assert [event.summary for event in events] == ["Standup", "Dentist, second floor", "Public holiday"]
    assert events[0].location == "Zoom"


def test_escaped_text_is_unescaped():
    events = parse_ics(ICS)
    assert events[1].summary == "Dentist, second floor"
    assert "\n" in events[1].description


def test_all_day_events_are_recognised():
    holiday = parse_ics(ICS)[2]

    assert holiday.all_day is True
    assert "all day" in holiday.as_dict()["when"]


def test_timed_events_show_a_range():
    assert "09:00–09:15" in parse_ics(ICS)[0].as_dict()["when"]


def test_folded_lines_are_joined():
    """ICS wraps long lines with a leading space."""
    folded = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:A very long title that got\n  wrapped\nDTSTART:20260906T090000Z\nEND:VEVENT\nEND:VCALENDAR"
    assert parse_ics(folded)[0].summary == "A very long title that got wrapped"


def test_a_window_filters_and_sorts():
    events = parse_ics(ICS)
    start = datetime(2026, 9, 6).astimezone()

    assert len(within(events, start, start + timedelta(days=3))) == 3
    assert len(within(events, start, start + timedelta(hours=12))) == 1


def test_an_event_with_no_start_is_skipped():
    assert within([Event("mystery", None, None)], datetime.now().astimezone(),
                  datetime.now().astimezone() + timedelta(days=1)) == []


def test_rubbish_does_not_crash_the_parser():
    assert parse_ics("this is not a calendar") == []


def test_asking_with_no_calendar_configured_says_how_to_fix_it(tmp_path, monkeypatch):
    monkeypatch.delenv("THURSDAY_CALENDARS", raising=False)
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    with pytest.raises(ToolError, match="THURSDAY_CALENDARS"):
        asyncio.run(registry.call("whats_on", {}, context))


def test_a_calendar_file_on_disk_is_read(tmp_path, monkeypatch):
    feed = tmp_path / "cal.ics"
    feed.write_text(ICS, encoding="utf-8")
    monkeypatch.setenv("THURSDAY_CALENDARS", str(feed))

    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    result = asyncio.run(registry.call("whats_on", {"days": 400}, context))
    assert "Standup" in result


def test_a_calendar_over_http_is_read(tmp_path, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            return

        def do_GET(self):
            body = ICS.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/calendar")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("THURSDAY_CALENDARS", f"http://127.0.0.1:{server.server_address[1]}/cal.ics")

    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))
    try:
        result = asyncio.run(registry.call("whats_on", {"days": 400}, context))
    finally:
        server.shutdown()

    assert "Standup" in result


def test_an_unreachable_feed_is_reported_not_fatal(tmp_path, monkeypatch):
    monkeypatch.setenv("THURSDAY_CALENDARS", "http://127.0.0.1:9/none.ics")
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    result = asyncio.run(registry.call("whats_on", {}, context))
    assert "problems" in result


# -------------------------------------------------------------------- mail


def test_a_mailbox_needs_credentials(monkeypatch):
    for name in ("HOST", "USER", "PASSWORD"):
        monkeypatch.delenv(f"THURSDAY_IMAP_{name}", raising=False)

    mailbox = Mailbox.from_env()
    assert mailbox.configured is False
    with pytest.raises(ToolError, match="app password"):
        mailbox.connect()


def test_encoded_headers_are_decoded():
    assert decode("=?utf-8?B?4Lir4Lij4Li34Lit4LmA4Lib4LmI4Liy?=") == "หรือเป่า"
    assert decode(None) == ""
    assert decode("plain subject") == "plain subject"


def test_html_mail_becomes_readable_text():
    html = "<html><style>p{}</style><body><p>Hello &amp; welcome</p></body></html>"
    assert strip_html(html) == "Hello & welcome"


def test_the_mail_folder_defaults_to_the_inbox(monkeypatch):
    monkeypatch.delenv("THURSDAY_IMAP_FOLDER", raising=False)
    assert Mailbox.from_env().folder == "INBOX"


# -------------------------------------------------------------------- jobs


class FakeAgent:
    def __init__(self, memory, fails=False):
        self.memory = memory
        self.settings = Settings(plugin_dirs=())
        self.prompts: list[str] = []
        self.fails = fails

    async def run(self, text, session_id="s", on_event=None, profile=None, images=None):
        self.prompts.append(text)
        if self.fails:
            raise RuntimeError("the model gave up")
        return "Supplier B, at twelve thousand."


def test_a_job_is_queued_then_worked(tmp_path):
    memory = Memory(":memory:")
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=memory)

    queued = asyncio.run(
        registry.call(
            "start_job", {"title": "compare suppliers", "instruction": "Compare the quotes"}, context
        )
    )
    assert '"queued"' in queued

    agent = FakeAgent(memory)
    assert asyncio.run(Proactive(agent).work_a_job()) == "compare suppliers"
    assert "Compare the quotes" in agent.prompts[0]

    finished = memory.jobs()[0]
    assert finished["status"] == "done"
    assert "Supplier B" in finished["result"]


def test_a_job_that_fails_is_recorded_as_failed():
    memory = Memory(":memory:")
    memory.add_job("doomed", "do the impossible")

    asyncio.run(Proactive(FakeAgent(memory, fails=True)).work_a_job())

    assert memory.jobs()[0]["status"] == "failed"
    assert "gave up" in memory.jobs()[0]["result"]


def test_only_one_job_runs_at_a_time():
    """Two long jobs through one agent would tangle each other's context."""
    memory = Memory(":memory:")
    memory.add_job("first", "a")
    memory.add_job("second", "b")

    claimed = memory.next_job()
    assert claimed["title"] == "first"
    # The second is still queued, and the first is no longer claimable.
    assert memory.next_job()["title"] == "second"
    assert memory.next_job() is None


def test_a_job_cancelled_while_running_is_not_marked_done():
    memory = Memory(":memory:")
    job_id = memory.add_job("changed my mind", "do a thing")

    class Canceller(FakeAgent):
        async def run(self, text, **kwargs):
            memory.cancel_job(job_id)
            return "did it anyway"

    asyncio.run(Proactive(Canceller(memory)).work_a_job())
    assert memory.job(job_id)["status"] == "cancelled"


def test_jobs_stranded_by_a_crash_are_requeued():
    memory = Memory(":memory:")
    memory.add_job("interrupted", "a")
    memory.next_job()                       # now 'running', then the process dies

    assert Proactive(FakeAgent(memory)).recover_jobs() == [1]
    assert memory.jobs()[0]["status"] == "queued"


def test_nothing_queued_means_no_work():
    assert asyncio.run(Proactive(FakeAgent(Memory(":memory:"))).work_a_job()) is None


def test_a_job_needs_an_instruction(tmp_path):
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    with pytest.raises(ToolError, match="instruction"):
        asyncio.run(registry.call("start_job", {"title": "x", "instruction": "  "}, context))


def test_cancelling_a_finished_job_says_so(tmp_path):
    memory = Memory(":memory:")
    job_id = memory.add_job("done already", "x")
    memory.finish_job(job_id, "result")

    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=memory)

    assert "already finished" in asyncio.run(
        registry.call("cancel_job", {"job_id": job_id}, context)
    )


# ----------------------------------------------------------------- browser


def test_every_browser_action_asks_first(tmp_path):
    """A browser signed into your accounts can spend money."""
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)

    for name in ("browse", "browser_act", "browser_screenshot"):
        assert registry.get(name).dangerous is True, f"{name} must ask first"


def test_a_declined_browse_never_opens_anything(tmp_path):
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    async def refuse(title, detail):
        return False

    context.confirm = refuse

    with pytest.raises(ToolError, match="declined"):
        asyncio.run(registry.call("browse", {"url": "https://example.com"}, context))
    assert "browser" not in context.state or not context.state["browser"].open


def test_acting_before_opening_a_page_is_refused(tmp_path):
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    with pytest.raises(ToolError, match="no page is open"):
        asyncio.run(registry.call("browser_act", {"action": "click", "selector": "#go"}, context))


def test_a_bad_url_is_refused_before_a_browser_starts(tmp_path):
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    with pytest.raises(ToolError, match="must start with"):
        asyncio.run(registry.call("browse", {"url": "file:///etc/passwd"}, context))


def test_closing_a_browser_that_is_not_open(tmp_path):
    settings = Settings(workspace=tmp_path, plugin_dirs=())
    registry = build_registry(settings)
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    assert asyncio.run(registry.call("close_browser", {}, context)) == "no browser is open"
