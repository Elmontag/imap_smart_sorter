from __future__ import annotations

from datetime import datetime

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.mark.usefixtures("backend_env")
def test_suggestions_endpoint_returns_records(backend_env):
    app_module = backend_env["app_module"]
    database = backend_env["database"]
    sample = database.Suggestion(
        message_uid="abc-123",
        src_folder="INBOX",
        subject="Anfrage",
        from_addr="kunde@example.org",
        ranked=[{"name": "Archiv/Kunden", "score": 0.9, "rating": 95.0}],
        status="open",
        move_status="pending",
    )
    database.save_suggestion(sample)

    with TestClient(app_module.app) as client:
        response = client.get("/api/suggestions")

    assert response.status_code == 200
    payload = response.json()
    assert payload["open_count"] == 1
    assert payload["decided_count"] == 0
    assert payload["error_count"] == 0
    assert payload["total_count"] == 1
    assert len(payload["suggestions"]) == 1
    entry = payload["suggestions"][0]
    assert entry["message_uid"] == "abc-123"
    assert entry["move_status"] == "pending"


@pytest.mark.usefixtures("backend_env")
def test_pending_endpoint_uses_overview(monkeypatch, backend_env):
    app_module = backend_env["app_module"]
    pending_module = importlib.import_module("backend.pending")

    async def _fake_load_pending(_folders):
        return pending_module.PendingOverview(
            total_messages=3,
            processed_count=1,
            pending_total=2,
            pending=[
                pending_module.PendingMail(
                    message_uid="m1",
                    folder="INBOX",
                    subject="Status",
                    from_addr="support@example.org",
                    date=datetime.utcnow().isoformat(),
                ),
                pending_module.PendingMail(
                    message_uid="m2",
                    folder="INBOX/Team",
                    subject="Reminder",
                    from_addr="lead@example.org",
                    date=None,
                ),
            ],
            list_limit=25,
            limit_active=True,
        )

    monkeypatch.setattr(app_module, "load_pending_overview", _fake_load_pending)

    with TestClient(app_module.app) as client:
        response = client.get("/api/pending")

    assert response.status_code == 200
    data = response.json()
    assert data["pending_count"] == 2
    assert data["displayed_pending"] == 2
    assert data["pending_ratio"] == pytest.approx(2 / 3)
    assert data["list_limit"] == 25
    assert data["pending"][0]["message_uid"] == "m1"
    assert data["pending"][1]["folder"] == "INBOX/Team"


@pytest.mark.usefixtures("backend_env")
def test_poll_interval_can_be_updated(backend_env):
    app_module = backend_env["app_module"]
    runtime_settings = backend_env["runtime_settings"]

    with TestClient(app_module.app) as client:
        response = client.put("/api/config", json={"poll_interval_seconds": 45})
        assert response.status_code == 200
        payload = response.json()
        assert payload["poll_interval_seconds"] == 45

        status_response = client.get("/api/scan/status")
        assert status_response.status_code == 200
        status = status_response.json()
        assert status["poll_interval"] == pytest.approx(45.0)

    assert runtime_settings.resolve_poll_interval_seconds() == pytest.approx(45.0)


@pytest.mark.usefixtures("backend_env")
def test_poll_interval_rejects_small_values(backend_env):
    app_module = backend_env["app_module"]

    with TestClient(app_module.app) as client:
        response = client.put("/api/config", json={"poll_interval_seconds": 3})

    assert response.status_code == 422
