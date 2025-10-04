
from contextlib import contextmanager
from typing import List, Optional
from sqlmodel import SQLModel, create_engine, Session, select
from models import Suggestion, FolderProfile, AppConfig
from settings import S
from models import Suggestion, FolderProfile, AppConfig, Processed
import os

os.makedirs("data", exist_ok=True)
engine = create_engine(S.DATABASE_URL, echo=False)

def init_db():
    SQLModel.metadata.create_all(engine)

@contextmanager
def get_session():
    with Session(engine) as session:
        yield session

def save_suggestion(sug: Suggestion):
    with get_session() as ses:
        q = ses.exec(select(Suggestion).where(Suggestion.message_uid == sug.message_uid)).first()
        if q:
            for k, v in sug.dict(exclude_unset=True).items():
                setattr(q, k, v)
            ses.add(q)
        else:
            ses.add(sug)
        ses.commit()

def list_open_suggestions() -> List[Suggestion]:
    with get_session() as ses:
        return ses.exec(select(Suggestion).where(Suggestion.status == "open")).all()

def find_suggestion_by_uid(uid: str) -> Optional[Suggestion]:
    with get_session() as ses:
        return ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()

def mark_moved(uid: str):
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if row:
            row.move_status = "moved"
            row.status = "decided"
            ses.add(row); ses.commit()

def mark_failed(uid: str, err: str):
    with get_session() as ses:
        row = ses.exec(select(Suggestion).where(Suggestion.message_uid == uid)).first()
        if row:
            row.move_status = "failed"
            row.move_error = err
            ses.add(row); ses.commit()

def set_mode(mode: str):
    with get_session() as ses:
        q = ses.exec(select(AppConfig).where(AppConfig.key == "MOVE_MODE")).first()
        if not q:
            q = AppConfig(key="MOVE_MODE", value=mode)
        else:
            q.value = mode
        ses.add(q); ses.commit()

def get_mode() -> Optional[str]:
    with get_session() as ses:
        q = ses.exec(select(AppConfig).where(AppConfig.key == "MOVE_MODE")).first()
        return q.value if q else None

def list_folder_profiles() -> List[FolderProfile]:
    with get_session() as ses:
        return ses.exec(select(FolderProfile)).all()

def upsert_folder_profile(name: str, centroid):
    with get_session() as ses:
        fp = ses.exec(select(FolderProfile).where(FolderProfile.name == name)).first()
        if not fp:
            fp = FolderProfile(name=name, centroid=centroid, sender_hist={})
        else:
            if fp.centroid and centroid and len(fp.centroid) == len(centroid):
                alpha = 0.2
                fp.centroid = [alpha*n + (1-alpha)*o for o,n in zip(fp.centroid, centroid)]
            else:
                fp.centroid = centroid
        ses.add(fp); ses.commit()
# ...

def is_processed(folder: str, uid: str) -> bool:
    with get_session() as ses:
        row = ses.exec(select(Processed).where(
            (Processed.folder==folder) & (Processed.message_uid==uid)
        )).first()
        return bool(row)

def mark_processed(folder: str, uid: str):
    with get_session() as ses:
        ses.add(Processed(folder=folder, message_uid=str(uid)))
        ses.commit()
