
from __future__ import annotations

import json
import logging
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, Iterator, List, Optional, Sequence, Set

from sqlalchemy import func
from sqlmodel import Session, SQLModel, create_engine, select

from models import AppConfig, CalendarEventEntry, FilterHit, FolderProfile, Processed, Suggestion
from settings import S


os.makedirs("data", exist_ok=True)


logger = logging.getLogger(__name__)


def _make_engine():
    connect_args = {"check_same_thread": False} if S.DATABASE_URL.startswith("sqlite") else {}
    return create_engine(S.DATABASE_URL, echo=False, connect_args=connect_args)


engine = _make_engine()


_schema_lock = threading.Lock()
_schema_ready = False


def _ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        SQLModel.metadata.create_all(engine)
        _schema_ready = True


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
    global _schema_ready
    with _schema_lock:
        if S.INIT_RUN:
            logger.info("INIT_RUN aktiv – Datenbank wird zurückgesetzt")
            SQLModel.metadata.drop_all(engine)
            _schema_ready = False
            if S.DATABASE_URL.startswith("sqlite:///"):
                _reset_sqlite_file()
        SQLModel.metadata.create_all(engine)
        _schema_ready = True


@contextmanager
def get_session() -> Iterator[Session]:
    _ensure_schema()
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


def get_mode_override() -> Optional[str]:
    value = _get_config_value("MOVE_MODE")
    return value.strip() if isinstance(value, str) and value.strip() else None


def set_classifier_model(model: str) -> None:
    normalized = str(model or "").strip()
    if not normalized:
        raise ValueError("classifier model must not be empty")
    _set_config_value("CLASSIFIER_MODEL", normalized)


def get_classifier_model() -> Optional[str]:
    value = _get_config_value("CLASSIFIER_MODEL")
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def get_calendar_settings_entry() -> Dict[str, Any]:
    raw = _get_config_value("CALENDAR_SETTINGS")
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Persistierte Kalenderkonfiguration konnte nicht geparst werden.")
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def set_calendar_settings_entry(values: Dict[str, Any]) -> None:
    payload = json.dumps(values, ensure_ascii=False)
    _set_config_value("CALENDAR_SETTINGS", payload)


def calendar_event_by_uid(message_uid: str, event_uid: str) -> Optional[CalendarEventEntry]:
    with get_session() as ses:
        return ses.exec(
            select(CalendarEventEntry)
            .where(CalendarEventEntry.message_uid == message_uid)
            .where(CalendarEventEntry.event_uid == event_uid)
        ).first()


def get_calendar_event(event_id: int) -> Optional[CalendarEventEntry]:
    with get_session() as ses:
        return ses.get(CalendarEventEntry, event_id)


def upsert_calendar_event(entry: CalendarEventEntry) -> CalendarEventEntry:
    with get_session() as ses:
        existing = ses.exec(
            select(CalendarEventEntry)
            .where(CalendarEventEntry.message_uid == entry.message_uid)
            .where(CalendarEventEntry.event_uid == entry.event_uid)
        ).first()
        payload = entry.dict(exclude_unset=True)
        payload.pop("id", None)
        timestamp = datetime.utcnow()
        if existing:
            for key, value in payload.items():
                setattr(existing, key, value)
            existing.updated_at = timestamp
            ses.add(existing)
            ses.commit()
            ses.refresh(existing)
            return existing
        entry.updated_at = timestamp
        entry.created_at = timestamp
        ses.add(entry)
        ses.commit()
        ses.refresh(entry)
        return entry


def list_calendar_events() -> List[CalendarEventEntry]:
    with get_session() as ses:
        stmt = select(CalendarEventEntry).order_by(
            CalendarEventEntry.starts_at,
            CalendarEventEntry.summary,
        )
        return ses.exec(stmt).all()


def update_calendar_event_status(
    event_id: int,
    status: str,
    *,
    error: Optional[str] = None,
    imported_at: Optional[datetime] = None,
) -> Optional[CalendarEventEntry]:
    with get_session() as ses:
        row = ses.get(CalendarEventEntry, event_id)
        if not row:
            return None
        row.status = status
        row.last_error = error
        row.last_import_at = imported_at
        row.updated_at = datetime.utcnow()
        ses.add(row)
        ses.commit()
        ses.refresh(row)
        return row


