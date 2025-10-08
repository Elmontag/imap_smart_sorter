import asyncio

import httpx
import pytest


def test_ollama_status_lists_detected_models_without_requirements(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    settings_module = backend_env["settings"]

    monkeypatch.setattr(ollama_service, "resolve_classifier_model", lambda: "")

    monkeypatch.setattr(settings_module.S, "CLASSIFIER_MODEL", "", raising=False)
    monkeypatch.setattr(settings_module.S, "EMBED_MODEL", "", raising=False)
    monkeypatch.setattr(ollama_service.S, "EMBED_MODEL", "", raising=False)

    async def fake_fetch_tags(client):
        return [
            {"model": "llama3:8b", "digest": "sha-llama", "size": 123_456},
            {"name": "nomic-embed-text", "sha256": "sha-embed", "size": 78_910},
        ]

    monkeypatch.setattr(ollama_service, "_fetch_tags", fake_fetch_tags)

    status = asyncio.run(ollama_service.refresh_status(pull_missing=False))

    assert status.reachable is True
    assert status.message == "Alle Ollama-Modelle sind einsatzbereit"

    assert len(status.models) == 2
    normalized = {model.normalized_name for model in status.models}
    assert "llama3:8b" in normalized
    assert "nomic-embed-text:latest" in normalized

    for model in status.models:
        assert model.available is True
        assert model.purpose == "custom"
        assert model.pulled is True
        assert model.message == "bereit"


class _FetchDummyResponse:
    def __init__(self, method: str, url: str, status: int, payload: dict | None = None) -> None:
        self.status_code = status
        self._payload = payload or {}
        self.request = httpx.Request(method, url)

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=self.request, response=self)


class _FetchDummyClient:
    def __init__(self, plan: list[dict[str, object]]) -> None:
        self.plan = list(plan)
        self.calls: list[tuple[str, str]] = []

    async def request(self, method: str, url: str, **kwargs) -> _FetchDummyResponse:  # noqa: ARG002
        method_upper = method.upper()
        self.calls.append((method_upper, url))
        entry = self.plan.pop(0) if self.plan else {"status": 200, "payload": {}}
        status = int(entry.get("status", 200))
        payload = entry.get("payload")
        if payload is not None and not isinstance(payload, dict):
            raise AssertionError("payload must be a dict")
        return _FetchDummyResponse(method_upper, url, status, payload)


def test_fetch_tags_falls_back_to_models_endpoint(backend_env):
    ollama_service = backend_env["ollama_service"]
    client = _FetchDummyClient(
        [
            {"status": 405, "payload": {"error": "method not allowed"}},
            {"status": 200, "payload": {"models": [{"model": "llama3"}]}}
        ]
    )

    models = asyncio.run(ollama_service._fetch_tags(client))

    assert models == [{"model": "llama3"}]
    assert client.calls == [
        ("GET", "http://ollama:11434/api/tags"),
        ("GET", "http://ollama:11434/api/models"),
    ]


def test_fetch_tags_raises_when_all_variants_fail(backend_env):
    ollama_service = backend_env["ollama_service"]
    client = _FetchDummyClient(
        [
            {"status": 405, "payload": {"error": "method not allowed"}},
            {"status": 404, "payload": {"error": "missing"}},
            {"status": 500, "payload": {"error": "kaputt"}},
        ]
    )

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(ollama_service._fetch_tags(client))

    assert client.calls == [
        ("GET", "http://ollama:11434/api/tags"),
        ("GET", "http://ollama:11434/api/models"),
        ("POST", "http://ollama:11434/api/tags"),
    ]
