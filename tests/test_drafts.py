"""Thursday writes; you send.

The point of every test here is the same: nothing leaves the machine on
Thursday's own say-so.
"""

from __future__ import annotations

import asyncio
import smtplib
from datetime import datetime, timedelta

import pytest

from thursday.config import Settings
from thursday.drafts import Draft, DraftError, Mailer, Outbox, to_ics
from thursday.memory import Memory
from thursday.tools import ToolContext, ToolError, build_registry
from thursday.tools.timekeeping import parse_when


@pytest.fixture()
def outbox(tmp_path):
    return Outbox(Memory(":memory:"), out_dir=tmp_path / "invites")


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


@pytest.fixture()
def context(tmp_path, outbox):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=outbox.memory)
    context.state["outbox"] = outbox
    return context


# ------------------------------------------------------- the whole point


def test_a_draft_cannot_send_itself(outbox):
    draft = outbox.prepare(Draft(subject="Hello", body="hi", to=["them@example.com"]))

    with pytest.raises(DraftError, match="not been approved"):
        outbox.send(draft.id)


def test_the_send_tool_refuses_an_unapproved_draft(context):
    """The model has the tool. It still cannot use it to send anything."""
    registry = build_registry(context.settings)
    written = call(registry, "draft_email",
                   {"to": "them@example.com", "subject": "Hi", "body": "hello"}, context)
    draft_id = context.state["outbox"].list()[0].id
    assert "id" in written

    with pytest.raises(ToolError, match="not approved"):
        call(registry, "send_draft", {"draft_id": draft_id}, context)


def test_there_is_no_tool_that_approves(context):
    """Approval arrives from a person, so no tool may offer it."""
    registry = build_registry(context.settings)
    names = {tool.name for tool in registry}

    assert "approve_draft" not in names
    assert {"draft_email", "draft_event", "send_draft"} <= names


def test_revising_an_approved_draft_withdraws_the_approval(context):
    """Otherwise "just fix the greeting" would rewrite something already agreed."""
    registry = build_registry(context.settings)
    outbox = context.state["outbox"]
    call(registry, "draft_email",
         {"to": "them@example.com", "subject": "Hi", "body": "hello"}, context)
    draft_id = outbox.list()[0].id
    outbox.approve(draft_id)

    call(registry, "revise_draft", {"draft_id": draft_id, "body": "hello again"}, context)

    assert outbox.get(draft_id).status == "draft"
    assert outbox.get(draft_id).body == "hello again"


def test_a_sent_draft_cannot_be_sent_twice(outbox, monkeypatch):
    draft = outbox.prepare(Draft(subject="Hello", body="hi", to=["them@example.com"]))
    outbox.approve(draft.id)
    monkeypatch.setattr(outbox.mailer, "send", lambda draft: "them@example.com")
    monkeypatch.setattr(outbox.mailer, "host", "smtp.example.com")
    outbox.send(draft.id)

    with pytest.raises(DraftError, match="already gone out"):
        outbox.send(draft.id)


def test_a_failed_send_is_not_recorded_as_sent(outbox, monkeypatch):
    draft = outbox.prepare(Draft(subject="Hello", body="hi", to=["them@example.com"]))
    outbox.approve(draft.id)

    def explode(_draft):
        raise DraftError("the server said no")

    monkeypatch.setattr(outbox.mailer, "send", explode)
    with pytest.raises(DraftError):
        outbox.send(draft.id)

    assert outbox.get(draft.id).status == "failed"


# -------------------------------------------------------------- checking


def test_a_draft_with_a_bad_address_is_refused_when_written(outbox):
    with pytest.raises(DraftError, match="email address"):
        outbox.prepare(Draft(subject="Hi", body="x", to=["not-an-address"]))


def test_an_email_needs_a_recipient(outbox):
    with pytest.raises(DraftError, match="recipient"):
        outbox.prepare(Draft(subject="Hi", body="x"))


def test_an_event_needs_a_start(outbox):
    with pytest.raises(DraftError, match="start time"):
        outbox.prepare(Draft(kind="event", subject="Review"))


# ---------------------------------------------------------------- email


def test_the_message_is_built_the_way_it_will_be_sent():
    mailer = Mailer(host="smtp.example.com", from_address="me@example.com", from_name="Supakit")
    draft = Draft(subject="สรุปประชุม", body="เรียนพี่", to=["a@example.com"],
                  cc=["b@example.com"], reply_to_message_id="<abc@mail>")

    message = mailer.build(draft)

    assert message["To"] == "a@example.com"
    assert message["Cc"] == "b@example.com"
    assert message["In-Reply-To"] == "<abc@mail>"
    assert "Supakit" in message["From"]
    # Thai survives the encoding round trip.
    assert "สรุปประชุม" in str(message["Subject"])
    assert "เรียนพี่" in message.get_content()


def test_an_unconfigured_mailer_says_what_is_missing():
    assert "THURSDAY_SMTP_HOST" in Mailer().why_not()
    assert "THURSDAY_SMTP_FROM" in Mailer(host="smtp.example.com").why_not()
    assert Mailer(host="smtp.example.com", from_address="me@example.com").why_not() == ""


def test_a_send_failure_is_reported_not_swallowed(monkeypatch):
    mailer = Mailer(host="smtp.example.com", from_address="me@example.com")

    def refuse(*args, **kwargs):
        raise smtplib.SMTPException("relay denied")

    monkeypatch.setattr(smtplib, "SMTP", refuse)
    with pytest.raises(DraftError, match="relay denied"):
        mailer.send(Draft(subject="Hi", body="x", to=["a@example.com"]))


