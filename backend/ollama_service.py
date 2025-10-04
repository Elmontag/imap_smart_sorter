"""Helpers to validate and prepare Ollama models at runtime."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Tuple

import httpx

from settings import S


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class OllamaModelStatus:
    """Represents the availability of a single model on the Ollama host."""

    name: str
    normalized_name: str
    purpose: str
    available: bool = False
    pulled: bool = False
    digest: str | None = None
    size: int | None = None
    message: str | None = None


@dataclass(slots=True)
class OllamaStatus:
    """Aggregated runtime status of the Ollama host."""

    host: str
    reachable: bool
    models: List[OllamaModelStatus] = field(default_factory=list)
    message: str | None = None
    last_checked: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


_STATUS_CACHE: OllamaStatus | None = None
_STATUS_LOCK = asyncio.Lock()


def _normalise_model_name(name: str) -> str:
    candidate = name.strip()
    if not candidate:
        return candidate
    if ":" not in candidate:
        candidate = f"{candidate}:latest"
    return candidate


def _match_model_entry(
    candidates: Iterable[str],
    entries: Iterable[Dict[str, Any]],
) -> Dict[str, Any] | None:
    candidate_set = {value.strip() for value in candidates if value}
    for entry in entries:
        value = str(entry.get("model") or entry.get("name") or "").strip()
        if value in candidate_set:
            return entry
    return None


async def _fetch_tags(client: httpx.AsyncClient) -> List[Dict[str, Any]]:
    response = await client.get(f"{S.OLLAMA_HOST}/api/tags")
    response.raise_for_status()
    payload = response.json()
    models = payload.get("models")
    if isinstance(models, list):
        return [item for item in models if isinstance(item, dict)]
    return []


async def _pull_model(client: httpx.AsyncClient, model: str) -> Tuple[bool, str | None]:
    """Attempt to pull the given model and return success flag plus optional message."""

    try:
        async with client.stream(
            "POST",
            f"{S.OLLAMA_HOST}/api/pull",
            json={"model": model},
            timeout=httpx.Timeout(300.0, connect=30.0),
        ) as response:
            response.raise_for_status()
            async for chunk in response.aiter_lines():
                if not chunk:
                    continue
                try:
                    payload = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
                if payload.get("status") == "success":
                    return True, None
                if payload.get("error"):
                    return False, str(payload["error"])
    except httpx.HTTPError as exc:
        return False, str(exc)
    return False, "Unbekanntes Ergebnis beim Laden des Modells"


def _summarise(statuses: List[OllamaModelStatus]) -> str | None:
    if not statuses:
        return None
    missing = [item for item in statuses if not item.available]
    if missing:
        names = ", ".join(f"{item.purpose}: {item.name}" for item in missing)
        return f"Fehlende Ollama-Modelle: {names}"
    return "Alle Ollama-Modelle sind einsatzbereit"


async def _probe_status(pull_missing: bool) -> OllamaStatus:
    timeout = httpx.Timeout(60.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            tags = await _fetch_tags(client)
        except httpx.HTTPError as exc:
            message = f"Ollama nicht erreichbar: {exc}".strip()
            logger.warning(message)
            models = [
                OllamaModelStatus(
                    name=model,
                    normalized_name=_normalise_model_name(model),
                    purpose=purpose,
                    available=False,
                    message=message,
                )
                for model, purpose in _models_to_check()
            ]
            return OllamaStatus(
                host=S.OLLAMA_HOST,
                reachable=False,
                models=models,
                message=message,
            )

        statuses: List[OllamaModelStatus] = []
        for model, purpose in _models_to_check():
            normalized = _normalise_model_name(model)
            entry = _match_model_entry({model, normalized}, tags)
            status = OllamaModelStatus(
                name=model,
                normalized_name=normalized,
                purpose=purpose,
            )
            if entry is None and pull_missing:
                pulled, info = await _pull_model(client, model)
                status.pulled = pulled
                status.message = info
                if pulled:
                    tags = await _fetch_tags(client)
                    entry = _match_model_entry({model, normalized}, tags)
            if entry is not None:
                status.available = True
                digest = entry.get("digest") or entry.get("sha256")
                if isinstance(digest, str):
                    status.digest = digest
                size = entry.get("size")
                if isinstance(size, (int, float)):
                    status.size = int(size)
                if not status.message:
                    status.message = "bereit"
            else:
                if not status.message:
                    status.message = "Modell nicht auf dem Host vorhanden"
            statuses.append(status)
        summary = _summarise(statuses)
        return OllamaStatus(
            host=S.OLLAMA_HOST,
            reachable=True,
            models=statuses,
            message=summary,
        )


def _models_to_check() -> List[Tuple[str, str]]:
    mapping: List[Tuple[str, str]] = []
    classifier = S.CLASSIFIER_MODEL.strip()
    if classifier:
        mapping.append((classifier, "classifier"))
    embed = S.EMBED_MODEL.strip()
    if embed:
        mapping.append((embed, "embedding"))
    return mapping


async def refresh_status(pull_missing: bool = False) -> OllamaStatus:
    async with _STATUS_LOCK:
        status = await _probe_status(pull_missing)
        global _STATUS_CACHE
        _STATUS_CACHE = status
        return status


async def ensure_ollama_ready() -> OllamaStatus:
    """Ensure the Ollama host is reachable and required models exist."""

    status = await refresh_status(pull_missing=True)
    if not status.reachable:
        logger.warning("Ollama-Host %s nicht erreichbar", status.host)
    else:
        missing = [model.name for model in status.models if not model.available]
        if missing:
            logger.warning("Ollama-Modelle fehlen trotz Ladeversuch: %s", ", ".join(missing))
    return status


async def get_status(force_refresh: bool = False) -> OllamaStatus:
    async with _STATUS_LOCK:
        if not force_refresh and _STATUS_CACHE is not None:
            return _STATUS_CACHE
    return await refresh_status(pull_missing=False)


def status_as_dict(status: OllamaStatus) -> Dict[str, Any]:
    return asdict(status)
