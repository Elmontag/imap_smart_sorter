"""FastAPI application for the IMAP Smart Sorter backend."""

from __future__ import annotations

import asyncio
import logging

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket
from fastapi import WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from database import (
    find_suggestion_by_uid,
    get_mode,
    get_monitored_folders,
    init_db,
    list_suggestions,
    mark_failed,
    mark_moved,
    record_decision,
    record_dry_run,
    set_mode,
    set_monitored_folders,
    suggestion_status_counts,
    update_proposal,
)
from imap_worker import one_shot_scan
from mailbox import ensure_folder_path, folder_exists, list_folders, move_message
from models import Suggestion
from pending import PendingMail, PendingOverview, load_pending_overview
from tags import TagSuggestion, load_tag_suggestions
from ollama_service import ensure_ollama_ready, get_status, status_as_dict
from settings import S


class MoveMode(str, Enum):
    DRY_RUN = "DRY_RUN"
    CONFIRM = "CONFIRM"
    AUTO = "AUTO"


class ModeResponse(BaseModel):
    mode: MoveMode


class ModeUpdate(BaseModel):
    mode: MoveMode


class MoveRequest(BaseModel):
    message_uid: str = Field(..., min_length=1)
    target_folder: str = Field(..., min_length=1)
    dry_run: bool = False


class DecisionRequest(MoveRequest):
    decision: str = Field("accept", pattern=r"^(accept|reject)$")


class BulkMoveRequest(BaseModel):
    items: List[MoveRequest] = Field(default_factory=list)


class SuggestionsResponse(BaseModel):
    suggestions: List[Suggestion]
    open_count: int
    decided_count: int
    error_count: int
    total_count: int


class FolderSelectionResponse(BaseModel):
    available: List[str]
    selected: List[str]


class FolderSelectionUpdate(BaseModel):
    folders: List[str] = Field(default_factory=list)


class ProposalDecisionRequest(BaseModel):
    message_uid: str = Field(..., min_length=1)
    accept: bool


class OllamaModelStatusResponse(BaseModel):
    name: str
    normalized_name: str
    purpose: str
    available: bool
    pulled: bool
    digest: str | None = None
    size: int | None = None
    message: str | None = None


class OllamaStatusResponse(BaseModel):
    host: str
    reachable: bool
    message: str | None = None
    last_checked: datetime | None = None
    models: List[OllamaModelStatusResponse] = Field(default_factory=list)


class ConfigResponse(BaseModel):
    dev_mode: bool
    pending_list_limit: int
    protected_tag: str | None = None
    processed_tag: str | None = None
    ai_tag_prefix: str | None = None
    ollama: OllamaStatusResponse | None = None


class TagExampleResponse(BaseModel):
    message_uid: str
    subject: str
    from_addr: str | None = None
    folder: str | None = None
    date: str | None = None


class TagSuggestionResponse(BaseModel):
    tag: str
    occurrences: int
    last_seen: datetime | None = None
    examples: List[TagExampleResponse] = Field(default_factory=list)

    @classmethod
    def from_domain(cls, suggestion: TagSuggestion) -> "TagSuggestionResponse":
        return cls(
            tag=suggestion.tag,
            occurrences=suggestion.occurrences,
            last_seen=suggestion.last_seen,
            examples=[TagExampleResponse(**example) for example in suggestion.serialisable_examples()],
        )


class PendingMailResponse(BaseModel):
    message_uid: str
    folder: str
    subject: str
    from_addr: str | None = None
    date: str | None = None

    @classmethod
    def from_domain(cls, item: PendingMail) -> "PendingMailResponse":
        return cls(
            message_uid=item.message_uid,
            folder=item.folder,
            subject=item.subject,
            from_addr=item.from_addr,
            date=item.date,
        )