# -------------------------------------------------------------- calendar


def test_an_event_becomes_a_calendar_file_any_app_can_open(outbox):
    draft = outbox.prepare(
        Draft(kind="event", subject="รีวิวงาน", body="line one\nline two",
              to=["guest@example.com"], location="ห้อง 2",
              starts_at=datetime(2026, 9, 7, 14, 0).astimezone(), minutes=45)
    )
    outbox.approve(draft.id)
    result = outbox.send(draft.id)

    written = (outbox.out_dir).glob("*.ics")
    body = next(written).read_text(encoding="utf-8")
    assert "BEGIN:VEVENT" in body
    assert "SUMMARY:รีวิวงาน" in body
    assert "DTSTART:20260907T140000" in body
    assert "DTEND:20260907T144500" in body
    assert "ATTENDEE;RSVP=TRUE:mailto:guest@example.com" in body
    # A newline inside a description would otherwise end the property.
    assert "DESCRIPTION:line one\\nline two" in body
    assert result["subject"] == "รีวิวงาน"


def test_the_invite_filename_keeps_thai_readable(outbox):
    """A \\w character class drops Thai vowel marks and mangles the name."""
    draft = outbox.prepare(
        Draft(kind="event", subject="รีวิวงาน", starts_at=datetime.now().astimezone())
    )
    path = outbox.write_invite(draft)

    assert "รีวิวงาน" in path.name


def test_long_ics_lines_are_folded():
    draft = Draft(kind="event", subject="x" * 200, starts_at=datetime.now().astimezone())
    body = to_ics(draft)

    assert all(len(line) <= 75 for line in body.split("\r\n"))
    assert "\r\n " in body      # folded, not truncated


# ------------------------------------------------------------ time words


@pytest.mark.parametrize(
    "text, expected",
    [
        ("tomorrow 14:00", "2026-09-07 14:00"),
        ("tomorrow", "2026-09-07 09:00"),
        ("today 09:00", "2026-09-06 09:00"),
        ("friday 9am", "2026-09-11 09:00"),
        ("fri 18:30", "2026-09-11 18:30"),
        ("6.30pm", "2026-09-06 18:30"),
        ("พรุ่งนี้ 14:00", "2026-09-07 14:00"),
        ("พรุ่งนี้บ่ายสอง", "2026-09-07 14:00"),
        ("สองทุ่ม", "2026-09-06 20:00"),
        ("ตีห้า", "2026-09-07 05:00"),
        ("9 โมงเช้า", "2026-09-07 09:00"),
        ("5 โมงเย็น", "2026-09-06 17:00"),
        ("ศุกร์ 10:00", "2026-09-11 10:00"),
        ("มะรืนนี้", "2026-09-08 09:00"),
    ],
)
def test_a_time_is_read_the_way_a_person_said_it(text, expected):
    """A Sunday at 13:10, so a bare afternoon time is still ahead."""
    now = datetime(2026, 9, 6, 13, 10).astimezone()

    got = parse_when(text, now)

    assert got is not None, f"could not read {text!r}"
    assert got.strftime("%Y-%m-%d %H:%M") == expected


def test_a_named_day_is_taken_at_its_word():
    """The bug this closes: "tomorrow 14:00" landed today, because 14:00 had
    not passed yet and only bare times were meant to roll forward."""
    now = datetime(2026, 9, 6, 13, 10).astimezone()

    assert parse_when("tomorrow 14:00", now).day == 7
    assert parse_when("14:00", now).day == 6          # bare, still ahead: today
    assert parse_when("12:00", now).day == 7          # bare, already past: tomorrow


def test_a_weekday_names_the_next_one():
    saturday = datetime(2026, 9, 12, 10, 0).astimezone()

    assert parse_when("saturday 10:00", saturday).day == 19   # not today
    assert parse_when("sunday 10:00", saturday).day == 13


def test_nonsense_is_refused_rather_than_guessed():
    assert parse_when("sometime soon") is None
    assert parse_when("") is None


def test_a_draft_event_refuses_a_time_it_cannot_read(context):
    registry = build_registry(context.settings)

    with pytest.raises(ToolError, match="could not read"):
        call(registry, "draft_event", {"title": "Review", "when": "whenever"}, context)


def test_drafting_an_event_from_words(context):
    registry = build_registry(context.settings)
    tomorrow = (datetime.now() + timedelta(days=1)).date()

    call(registry, "draft_event",
         {"title": "รีวิวงาน", "when": "พรุ่งนี้บ่ายสอง", "minutes": 45}, context)

    draft = context.state["outbox"].list()[0]
    assert draft.starts_at.date() == tomorrow
    assert draft.starts_at.hour == 14
    assert draft.status == "draft"


def test_sending_an_approved_draft_still_asks(context, monkeypatch):
    """The last gate before it actually leaves - and it takes a title AND a
    detail, which is how every other dangerous tool calls it."""
    registry = build_registry(context.settings)
    outbox = context.state["outbox"]
    call(registry, "draft_email",
         {"to": "them@example.com", "subject": "Hi", "body": "hello"}, context)
    draft_id = outbox.list()[0].id
    outbox.approve(draft_id)

    asked = []

    async def confirm(title, detail):
        asked.append((title, detail))
        return False

    context.confirm = confirm
    with pytest.raises(ToolError, match="declined"):
        call(registry, "send_draft", {"draft_id": draft_id}, context)

    assert asked and "Hi" in asked[0][0]
    assert "them@example.com" in asked[0][1]
    assert outbox.get(draft_id).status == "approved"    # not sent, not failed
