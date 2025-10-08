import asyncio
from datetime import datetime, timezone


def test_calendar_processing_and_import(backend_env, monkeypatch):
    calendar_sync = backend_env["calendar_sync"]
    calendar_settings = backend_env["calendar_settings"]
    database = backend_env["database"]

    ics = """BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\nBEGIN:VEVENT\nUID:test-event@example.com\nDTSTAMP:20240101T120000Z\nDTSTART:20240102T130000Z\nDTEND:20240102T140000Z\nSUMMARY:Team Sync\nORGANIZER:mailto:lead@example.com\nLOCATION:HQ\nEND:VEVENT\nEND:VCALENDAR\n"""

    events_found, created, updated = calendar_sync._process_calendar_attachment(
        raw_ics=ics,
        message_uid="42",
        folder="INBOX/Calendar",
        subject="Weekly meeting",
        from_addr="lead@example.com",
        message_date=datetime(2024, 1, 2, 12, tzinfo=timezone.utc),
        timezone_name="Europe/Berlin",
    )

    assert events_found == 1
    assert created == 1
    assert updated == 0

    events = database.list_calendar_events()
    assert len(events) == 1
    event = events[0]
    assert event.event_uid == "test-event@example.com"
    assert event.summary == "Team Sync"
    assert event.organizer == "lead@example.com"
    assert event.location == "HQ"
    assert event.status == "pending"

    overview_events, metrics = calendar_sync.load_calendar_overview()
    assert len(overview_events) == 1
    assert metrics["pending"] == 1
    assert metrics["imported"] == 0

    stored = calendar_settings.persist_calendar_settings(
        enabled=True,
        caldav_url="https://cal.example.org",
        username="calendar-user",
        calendar_name="Privat",
        timezone="Europe/Berlin",
        processed_tag="Processed",
        source_folders=["INBOX", "INBOX/Calendar"],
        processed_folder="Archive/Calendar",
        password="secret",
        clear_password=False,
    )
    assert stored.password == "secret"

    added_events = []
    tagged_messages = []
    moved_messages = []

    class FakeCalendar:
        def add_event(self, payload: str) -> None:
            added_events.append(payload)

    class FakePrincipal:
        def __init__(self) -> None:
            self._calendar = FakeCalendar()

        def calendars(self):
            return [self._calendar]

    class FakeClient:
        def __init__(self, *_, **__):
            self._principal = FakePrincipal()

        def principal(self):
            return self._principal

    monkeypatch.setattr(calendar_sync, "DAVClient", FakeClient)
    monkeypatch.setattr(calendar_sync, "resolve_mailbox_inbox", lambda: "INBOX")
    monkeypatch.setattr(calendar_sync, "add_message_tag", lambda *args, **kwargs: tagged_messages.append((args, kwargs)))
    monkeypatch.setattr(calendar_sync, "move_message", lambda *args, **kwargs: moved_messages.append((args, kwargs)))

    updated_event = asyncio.run(calendar_sync.import_calendar_event(event.id))
    assert updated_event is not None
    assert updated_event.status == "imported"
    assert updated_event.last_import_at is not None

    assert len(added_events) == 1
    assert "BEGIN:VEVENT" in added_events[0]
    assert len(tagged_messages) == 1
    assert tagged_messages[0][0][2] == "Processed"
    assert len(moved_messages) == 1
    assert moved_messages[0][0][1] == "Archive/Calendar"

    _, metrics_after = calendar_sync.load_calendar_overview()
    assert metrics_after["pending"] == 0
    assert metrics_after["imported"] == 1
