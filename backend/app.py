
from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from typing import Dict, Any
from settings import S
from database import init_db, list_open_suggestions, get_mode, set_mode, mark_moved, mark_failed, get_session, find_suggestion_by_uid
from models import Suggestion
from mailbox import list_folders, move_message, folder_exists
from fastapi import Body
from imap_worker import one_shot_scan

app = FastAPI(title="IMAP Smart Sorter")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def _startup():
    init_db()

@app.get("/api/mode")
def api_get_mode():
    return {"mode": get_mode() or S.MOVE_MODE}

@app.post("/api/mode")
def api_set_mode(body: Dict[str, Any]):
    mode = body.get("mode")
    if mode not in {"DRY_RUN","CONFIRM","AUTO"}:
        raise HTTPException(400, "invalid mode")
    set_mode(mode)
    return {"ok": True, "mode": mode}

@app.get("/api/folders")
def api_folders():
    return list_folders()

@app.get("/api/suggestions")
def api_suggestions():
    return [s.dict() for s in list_open_suggestions()]

@app.post("/api/decide")
def api_decide(body: Dict[str, Any]):
    uid = str(body["message_uid"])
    target = body["target_folder"]
    decision = body.get("decision","accept")
    row = find_suggestion_by_uid(uid)
    if not row:
        raise HTTPException(404, "suggestion not found")
    row.decision = decision
    row.decided_at = datetime.utcnow()
    with get_session() as ses:
        ses.add(row); ses.commit()
    if decision == "accept" and (get_mode() or S.MOVE_MODE) == "CONFIRM":
        return api_move({"message_uid": uid, "target_folder": target})
    return {"ok": True}

@app.post("/api/move")
def api_move(body: Dict[str, Any]):
    uid = str(body["message_uid"])
    target = body["target_folder"]
    dry_run = bool(body.get("dry_run", False)) or (get_mode() or S.MOVE_MODE) == "DRY_RUN"
    if dry_run:
        ok = folder_exists(target)
        row = find_suggestion_by_uid(uid)
        if row:
            row.dry_run_result = {"folder_exists": ok}
            with get_session() as ses:
                ses.add(row); ses.commit()
        return {"ok": ok, "dry_run": True, "checks": {"folder_exists": ok}}
    try:
        move_message(uid, target)
        mark_moved(uid)
        return {"ok": True, "dry_run": False}
    except Exception as e:
        mark_failed(uid, str(e))
        raise HTTPException(500, f"move failed: {e}")

@app.post("/api/move/bulk")
def api_move_bulk(body: Dict[str, Any]):
    results = []
    for it in body.get("items", []):
        results.append(api_move(it))
    return {"results": results}

@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    await ws.accept()
    await ws.send_json({"type":"hello","msg":"connected"})

@app.post("/api/rescan")
async def api_rescan(payload: dict = Body(default={})):
    folders = payload.get("folders")  # Optional: Liste von Ordnern
    count = await one_shot_scan(folders)
    return {"ok": True, "new_suggestions": count}