def _count_from_result(value: object) -> int:
    if isinstance(value, tuple):
        value = value[0]
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def calendar_event_metrics() -> Dict[str, int]:
    with get_session() as ses:
        total = ses.exec(select(func.count(CalendarEventEntry.id))).one()
        pending = ses.exec(
            select(func.count(CalendarEventEntry.id)).where(CalendarEventEntry.status == "pending")
        ).one()
        imported = ses.exec(
            select(func.count(CalendarEventEntry.id)).where(CalendarEventEntry.status == "imported")
        ).one()
        failed = ses.exec(
            select(func.count(CalendarEventEntry.id)).where(CalendarEventEntry.status == "failed")
        ).one()
        scanned_messages = ses.exec(
            select(func.count(func.distinct(CalendarEventEntry.message_uid)))
        ).one()
    return {
        "total": _count_from_result(total),
        "pending": _count_from_result(pending),
        "imported": _count_from_result(imported),
        "failed": _count_from_result(failed),
        "scanned_messages": _count_from_result(scanned_messages),
    }


def set_analysis_module(module: str) -> None:
    normalized = str(module or "").strip().upper()
    if not normalized:
        raise ValueError("analysis module must not be empty")
    _set_config_value("ANALYSIS_MODULE", normalized)


def get_analysis_module_override() -> Optional[str]:
    value = _get_config_value("ANALYSIS_MODULE")
    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    return normalized or None


def set_mailbox_tags(protected: str | None, processed: str | None, ai_prefix: str | None) -> None:
    payload = json.dumps(
        {
            "protected": (protected or "").strip(),
            "processed": (processed or "").strip(),
            "ai_prefix": (ai_prefix or "").strip(),
        }
    )
    _set_config_value("MAILBOX_TAGS", payload)


def get_mailbox_tags() -> tuple[str | None, str | None, str | None]:
    raw = _get_config_value("MAILBOX_TAGS")
    if not raw:
        return (None, None, None)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return (None, None, None)
    protected = str(data.get("protected", "")).strip() or None
    processed = str(data.get("processed", "")).strip() or None
    ai_prefix = str(data.get("ai_prefix", "")).strip() or None
    return (protected, processed, ai_prefix)


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


def record_filter_hit(
    message_uid: str,
    rule_name: str,
    src_folder: str | None,
    target_folder: str,
    applied_tags: Sequence[str] | None,
    matched_terms: Sequence[str] | None,
    message_date: datetime | None,
) -> None:
    with get_session() as ses:
        entry = FilterHit(
            message_uid=str(message_uid),
            rule_name=rule_name,
            src_folder=src_folder,
            target_folder=target_folder,
            applied_tags=[str(tag) for tag in applied_tags or [] if str(tag).strip()],
            matched_terms=[str(term) for term in matched_terms or [] if str(term).strip()],
            message_date=message_date,
        )
        ses.add(entry)
        ses.commit()


def filter_activity_summary(
    window_days: int = 7,
    recent_limit: int = 10,
) -> Dict[str, Any]:
    now = datetime.utcnow()
    window_cutoff = now - timedelta(days=max(window_days, 0)) if window_days > 0 else None
    day_cutoff = now - timedelta(days=1)

    with get_session() as ses:
        total_result = ses.exec(select(func.count()).select_from(FilterHit)).one()
        total_hits = int(total_result[0] if isinstance(total_result, tuple) else total_result or 0)

        last_day_result = ses.exec(
            select(func.count()).where(FilterHit.matched_at >= day_cutoff)
        ).one()
        hits_last_24h = int(last_day_result[0] if isinstance(last_day_result, tuple) else last_day_result or 0)

        base_stmt = select(
            FilterHit.rule_name,
            FilterHit.target_folder,
            func.count().label("count"),
            func.max(FilterHit.matched_at).label("last_match"),
        )
        if window_cutoff:
            base_stmt = base_stmt.where(FilterHit.matched_at >= window_cutoff)
        rule_rows = ses.exec(
            base_stmt.group_by(FilterHit.rule_name, FilterHit.target_folder).order_by(func.count().desc())
        ).all()

        recent_stmt = select(FilterHit).order_by(FilterHit.matched_at.desc())
        if recent_limit > 0:
            recent_stmt = recent_stmt.limit(recent_limit)
        recent_rows = ses.exec(recent_stmt).all()

    rules: List[Dict[str, Any]] = []
    for rule_name, target_folder, count, last_match in rule_rows:
        rules.append(
            {
                "name": rule_name,
                "target_folder": target_folder,
                "count": int(count or 0),
                "last_match": (last_match.isoformat() if isinstance(last_match, datetime) else None),
            }
        )

    recent: List[Dict[str, Any]] = []
    for row in recent_rows:
        recent.append(
            {
                "message_uid": row.message_uid,
                "rule_name": row.rule_name,
                "src_folder": row.src_folder,
                "target_folder": row.target_folder,
                "applied_tags": row.applied_tags or [],
                "matched_terms": row.matched_terms or [],
                "matched_at": row.matched_at.isoformat(),
                "message_date": row.message_date.isoformat() if row.message_date else None,
            }
        )

    return {
        "total_hits": total_hits,
        "hits_last_24h": hits_last_24h,
        "rules": rules,
        "recent": recent,
        "window_days": max(window_days, 0),
    }