class PendingOverviewResponse(BaseModel):
    total_messages: int
    processed_count: int
    pending_count: int
    pending_ratio: float
    pending: List[PendingMailResponse]
    displayed_pending: int
    list_limit: int
    limit_active: bool

    @classmethod
    def from_domain(cls, overview: PendingOverview) -> "PendingOverviewResponse":
        return cls(
            total_messages=overview.total_messages,
            processed_count=overview.processed_count,
            pending_count=overview.pending_count,
            pending_ratio=overview.pending_ratio,
            pending=[PendingMailResponse.from_domain(item) for item in overview.pending],
            displayed_pending=overview.displayed_pending,
            list_limit=overview.list_limit,
            limit_active=overview.limit_active,
        )


app = FastAPI(title="IMAP Smart Sorter")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

logger = logging.getLogger(__name__)


@app.on_event("startup")
async def _startup() -> None:
    init_db()
    await ensure_ollama_ready()


@app.get("/healthz")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


def _resolve_mode() -> MoveMode:
    stored = get_mode()
    try:
        return MoveMode(stored or S.MOVE_MODE)
    except ValueError as exc:  # pragma: no cover - defensive guard
        raise HTTPException(500, f"invalid persisted mode: {stored}") from exc


@app.get("/api/mode", response_model=ModeResponse)
def api_get_mode() -> ModeResponse:
    return ModeResponse(mode=_resolve_mode())


@app.post("/api/mode", response_model=ModeResponse)
def api_set_mode(payload: ModeUpdate) -> ModeResponse:
    set_mode(payload.mode.value)
    return ModeResponse(mode=payload.mode)


@app.get("/api/folders", response_model=FolderSelectionResponse)
def api_folders() -> FolderSelectionResponse:
    available = list_folders()
    selected = get_monitored_folders()
    if not selected and S.IMAP_INBOX in available:
        selected = [S.IMAP_INBOX]
    return FolderSelectionResponse(available=available, selected=selected)


@app.post("/api/folders/selection", response_model=FolderSelectionResponse)
def api_update_folders(payload: FolderSelectionUpdate) -> FolderSelectionResponse:
    set_monitored_folders(payload.folders)
    available = list_folders()
    selected = get_monitored_folders()
    return FolderSelectionResponse(available=available, selected=selected)


@app.get("/api/config", response_model=ConfigResponse)
async def api_config() -> ConfigResponse:
    status = await get_status(force_refresh=False)
    return ConfigResponse(
        dev_mode=bool(S.DEV_MODE),
        pending_list_limit=max(int(getattr(S, "PENDING_LIST_LIMIT", 0)), 0),
        protected_tag=S.IMAP_PROTECTED_TAG or None,
        processed_tag=S.IMAP_PROCESSED_TAG or None,
        ai_tag_prefix=S.IMAP_AI_TAG_PREFIX or None,
        ollama=OllamaStatusResponse.model_validate(status_as_dict(status)),
    )


@app.get("/api/suggestions", response_model=SuggestionsResponse)
def api_suggestions(include: str = Query("open", pattern=r"^(open|all)$")) -> SuggestionsResponse:
    include_all = include == "all"
    counts = suggestion_status_counts()
    suggestions = list_suggestions(include_all)
    return SuggestionsResponse(
        suggestions=suggestions,
        open_count=counts.get("open", 0),
        decided_count=counts.get("decided", 0),
        error_count=counts.get("error", 0),
        total_count=counts.get("total", 0),
    )


@app.get("/api/ollama", response_model=OllamaStatusResponse)
async def api_ollama_status() -> OllamaStatusResponse:
    status = await get_status(force_refresh=True)
    return OllamaStatusResponse.model_validate(status_as_dict(status))


async def _pending_overview() -> PendingOverviewResponse:
    overview = await load_pending_overview(get_monitored_folders())
    return PendingOverviewResponse.from_domain(overview)


@app.get("/api/pending", response_model=PendingOverviewResponse)
async def api_pending() -> PendingOverviewResponse:
    return await _pending_overview()


@app.get("/api/tags", response_model=List[TagSuggestionResponse])
def api_tags() -> List[TagSuggestionResponse]:
    suggestions = load_tag_suggestions()
    return [TagSuggestionResponse.from_domain(item) for item in suggestions]


