from pathlib import Path

from fastapi.testclient import TestClient


def test_mailbox_config_roundtrip(backend_env):
    app_module = backend_env["app_module"]
    database = backend_env["database"]

    with TestClient(app_module.app) as client:
        payload = {
            "host": "mail.example.org",
            "port": 993,
            "username": "user@example.org",
            "inbox": "INBOX/Events",
            "use_ssl": True,
            "process_only_seen": False,
            "since_days": 7,
            "password": "secret",
            "clear_password": False,
        }
        response = client.put("/api/mailbox/config", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["host"] == "mail.example.org"
        assert data["port"] == 993
        assert data["username"] == "user@example.org"
        assert data["inbox"] == "INBOX/Events"
        assert data["use_ssl"] is True
        assert data["process_only_seen"] is False
        assert data["since_days"] == 7
        assert data["has_password"] is True

        persisted = database.get_mailbox_settings_entry()
        assert persisted["host"] == "mail.example.org"
        assert persisted["username"] == "user@example.org"
        assert persisted["inbox"] == "INBOX/Events"
        assert persisted["port"] == 993
        assert persisted.get("password") == "secret"

        reload_response = client.get("/api/mailbox/config")
        assert reload_response.status_code == 200
        reloaded = reload_response.json()
        assert reloaded == data

    db_file = Path(database.engine.url.database)
    resolved = db_file.resolve()
    assert resolved.exists()
    assert resolved.name == "app.db"
    assert any(part == "data" for part in resolved.parts)


def test_calendar_config_roundtrip(backend_env):
    app_module = backend_env["app_module"]
    database = backend_env["database"]

    with TestClient(app_module.app) as client:
        payload = {
            "enabled": True,
            "caldav_url": "https://cal.example.org",
            "username": "calendar-user",
            "calendar_name": "Privat",
            "timezone": "Europe/Berlin",
            "processed_tag": "Done",
            "source_folders": ["INBOX", "INBOX/Calendar"],
            "processed_folder": "Archive/Calendar",
            "password": "topsecret",
            "clear_password": False,
        }
        response = client.put("/api/calendar/config", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is True
        assert data["caldav_url"] == "https://cal.example.org"
        assert data["username"] == "calendar-user"
        assert data["calendar_name"] == "Privat"
        assert data["processed_tag"] == "Done"
        assert data["source_folders"] == ["INBOX", "INBOX/Calendar"]
        assert data["processed_folder"] == "Archive/Calendar"
        assert data["has_password"] is True

        stored = database.get_calendar_settings_entry()
        assert stored["caldav_url"] == "https://cal.example.org"
        assert stored["username"] == "calendar-user"
        assert stored["calendar_name"] == "Privat"
        assert stored["processed_tag"] == "Done"
        assert stored["processed_folder"] == "Archive/Calendar"
        assert stored.get("password") == "topsecret"

        reload_response = client.get("/api/calendar/config")
        assert reload_response.status_code == 200
        reloaded = reload_response.json()
        assert reloaded == data

    db_file = Path(database.engine.url.database)
    resolved = db_file.resolve()
    assert resolved.exists()
    assert resolved.name == "app.db"
    assert any(part == "data" for part in resolved.parts)
