from __future__ import annotations

import importlib
from typing import Any

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.parametrize(
    ("config_host", "path", "expected"),
    [
        ("http://ollama:11434", "api/embeddings", "http://ollama:11434/api/embeddings"),
        ("http://ollama:11434/", "/api/embed", "http://ollama:11434/api/embed"),
        ("http://ollama:11434/api", "api/embeddings", "http://ollama:11434/api/embeddings"),
    ],
)
def test_build_ollama_url_resolves_paths(backend_env, monkeypatch, config_host, path, expected):
    ollama_service = importlib.import_module("backend.ollama_service")
    settings_module = importlib.import_module("backend.settings")

    monkeypatch.setattr(settings_module.S, "OLLAMA_HOST", config_host)

    assert ollama_service.build_ollama_url(path) == expected


@pytest.mark.anyio
async def test_embed_uses_configured_subpath(backend_env, monkeypatch):
    settings_module = importlib.import_module("backend.settings")
    classifier = importlib.import_module("backend.classifier")

    monkeypatch.setattr(settings_module.S, "OLLAMA_HOST", "http://ollama:11434/api")

    calls: list[tuple[str, dict[str, Any]]] = []

    class DummyResponse:
        status_code = 200

        def raise_for_status(self) -> None:  # pragma: no cover - simple stub
            return None

        def json(self) -> dict[str, Any]:
            return {"embedding": [0.1, 0.2, 0.3]}

    class DummyAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def post(self, url: str, json: dict[str, Any]):
            calls.append((url, json))
            return DummyResponse()

    monkeypatch.setattr(classifier.httpx, "AsyncClient", DummyAsyncClient)

    classifier._EMBED_STRATEGY_CACHE.clear()

    result = await classifier.embed("demo prompt")

    assert result == [0.1, 0.2, 0.3]
    assert calls, "expected embed to perform at least one HTTP call"
    assert calls[0][0] == "http://ollama:11434/api/embeddings"
    payload = calls[0][1]
    assert payload["model"] == settings_module.S.EMBED_MODEL
    assert any(key in payload for key in {"prompt", "input", "text"})