def _ensure_suggestion(uid: str) -> Suggestion:
    suggestion = find_suggestion_by_uid(uid)
    if not suggestion:
        raise HTTPException(404, "suggestion not found")
    return suggestion


@app.post("/api/decide")
def api_decide(payload: DecisionRequest) -> Dict[str, Any]:
    suggestion = _ensure_suggestion(payload.message_uid)
    updated = record_decision(payload.message_uid, payload.decision)

    current_mode = _resolve_mode()
    if payload.decision == "accept" and current_mode == MoveMode.CONFIRM:
        move_payload = MoveRequest(
            message_uid=payload.message_uid,
            target_folder=payload.target_folder,
            dry_run=payload.dry_run,
        )
        return api_move(move_payload)
    payload_suggestion = updated.dict() if isinstance(updated, Suggestion) else suggestion.dict()
    return {"ok": True, "suggestion": payload_suggestion}


def _perform_move(uid: str, target: str, src_folder: str | None) -> None:
    try:
        move_message(uid, target, src_folder=src_folder)
    except Exception as exc:
        mark_failed(uid, str(exc))
        raise HTTPException(500, f"move failed: {exc}") from exc
    mark_moved(uid)


@app.post("/api/move")
def api_move(payload: MoveRequest) -> Dict[str, Any]:
    suggestion = _ensure_suggestion(payload.message_uid)

    dry_run = payload.dry_run or _resolve_mode() == MoveMode.DRY_RUN
    if dry_run:
        exists = folder_exists(payload.target_folder)
        record_dry_run(payload.message_uid, {"folder_exists": exists})
        return {"ok": exists, "dry_run": True, "checks": {"folder_exists": exists}}

    _perform_move(payload.message_uid, payload.target_folder, suggestion.src_folder)
    return {"ok": True, "dry_run": False}


@app.post("/api/proposal")
def api_proposal(payload: ProposalDecisionRequest) -> Dict[str, Any]:
    suggestion = _ensure_suggestion(payload.message_uid)
    if not suggestion.proposal:
        raise HTTPException(400, "no proposal available")

    proposal = dict(suggestion.proposal)
    proposal["status"] = "accepted" if payload.accept else "rejected"

    if payload.accept:
        full_path = proposal.get("full_path")
        if not full_path and proposal.get("parent") and proposal.get("name"):
            full_path = f"{proposal['parent']}/{proposal['name']}"
        if not full_path:
            raise HTTPException(400, "invalid proposal data")
        try:
            created = ensure_folder_path(full_path)
            proposal["full_path"] = created
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # pragma: no cover - network interaction
            logger.error("Failed to create folder for proposal %s: %s", full_path, exc)
            raise HTTPException(500, f"could not create folder: {exc}") from exc

    updated = update_proposal(payload.message_uid, proposal)
    result = updated.proposal if updated else proposal
    return {"ok": True, "proposal": result}


@app.post("/api/move/bulk")
def api_move_bulk(payload: BulkMoveRequest) -> Dict[str, List[Dict[str, Any]]]:
    results = [api_move(item) for item in payload.items]
    return {"results": results}


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json({"type": "hello", "msg": "connected"})

    try:
        while True:
            try:
                snapshot = await _pending_overview()
                await ws.send_json({"type": "pending_overview", "payload": snapshot.dict()})
            except Exception as exc:  # pragma: no cover - network/IMAP interaction
                logger.warning("Failed to stream pending overview: %s", exc)
                await ws.send_json({"type": "pending_error", "error": str(exc)})
            await asyncio.sleep(5)
    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected")


@app.post("/api/rescan")
async def api_rescan(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    folders = payload.get("folders")
    if folders is not None and not isinstance(folders, list):
        raise HTTPException(400, "folders must be a list of folder names")
    target_folders = folders if folders is not None else get_monitored_folders()
    count = await one_shot_scan(target_folders)
    return {"ok": True, "new_suggestions": count}
