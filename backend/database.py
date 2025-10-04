
from __future__ import annotations

import json
import logging
import os
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional, Sequence, Set

from sqlalchemy import func
from sqlmodel import Session, SQLModel, create_engine, select

from models import AppConfig, FolderProfile, Processed, Suggestion
from settings import S


os.makedirs("data", exist_ok=True)


logger = logging.getLogger(__name__)


def _make_engine():
    connect_args = {"check_same_thread": False} if S.DATABASE_URL.startswith("sqlite") else {}
    return create_engine(S.DATABASE_URL, echo=False, connect_args=connect_args)


engine = _make_engine()


def _reset_sqlite_file() -> None:
    if not S.DATABASE_URL.startswith("sqlite:///"):
        return
    path = S.DATABASE_URL.replace("sqlite:///", "", 1)
    if not path:
        return
    try:
        engine.dispose()
    except Exception:
        logger.debug("Failed to dispose engine before reset", exc_info=True)
    if os.path.exists(path):
        try:
            os.remove(path)
        except FileNotFoundError:
            return
        except OSError as exc:
            logger.warning("Konnte SQLite-Datei %s nicht löschen: %s", path, exc)


def init_db() -> None:
    if S.INIT_RUN:
        logger.info("INIT_RUN aktiv – Datenbank wird zurückgesetzt")
        SQLModel.metadata.drop_all(engine)
        if S.DATABASE_URL.startswith("sqlite:///"):
            _reset_sqlite_file()
    SQLModel.metadata.create_all(engine)


@contextmanager
def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


def save_suggestion(sug: Suggestion) -> None:
    with get_session() as ses:
        existing = ses.exec(
            select(Suggestion).where(Suggestion.message_uid == sug.message_uid)
        ).first()
        if existing:
            data = sug.dict(exclude_unset=True)
            for key, value in data.items():
                setattr(existing, key, value)
            ses.add(existing)
        else:
            ses.add(sug)
        ses.commit()


def list_suggestions(include_all: bool = False) -> List[Suggestion]:
    with get_session() as ses:
        stmt = select(Suggestion).order_by(Suggestion.id.desc())
        if not include_all:
            stmt = stmt.where(Suggestion.status == "open")
        return ses.exec(stmt).all()


def suggestion_status_counts() -> Dict[str, int]:
    counts = {"open": 0, "decided": 0, "error": 0}
    total = 0
    with get_session() as ses:
        rows = ses.exec(select(Suggestion.status, func.count()).group_by(Suggestion.status)).all()
        for status, amount in rows:
            count = int(amount or 0)
            normalized = (status or "open").strip().lower()
            if normalized == "open":
                counts["open"] += count
            elif normalized == "error":
                counts["error"] += count
            else:
                counts["decided"] += count
            total += count
    counts["total"] = total
    return counts


def find_suggestion_by_uid(uid: str) -> Optional[Suggestion]:
    with get_session() as ses:
        return ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()


def record_decision(uid: str, decision: str) -> Optional[Suggestion]:
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if not row:
            return None
        row.decision = decision
        row.decided_at = datetime.utcnow()
        if decision == "reject":
            row.status = "decided"
            row.move_status = "rejected"
        ses.add(row)
        ses.commit()
        ses.refresh(row)
        return row


def record_dry_run(uid: str, result: dict) -> None:
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if row:
            row.dry_run_result = result
            ses.add(row)
            ses.commit()


def mark_moved(uid: str) -> None:
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if row:
            row.move_status = "moved"
            row.status = "decided"
            ses.add(row)
            ses.commit()


def mark_failed(uid: str, err: str) -> None:
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if row:
            row.move_status = "failed"
            row.move_error = err
            row.status = "error"
            ses.add(row)
            ses.commit()


def _set_config_value(key: str, value: str) -> None:
    with get_session() as ses:
        entry = ses.exec(select(AppConfig).where(AppConfig.key == key)).first()
        if not entry:
            entry = AppConfig(key=key, value=value)
        else:
            entry.value = value
        ses.add(entry)
        ses.commit()


def _get_config_value(key: str) -> Optional[str]:
    with get_session() as ses:
        entry = ses.exec(select(AppConfig).where(AppConfig.key == key)).first()
        return entry.value if entry else None


def set_mode(mode: str) -> None:
    _set_config_value("MOVE_MODE", mode)


def get_mode() -> Optional[str]:
    return _get_config_value("MOVE_MODE")


def set_monitored_folders(folders: Sequence[str]) -> None:
    unique = list(dict.fromkeys(str(folder) for folder in folders if str(folder).strip()))
    payload = json.dumps(unique)
    _set_config_value("MONITORED_FOLDERS", payload)


def get_monitored_folders() -> List[str]:
    raw = _get_config_value("MONITORED_FOLDERS")
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return [str(folder) for folder in data if isinstance(folder, str) and folder.strip()]


def update_proposal(uid: str, proposal: Dict[str, Any] | None) -> Optional[Suggestion]:
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if not row:
            return None
        row.proposal = proposal
        ses.add(row)
        ses.commit()
        ses.refresh(row)
        return row


def list_folder_profiles() -> List[FolderProfile]:
    with get_session() as ses:
        return ses.exec(select(FolderProfile)).all()


def upsert_folder_profile(name: str, centroid) -> None:
    with get_session() as ses:
        profile = ses.exec(select(FolderProfile).where(FolderProfile.name == name)).first()
        if not profile:
            profile = FolderProfile(name=name, centroid=centroid, sender_hist={})
        elif profile.centroid and centroid and len(profile.centroid) == len(centroid):
            alpha = 0.2
            profile.centroid = [alpha * new + (1 - alpha) * old for old, new in zip(profile.centroid, centroid)]
        else:
            profile.centroid = centroid
        ses.add(profile)
        ses.commit()


def is_processed(folder: str, uid: str) -> bool:
    with get_session() as ses:
        row = ses.exec(
            select(Processed).where((Processed.folder == folder) & (Processed.message_uid == uid))
        ).first()
        return bool(row)


def mark_processed(folder: str, uid: str) -> None:
    with get_session() as ses:
        ses.add(Processed(folder=folder, message_uid=str(uid)))
        ses.commit()


def processed_uids_by_folder(folders: Sequence[str]) -> Dict[str, Set[str]]:
    unique_folders = {str(folder) for folder in folders if folder}
    if not unique_folders:
        return {}
    with get_session() as ses:
        rows = ses.exec(select(Processed).where(Processed.folder.in_(unique_folders))).all()
        mapping: Dict[str, Set[str]] = {folder: set() for folder in unique_folders}
        for row in rows:
            mapping.setdefault(row.folder, set()).add(str(row.message_uid))
        return mapping


def known_suggestion_uids() -> Set[str]:
    with get_session() as ses:
        rows = ses.exec(select(Suggestion)).all()
        return {str(row.message_uid) for row in rows if row.message_uid}
