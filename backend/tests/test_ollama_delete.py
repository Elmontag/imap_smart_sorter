import asyncio
from collections.abc import Sequence
from typing import Any, Dict, List

import httpx
import pytest


class DummyResponse:
    def __init__(
        self,
        method: str,
        url: str,
        status_code: int,
        *,
        payload: Dict[str, Any] | None = None,
        text: str = "",
    ) -> None:
        self.status_code = status_code
        self._payload = payload
        self._text = text
        self.request = httpx.Request(method, url)

    def json(self) -> Dict[str, Any]:
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    @property
    def text(self) -> str:
        return self._text

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=self.request, response=self)


class DummyClient:
    def __init__(
        self,
        *,
        delete_plan: Sequence[Dict[str, Any]] | None = None,
        post_plan: Sequence[Dict[str, Any]] | None = None,
    ) -> None:
        self.delete_plan: List[Dict[str, Any]] = list(delete_plan or [])
        self.post_plan: List[Dict[str, Any]] = list(post_plan or [])
        self.delete_calls: List[str] = []
        self.post_calls: List[tuple[str, Dict[str, Any]]] = []

    async def __aenter__(self) -> "DummyClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def delete(self, url: str) -> DummyResponse:
        self.delete_calls.append(url)
        plan = self.delete_plan.pop(0) if self.delete_plan else {}
        status = int(plan.get("status", 204))
        payload = plan.get("payload")
        text = plan.get("text", "")
        return DummyResponse("DELETE", url, status, payload=payload, text=text)

    async def post(self, url: str, *, json: Dict[str, Any]) -> DummyResponse:
        self.post_calls.append((url, json))
        plan = self.post_plan.pop(0) if self.post_plan else {}
        status = int(plan.get("status", 200))
        payload = plan.get("payload")
        text = plan.get("text", "")
        return DummyResponse("POST", url, status, payload=payload, text=text)


def _install_client(monkeypatch, ollama_service, client: DummyClient) -> None:
    def _factory(*args, **kwargs):
        return client

    monkeypatch.setattr(ollama_service.httpx, "AsyncClient", _factory)


def test_delete_model_prefers_delete_endpoint(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("llama2")
    client = DummyClient(delete_plan=[{"status": 204}])
    _install_client(monkeypatch, ollama_service, client)

    asyncio.run(ollama_service.delete_model("llama2"))

    assert client.delete_calls == [f"http://ollama:11434/api/tags/{normalized}"]
    assert client.post_calls == []


def test_delete_model_falls_back_to_legacy_post(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("mistral")
    client = DummyClient(
        delete_plan=[{"status": 405}],
        post_plan=[{"status": 200, "payload": {"deleted": True}}],
    )
    _install_client(monkeypatch, ollama_service, client)

    asyncio.run(ollama_service.delete_model("mistral"))

    assert client.delete_calls == [f"http://ollama:11434/api/tags/{normalized}"]
    assert client.post_calls == [
        ("http://ollama:11434/api/delete", {"name": normalized}),
    ]


def test_delete_model_raises_for_missing_model(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("unknown")
    client = DummyClient(delete_plan=[{"status": 404}])
    _install_client(monkeypatch, ollama_service, client)

    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(ollama_service.delete_model("unknown"))

    assert f"Modell '{normalized}'" in str(excinfo.value)
    assert client.post_calls == []


def test_delete_model_propagates_legacy_error(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("broken")
    client = DummyClient(
        delete_plan=[{"status": 405}],
        post_plan=[{"status": 500, "payload": {"error": "kaputt"}}],
    )
    _install_client(monkeypatch, ollama_service, client)

    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(ollama_service.delete_model("broken"))

    assert "kaputt" in str(excinfo.value)
    assert client.post_calls == [
        ("http://ollama:11434/api/delete", {"name": normalized}),
    ]
