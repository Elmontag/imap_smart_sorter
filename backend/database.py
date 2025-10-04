
from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from typing import Iterator, List, Optional

from sqlmodel import Session, SQLModel, create_engine, select

from models import AppConfig, FolderProfile, Processed, Suggestion
from settings import S


os.makedirs("data", exist_ok=True)


def _make_engine():
    connect_args = {"check_same_thread": False} if S.DATABASE_URL.startswith("sqlite") else {}
    return create_engine(S.DATABASE_URL, echo=False, connect_args=connect_args)


engine = _make_engine()


def init_db() -> None:
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


def list_open_suggestions() -> List[Suggestion]:
    with get_session() as ses:
        return (
            ses.exec(
                select(Suggestion).where(Suggestion.status == "open").order_by(Suggestion.id.desc())
            ).all()
        )


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


def set_mode(mode: str) -> None:
    with get_session() as ses:
        entry = ses.exec(select(AppConfig).where(AppConfig.key == "MOVE_MODE")).first()
        if not entry:
            entry = AppConfig(key="MOVE_MODE", value=mode)
        else:
            entry.value = mode
        ses.add(entry)
        ses.commit()


def get_mode() -> Optional[str]:
    with get_session() as ses:
        entry = ses.exec(select(AppConfig).where(AppConfig.key == "MOVE_MODE")).first()
        return entry.value if entry else None


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
