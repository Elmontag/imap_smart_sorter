import asyncio
from collections.abc import Sequence
from typing import Any, Dict, List
from urllib.parse import quote

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
    def __init__(self, *, plan: Sequence[Dict[str, Any]] | None = None) -> None:
        self.plan: List[Dict[str, Any]] = list(plan or [])
        self.calls: List[tuple[str, str, Dict[str, Any]]] = []

    async def __aenter__(self) -> "DummyClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def request(self, method: str, url: str, **kwargs) -> DummyResponse:
        method_upper = method.upper()
        self.calls.append((method_upper, url, kwargs))
        plan = self.plan.pop(0) if self.plan else {}
        default_status = 204 if method_upper == "DELETE" else 200
        status = int(plan.get("status", default_status))
        payload = plan.get("payload")
        text = plan.get("text", "")
        return DummyResponse(method_upper, url, status, payload=payload, text=text)

    async def delete(self, url: str, **kwargs) -> DummyResponse:
        return await self.request("DELETE", url, **kwargs)

    async def post(self, url: str, **kwargs) -> DummyResponse:
        return await self.request("POST", url, **kwargs)


def _install_client(monkeypatch, ollama_service, client: DummyClient) -> None:
    def _factory(*args, **kwargs):
        return client

    monkeypatch.setattr(ollama_service.httpx, "AsyncClient", _factory)


def test_delete_model_prefers_delete_endpoint(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("llama2")
    encoded = quote(normalized, safe="")
    client = DummyClient(plan=[{"status": 204}])
    _install_client(monkeypatch, ollama_service, client)

    asyncio.run(ollama_service.delete_model("llama2"))

    assert client.calls == [
        ("DELETE", f"http://ollama:11434/api/tags/{encoded}", {})
    ]


def test_delete_model_falls_back_to_legacy_post(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("mistral")
    encoded = quote(normalized, safe="")
    client = DummyClient(
        plan=[
            {"status": 405},
            {"status": 200, "payload": {"deleted": True}},
        ],
    )
    _install_client(monkeypatch, ollama_service, client)

    asyncio.run(ollama_service.delete_model("mistral"))

    delete_url = "http://ollama:11434/api/delete"
    assert client.calls == [
        ("DELETE", f"http://ollama:11434/api/tags/{encoded}", {}),
        ("DELETE", delete_url, {"params": {"model": normalized}}),
    ]


def test_delete_model_falls_back_to_post_name(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("custom")
    encoded = quote(normalized, safe="")
    client = DummyClient(
        plan=[
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 200, "payload": {"deleted": True}},
        ],
    )
    _install_client(monkeypatch, ollama_service, client)

    asyncio.run(ollama_service.delete_model("custom"))

    delete_url = "http://ollama:11434/api/delete"
    assert client.calls == [
        ("DELETE", f"http://ollama:11434/api/tags/{encoded}", {}),
        ("DELETE", delete_url, {"params": {"model": normalized}}),
        ("DELETE", delete_url, {"params": {"name": normalized}}),
        ("DELETE", delete_url, {"json": {"model": normalized}}),
        ("DELETE", delete_url, {"json": {"name": normalized}}),
        ("POST", delete_url, {"json": {"model": normalized, "name": normalized}}),
        ("POST", delete_url, {"json": {"model": normalized}}),
    ]


def test_delete_model_raises_for_missing_model(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("unknown")
    encoded = quote(normalized, safe="")
    client = DummyClient(plan=[{"status": 404}])
    _install_client(monkeypatch, ollama_service, client)

    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(ollama_service.delete_model("unknown"))

    assert f"Modell '{normalized}'" in str(excinfo.value)
    assert client.calls == [
        ("DELETE", f"http://ollama:11434/api/tags/{encoded}", {})
    ]


def test_delete_model_propagates_legacy_error(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    normalized = ollama_service._normalise_model_name("broken")
    encoded = quote(normalized, safe="")
    client = DummyClient(
        plan=[
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 405},
            {"status": 500, "payload": {"error": "kaputt"}},
        ],
    )
    _install_client(monkeypatch, ollama_service, client)

    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(ollama_service.delete_model("broken"))

    assert "kaputt" in str(excinfo.value)
    delete_url = "http://ollama:11434/api/delete"
    assert client.calls == [
        ("DELETE", f"http://ollama:11434/api/tags/{encoded}", {}),
        ("DELETE", delete_url, {"params": {"model": normalized}}),
        ("DELETE", delete_url, {"params": {"name": normalized}}),
        ("DELETE", delete_url, {"json": {"model": normalized}}),
        ("DELETE", delete_url, {"json": {"name": normalized}}),
        ("POST", delete_url, {"json": {"model": normalized, "name": normalized}}),
        ("POST", delete_url, {"json": {"model": normalized}}),
        ("POST", delete_url, {"json": {"name": normalized}}),
    ]
