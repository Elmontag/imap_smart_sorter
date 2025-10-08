"""Helpers to validate and prepare Ollama models at runtime."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Tuple

import httpx
from urllib.parse import quote

from settings import S
from runtime_settings import resolve_classifier_model


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
    pulling: bool = False
    progress: float | None = None
    download_total: int | None = None
    download_completed: int | None = None
    status: str | None = None
    error: str | None = None


@dataclass(slots=True)
class OllamaStatus:
    """Aggregated runtime status of the Ollama host."""

    host: str
    reachable: bool
    models: List[OllamaModelStatus] = field(default_factory=list)
    message: str | None = None
    last_checked: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(slots=True)
class ModelPullProgress:
    """Tracks the streaming progress of an Ollama model download."""

    model: str
    normalized_name: str
    purpose: str
    status: str = "initialisiert"
    message: str | None = None
    total: int | None = None
    completed: int = 0
    percent: float | None = None
    active: bool = True
    error: str | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None

    def mark_error(self, message: str) -> None:
        self.active = False
        self.error = message
        self.message = message
        self.finished_at = datetime.now(timezone.utc)

    def mark_complete(self) -> None:
        self.active = False
        if self.total and self.completed < self.total:
            self.completed = self.total
        self.percent = 1.0
        self.status = "fertig"
        self.message = "Modell geladen"
        self.finished_at = datetime.now(timezone.utc)


_STATUS_CACHE: OllamaStatus | None = None
_STATUS_LOCK = asyncio.Lock()
_MODEL_INFO_CACHE: Dict[str, Dict[str, Any]] = {}
_MODEL_INFO_LOCK = asyncio.Lock()
_PULL_PROGRESS: Dict[str, ModelPullProgress] = {}
_PROGRESS_LOCK = asyncio.Lock()


async def _progress_snapshot() -> Dict[str, ModelPullProgress]:
    async with _PROGRESS_LOCK:
        return dict(_PULL_PROGRESS)


async def _store_progress(progress: ModelPullProgress) -> None:
    async with _PROGRESS_LOCK:
        _PULL_PROGRESS[progress.normalized_name] = progress


async def _get_progress(normalized: str) -> ModelPullProgress | None:
    async with _PROGRESS_LOCK:
        return _PULL_PROGRESS.get(normalized)


async def _discard_progress(normalized: str) -> None:
    async with _PROGRESS_LOCK:
        _PULL_PROGRESS.pop(normalized, None)


def _failure_status(message: str) -> OllamaStatus:
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
    return OllamaStatus(host=S.OLLAMA_HOST, reachable=False, models=models, message=message)


def _normalise_percent(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        if value > 100:
            return 1.0
        return value / 100.0
    return value


def _apply_payload(progress: ModelPullProgress, payload: Dict[str, Any]) -> None:
    status_text = str(payload.get("status") or "").strip()
    if status_text:
        progress.status = status_text
    total = payload.get("total")
    if isinstance(total, (int, float)) and total >= 0:
        progress.total = int(total)
    completed = payload.get("completed")
    if isinstance(completed, (int, float)) and completed >= 0:
        progress.completed = int(completed)
    percent = payload.get("percent")
    if isinstance(percent, (int, float)):
        progress.percent = _normalise_percent(float(percent))
    elif progress.total and progress.total > 0:
        progress.percent = min(1.0, max(0.0, progress.completed / progress.total))
    digest = payload.get("digest")
    if isinstance(digest, str) and digest:
        progress.message = digest


def _normalise_model_name(name: str) -> str:
    candidate = name.strip()
    if not candidate:
        return candidate
    if ":" not in candidate:
        candidate = f"{candidate}:latest"
    return candidate


def _model_aliases(name: str) -> List[str]:
    """Return alias names for compatibility with older Ollama endpoints."""

    aliases = [name]
    base = name.split(":", 1)[0].strip()
    if base and base != name:
        aliases.append(base)
    return aliases


def _match_model_entry(
    candidates: Iterable[str],
    entries: Iterable[Dict[str, Any]],
) -> Dict[str, Any] | None:
    candidate_set = {value.strip() for value in candidates if value}
    normalized_candidates = {_normalise_model_name(value) for value in candidate_set if value}
    base_candidates = {
        value.split(":", 1)[0].strip()
        for value in candidate_set
        if value and value.split(":", 1)[0].strip()
    }
    for entry in entries:
        value = str(entry.get("model") or entry.get("name") or "").strip()
        if not value:
            continue
        normalized = _normalise_model_name(value)
        base = value.split(":", 1)[0].strip()
        if (
            value in candidate_set
            or normalized in candidate_set
            or normalized in normalized_candidates
            or base in base_candidates
        ):
            return entry
    return None


async def _fetch_model_details(client: httpx.AsyncClient, model: str) -> Dict[str, Any] | None:
    if not model:
        return None

    normalised = _normalise_model_name(model)

    async with _MODEL_INFO_LOCK:
        cached = _MODEL_INFO_CACHE.get(normalised)
        if cached is not None:
            return cached

    try:
        response = await client.post(
            f"{S.OLLAMA_HOST}/api/show",
            json={"model": normalised},
            timeout=httpx.Timeout(60.0, connect=15.0),
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("Konnte Ollama-Modelldetails nicht laden: %s", exc)
        return None

    payload = response.json()
    if isinstance(payload, dict):
        async with _MODEL_INFO_LOCK:
            _MODEL_INFO_CACHE[normalised] = payload
        return payload
    return None


def _extract_context_length(payload: Dict[str, Any]) -> int | None:
    candidates: List[Any] = []
    if not isinstance(payload, dict):
        return None

    for key in ("context_length", "num_ctx", "max_context_length"):
        if key in payload:
            candidates.append(payload.get(key))

    details = payload.get("details")
    if isinstance(details, dict):
        for key in ("context_length", "num_ctx", "max_context_length"):
            if key in details:
                candidates.append(details.get(key))

    model_info = payload.get("model_info")
    if isinstance(model_info, dict):
        for key in ("context_length", "num_ctx", "max_context_length"):
            if key in model_info:
                candidates.append(model_info.get(key))

    for candidate in candidates:
        if isinstance(candidate, (int, float)):
            value = int(candidate)
            if value > 0:
                return value
        elif isinstance(candidate, str):
            stripped = candidate.strip()
            if stripped.isdigit():
                value = int(stripped)
                if value > 0:
                    return value
    return None


async def get_model_context_window(model: str) -> int | None:
    if not model:
        return None

    timeout = httpx.Timeout(60.0, connect=15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        payload = await _fetch_model_details(client, model)
    if not payload:
        return None
    return _extract_context_length(payload)


async def _fetch_tags(client: httpx.AsyncClient) -> List[Dict[str, Any]]:
    """Return all models from Ollama, following legacy endpoints when necessary."""

    attempts: List[tuple[str, str, Dict[str, Any]]] = [
        ("GET", f"{S.OLLAMA_HOST}/api/tags", {}),
        ("GET", f"{S.OLLAMA_HOST}/api/models", {}),
        ("POST", f"{S.OLLAMA_HOST}/api/tags", {"json": {}}),
    ]
    last_error: Exception | None = None
    for method, url, kwargs in attempts:
        try:
            response = await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            last_error = exc
            continue
        if response.status_code in {404, 405}:
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                last_error = exc
            continue
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            continue
        payload = response.json()
        if isinstance(payload, dict):
            models = payload.get("models")
            if isinstance(models, list):
                return [item for item in models if isinstance(item, dict)]
        return []
    if last_error is not None:
        raise last_error
    raise RuntimeError("Ollama-Modelle konnten nicht ermittelt werden")


def _extract_pull_error(response: httpx.Response, normalized: str) -> str:
    payload = _coerce_json_dict(response)
    if payload:
        message = payload.get("error") or payload.get("message") or payload.get("status")
        if message:
            return str(message)
    text = response.text.strip()
    if response.status_code == 404:
        return f"Modell '{normalized}' wurde nicht gefunden"
    if text:
        return text
    return f"HTTP {response.status_code}"


async def _pull_model(
    client: httpx.AsyncClient,
    model: str,
    *,
    purpose: str,
    progress: ModelPullProgress | None = None,
) -> Tuple[bool, str | None]:
    """Attempt to pull the given model and return success flag plus optional message."""

    normalized = _normalise_model_name(model)
    tracked = progress
    if tracked is None:
        tracked = ModelPullProgress(model=model, normalized_name=normalized, purpose=purpose)
        await _store_progress(tracked)
    else:
        tracked.model = model
        tracked.normalized_name = normalized
        tracked.purpose = purpose
        tracked.active = True
        tracked.error = None
        tracked.message = None
        tracked.status = "initialisiert"
        tracked.finished_at = None

    async def _attempt_pull(payload: Dict[str, str]) -> Tuple[bool, str | None, bool]:
        try:
            async with client.stream(
                "POST",
                f"{S.OLLAMA_HOST}/api/pull",
                json=payload,
                timeout=httpx.Timeout(300.0, connect=30.0),
            ) as response:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    message = _extract_pull_error(exc.response, normalized)
                    if exc.response.status_code in {400, 404, 405}:
                        return False, message, True
                    return False, message, False
                async for chunk in response.aiter_lines():
                    if not chunk:
                        continue
                    try:
                        payload_chunk = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
                    _apply_payload(tracked, payload_chunk)
                    if payload_chunk.get("status") == "success":
                        tracked.mark_complete()
                        return True, None, False
                    if payload_chunk.get("error"):
                        message = str(payload_chunk["error"])
                        tracked.mark_error(message)
                        return False, message, False
        except httpx.HTTPError as exc:
            message = str(exc)
            return False, message, False
        return False, "Unbekanntes Ergebnis beim Laden des Modells", False

    attempted_messages: List[str] = []
    aliases = _model_aliases(normalized)
    payloads: List[Dict[str, str]] = []
    for alias in aliases:
        payloads.append({"model": alias, "name": alias})
    for alias in aliases:
        payloads.append({"model": alias})
        payloads.append({"name": alias})

    for payload in payloads:
        success, message, retry = await _attempt_pull(payload)
        if success:
            return True, None
        if message:
            attempted_messages.append(message)
        if not retry:
            tracked.mark_error(message or "Unbekannter Fehler beim Modell-Download")
            return False, message

    message = attempted_messages[-1] if attempted_messages else "Modell-Download fehlgeschlagen"
    tracked.mark_error(message)
    return False, message


def _summarise(statuses: List[OllamaModelStatus]) -> str | None:
    if not statuses:
        return None
    missing = [item for item in statuses if not item.available]
    if missing:
        names = ", ".join(f"{item.purpose}: {item.name}" for item in missing)
        return f"Fehlende Ollama-Modelle: {names}"
    return "Alle Ollama-Modelle sind einsatzbereit"


async def _background_pull(progress: ModelPullProgress) -> None:
    timeout = httpx.Timeout(300.0, connect=30.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            await _pull_model(client, progress.model, purpose=progress.purpose, progress=progress)
    except Exception as exc:  # pragma: no cover - network interaction
        progress.mark_error(str(exc))
    finally:
        try:
            await refresh_status(pull_missing=False)
        except Exception:  # pragma: no cover - best effort refresh
            logger.debug("Konnte Ollama-Status nach Pull nicht aktualisieren", exc_info=True)


async def start_model_pull(model: str, purpose: str = "custom") -> ModelPullProgress:
    """Start pulling the given model in the background and return the progress entry."""

    normalized = _normalise_model_name(model)
    async with _PROGRESS_LOCK:
        existing = _PULL_PROGRESS.get(normalized)
        if existing and existing.active:
            return existing
        progress = ModelPullProgress(model=model, normalized_name=normalized, purpose=purpose)
        _PULL_PROGRESS[normalized] = progress
    asyncio.create_task(_background_pull(progress))
    return progress


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

        progress_map = await _progress_snapshot()
        statuses: List[OllamaModelStatus] = []
        models_to_check = list(_models_to_check())
        seen = {(_normalise_model_name(model), purpose) for model, purpose in models_to_check}
        for entry in progress_map.values():
            key = (entry.normalized_name, entry.purpose)
            if key not in seen:
                models_to_check.append((entry.model, entry.purpose))
                seen.add(key)

        consumed_entries: set[str] = set()

        for model, purpose in models_to_check:
            normalized = _normalise_model_name(model)
            entry = _match_model_entry({model, normalized}, tags)
            status = OllamaModelStatus(
                name=model,
                normalized_name=normalized,
                purpose=purpose,
            )
            progress = progress_map.get(normalized)
            if entry is None and pull_missing:
                if progress is None or not progress.active:
                    progress = ModelPullProgress(model=model, normalized_name=normalized, purpose=purpose)
                    await _store_progress(progress)
                    progress_map[normalized] = progress
                pulled, info = await _pull_model(client, model, purpose=purpose, progress=progress)
                status.pulled = pulled
                status.message = info
                if pulled:
                    tags = await _fetch_tags(client)
                    entry = _match_model_entry({model, normalized}, tags)
            if entry is not None:
                status.available = True
                entry_name = str(entry.get("model") or entry.get("name") or "").strip()
                if entry_name:
                    consumed_entries.add(_normalise_model_name(entry_name))
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
            if progress is not None:
                status.pulling = progress.active
                status.progress = progress.percent
                status.download_total = progress.total
                status.download_completed = progress.completed
                if progress.status:
                    status.status = progress.status
                if progress.message and not status.message:
                    status.message = progress.message
                if progress.error:
                    status.error = progress.error
                    status.available = False
                if not progress.active and not progress.error and status.available:
                    status.pulled = True
            statuses.append(status)
            consumed_entries.add(normalized)

        existing_keys = {(status.normalized_name, status.purpose) for status in statuses}
        custom_statuses: List[OllamaModelStatus] = []
        for entry in tags:
            entry_name = str(entry.get("model") or entry.get("name") or "").strip()
            if not entry_name:
                continue
            normalized = _normalise_model_name(entry_name)
            if normalized in consumed_entries:
                continue
            key = (normalized, "custom")
            if key in existing_keys:
                continue
            status = OllamaModelStatus(
                name=entry_name,
                normalized_name=normalized,
                purpose="custom",
                available=True,
                pulled=True,
                message="bereit",
            )
            digest = entry.get("digest") or entry.get("sha256")
            if isinstance(digest, str):
                status.digest = digest
            size = entry.get("size")
            if isinstance(size, (int, float)):
                status.size = int(size)
            custom_statuses.append(status)
            consumed_entries.add(normalized)

        if custom_statuses:
            custom_statuses.sort(key=lambda item: item.normalized_name)
            statuses.extend(custom_statuses)
        summary = _summarise(statuses)
        return OllamaStatus(
            host=S.OLLAMA_HOST,
            reachable=True,
            models=statuses,
            message=summary,
        )


def _models_to_check() -> List[Tuple[str, str]]:
    mapping: List[Tuple[str, str]] = []
    classifier = resolve_classifier_model().strip()
    if classifier:
        mapping.append((classifier, "classifier"))
    embed = S.EMBED_MODEL.strip()
    if embed:
        mapping.append((embed, "embedding"))
    return mapping


async def refresh_status(pull_missing: bool = False) -> OllamaStatus:
    async with _STATUS_LOCK:
        try:
            status = await _probe_status(pull_missing)
        except Exception as exc:  # pragma: no cover - defensive network guard
            logger.exception("Ollama-Statusprüfung fehlgeschlagen", exc_info=True)
            status = _failure_status(f"Ollama-Status konnte nicht ermittelt werden: {exc}")
        global _STATUS_CACHE
        _STATUS_CACHE = status
        return status


def _coerce_json_dict(response: httpx.Response) -> Dict[str, Any] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    if isinstance(payload, dict):
        return payload
    return None


def _extract_delete_error(response: httpx.Response, normalized: str) -> str:
    payload = _coerce_json_dict(response)
    if payload:
        message = payload.get("error") or payload.get("message") or payload.get("status")
        if message:
            return str(message)
    text = response.text.strip()
    if response.status_code == 404:
        return f"Modell '{normalized}' wurde nicht gefunden"
    if text:
        return text
    return f"HTTP {response.status_code}"


async def _delete_model_legacy(client: httpx.AsyncClient, normalized: str) -> Dict[str, Any] | None:
    delete_urls = [
        f"{S.OLLAMA_HOST}/api/delete",
        f"{S.OLLAMA_HOST}/api/delete/",
    ]
    aliases = _model_aliases(normalized)
    attempts: List[tuple[str, str, Dict[str, Any]]] = []
    for delete_url in delete_urls:
        for alias in aliases:
            attempts.extend(
                [
                    ("DELETE", delete_url, {"params": {"model": alias}}),
                    ("DELETE", delete_url, {"params": {"name": alias}}),
                    ("DELETE", delete_url, {"json": {"model": alias}}),
                    ("DELETE", delete_url, {"json": {"name": alias}}),
                    ("DELETE", delete_url, {"data": {"model": alias}}),
                    ("DELETE", delete_url, {"data": {"name": alias}}),
                    (
                        "DELETE",
                        delete_url,
                        {
                            "content": json.dumps({"model": alias}).encode("utf-8"),
                            "headers": {"Content-Type": "application/json"},
                        },
                    ),
                    (
                        "DELETE",
                        delete_url,
                        {
                            "content": json.dumps({"name": alias}).encode("utf-8"),
                            "headers": {"Content-Type": "application/json"},
                        },
                    ),
                    ("POST", delete_url, {"json": {"model": alias, "name": alias}}),
                    ("POST", delete_url, {"json": {"model": alias}}),
                    ("POST", delete_url, {"json": {"name": alias}}),
                    ("POST", delete_url, {"data": {"model": alias}}),
                    ("POST", delete_url, {"data": {"name": alias}}),
                    ("POST", delete_url, {"params": {"model": alias}}),
                    ("POST", delete_url, {"params": {"name": alias}}),
                ]
            )

    last_message = None
    for method, delete_url, kwargs in attempts:
        response = await client.request(method, delete_url, **kwargs)
        if response.status_code == 405:
            last_message = _extract_delete_error(response, normalized)
            continue
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            message = _extract_delete_error(response, normalized)
            if response.status_code in {400, 404}:
                last_message = message
                continue
            raise RuntimeError(message) from exc
        return _coerce_json_dict(response)

    message = last_message or f"Modell '{normalized}' konnte nicht gelöscht werden"
    raise RuntimeError(message)


async def delete_model(model: str) -> None:
    """Delete the given model from the Ollama host and clear cached metadata."""

    normalized = _normalise_model_name(model)
    timeout = httpx.Timeout(60.0, connect=15.0)
    encoded = quote(normalized, safe="")
    async with httpx.AsyncClient(timeout=timeout) as client:
        payload: Dict[str, Any] | None = None
        delete_urls = [
            f"{S.OLLAMA_HOST}/api/tags/{encoded}",
            f"{S.OLLAMA_HOST}/api/models/{encoded}",
        ]
        last_error: httpx.HTTPStatusError | None = None
        for url in delete_urls:
            response = await client.delete(url)
            if response.status_code in {404, 405}:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    last_error = exc
                if response.status_code == 405:
                    continue
                message = _extract_delete_error(response, normalized)
                raise RuntimeError(message)
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                message = _extract_delete_error(response, normalized)
                raise RuntimeError(message) from exc
            payload = _coerce_json_dict(response)
            break
        else:
            if last_error is not None and last_error.response.status_code == 404:
                message = _extract_delete_error(last_error.response, normalized)
                raise RuntimeError(message)
            payload = await _delete_model_legacy(client, normalized)
    if isinstance(payload, dict) and payload.get("deleted") is False:
        message = str(payload.get("error") or payload)
        raise RuntimeError(message)
    async with _MODEL_INFO_LOCK:
        _MODEL_INFO_CACHE.pop(normalized, None)
    await _discard_progress(normalized)


async def ensure_ollama_ready() -> OllamaStatus:
    """Ensure the Ollama host is reachable and required models exist."""

    try:
        status = await refresh_status(pull_missing=True)
    except Exception as exc:  # pragma: no cover - defensive guard
        logger.exception("Initialer Ollama-Check fehlgeschlagen", exc_info=True)
        status = _failure_status(f"Ollama-Status konnte nicht geladen werden: {exc}")
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
