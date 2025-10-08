import asyncio
from typing import Any, Dict, Iterable, List

import httpx


class DummyStreamResponse:
    def __init__(
        self,
        method: str,
        url: str,
        status: int,
        *,
        payload: Dict[str, Any] | None = None,
        text: str = "",
        lines: Iterable[str] | None = None,
    ) -> None:
        self.status_code = status
        self._payload = payload
        self._text = text
        self._lines: List[str] = list(lines or [])
        self.request = httpx.Request(method, url)

    async def __aenter__(self) -> "DummyStreamResponse":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=self.request, response=self)

    async def aiter_lines(self) -> Iterable[str]:
        for line in self._lines:
            yield line

    def json(self) -> Dict[str, Any]:
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    @property
    def text(self) -> str:
        return self._text


class DummyStreamClient:
    def __init__(self, *, plan: Iterable[Dict[str, Any]]) -> None:
        self.plan = list(plan)
        self.calls: List[Dict[str, Any]] = []

    async def __aenter__(self) -> "DummyStreamClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    def stream(self, method: str, url: str, *, json: Dict[str, Any], timeout: httpx.Timeout) -> DummyStreamResponse:
        self.calls.append({"method": method.upper(), "url": url, "json": json})
        entry = self.plan.pop(0) if self.plan else {}
        status = int(entry.get("status", 200))
        payload = entry.get("payload")
        text = entry.get("text", "")
        lines = entry.get("lines", [])
        return DummyStreamResponse(method.upper(), url, status, payload=payload, text=text, lines=lines)


def test_pull_model_retries_payload_variants(backend_env):
    ollama_service = backend_env["ollama_service"]

    plan = [
        {"status": 400, "payload": {"error": "missing name"}},
        {"status": 400, "payload": {"error": "missing name"}},
        {"status": 400, "payload": {"error": "missing name"}},
        {"status": 200, "lines": ['{"status": "success"}']},
    ]

    client = DummyStreamClient(plan=plan)

    async def _run() -> tuple[bool, str | None]:
        return await ollama_service._pull_model(client, "mistral", purpose="classifier")

    success, message = asyncio.run(_run())

    assert success is True
    assert message is None
    assert len(client.calls) == 4
    assert client.calls[0]["json"] == {
        "model": "mistral:latest",
        "name": "mistral:latest",
    }
    assert client.calls[1]["json"] == {
        "model": "mistral",
        "name": "mistral",
    }
    assert client.calls[2]["json"] == {"model": "mistral:latest"}
    assert client.calls[3]["json"] == {"name": "mistral:latest"}

    asyncio.run(ollama_service._discard_progress("mistral:latest"))
