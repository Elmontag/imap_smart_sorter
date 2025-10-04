"""FastAPI application for the IMAP Smart Sorter backend."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List

from fastapi import Body, FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from database import (
    find_suggestion_by_uid,
    get_mode,
    init_db,
    list_open_suggestions,
    mark_failed,
    mark_moved,
    record_decision,
    record_dry_run,
    set_mode,
)
from imap_worker import one_shot_scan
from mailbox import folder_exists, list_folders, move_message
from models import Suggestion
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


app = FastAPI(title="IMAP Smart Sorter")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


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


@app.get("/api/folders")
def api_folders() -> List[str]:
    return list_folders()


@app.get("/api/suggestions", response_model=SuggestionsResponse)
def api_suggestions() -> SuggestionsResponse:
    return SuggestionsResponse(suggestions=list_open_suggestions())


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


@app.post("/api/move/bulk")
def api_move_bulk(payload: BulkMoveRequest) -> Dict[str, List[Dict[str, Any]]]:
    results = [api_move(item) for item in payload.items]
    return {"results": results}


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json({"type": "hello", "msg": "connected"})


@app.post("/api/rescan")
async def api_rescan(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    folders = payload.get("folders")
    if folders is not None and not isinstance(folders, list):
        raise HTTPException(400, "folders must be a list of folder names")
    count = await one_shot_scan(folders)
    return {"ok": True, "new_suggestions": count}
