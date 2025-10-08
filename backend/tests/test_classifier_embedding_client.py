from __future__ import annotations

import asyncio
import importlib
from typing import Any, Dict, List, Tuple

import httpx
import pytest


class _DummyResponse:
    def __init__(self, status_code: int, payload: Dict[str, Any] | None = None, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.headers: Dict[str, str] = {}
        self.request: httpx.Request | None = None

    def json(self) -> Dict[str, Any]:
        if self._payload is None:
            raise ValueError("No JSON payload")
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            assert self.request is not None
            raise httpx.HTTPStatusError("error", request=self.request, response=self)


class _FakeAsyncClient:
    def __init__(self, responses: List[_DummyResponse]) -> None:
        self._responses = responses
        self.calls: List[Tuple[str, Dict[str, Any]]] = []
        self._index = 0

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # type: ignore[override]
        return None

    async def post(self, url: str, **kwargs: Any) -> _DummyResponse:
        if self._index >= len(self._responses):
            raise AssertionError("Unexpected HTTP call")
        response = self._responses[self._index]
        self._index += 1
        self.calls.append((url, kwargs))
        response.request = httpx.Request("POST", url)
        return response


@pytest.mark.usefixtures("backend_env")
def test_embed_retries_with_alternative_encodings(monkeypatch):
    classifier = importlib.import_module("backend.classifier")
    responses = [
        _DummyResponse(400, {"error": "model not found"}),
        _DummyResponse(400, {"error": "bad request"}),
        _DummyResponse(200, {"embedding": [0.25, 0.5]}),
    ]
    fake_client = _FakeAsyncClient(responses)

    async def _fake_ensure_ready() -> None:
        await asyncio.sleep(0)
        return None

    monkeypatch.setattr(classifier, "ensure_ollama_ready", _fake_ensure_ready)
    monkeypatch.setattr(classifier.httpx, "AsyncClient", lambda *args, **kwargs: fake_client)
    classifier._EMBED_STRATEGY_CACHE.clear()

    async def _run() -> None:
        result = await classifier.embed("Hello World")

        assert result == [0.25, 0.5]
        assert len(fake_client.calls) == 3
        first_kwargs = fake_client.calls[0][1]
        second_kwargs = fake_client.calls[1][1]
        third_kwargs = fake_client.calls[2][1]
        assert "json" in first_kwargs and isinstance(first_kwargs["json"], dict)
        assert "json" in second_kwargs and isinstance(second_kwargs["json"], dict)
        assert "content" in third_kwargs and third_kwargs["headers"]["Content-Type"] == "application/json"

    asyncio.run(_run())

