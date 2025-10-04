
from typing import Optional, List, Dict, Any
from datetime import datetime
from sqlmodel import SQLModel, Field
from sqlalchemy import Column
from sqlalchemy.dialects.sqlite import JSON as SAJSON

class AppConfig(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    key: str
    value: str

class Suggestion(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_uid: str
    src_folder: Optional[str] = None
    subject: Optional[str] = None
    from_addr: Optional[str] = None
    date: Optional[str] = None
    thread_id: Optional[str] = None
    ranked: Optional[List[Dict[str, Any]]] = Field(default=None, sa_column=Column(SAJSON))
    proposal: Optional[Dict[str, Any]] = Field(default=None, sa_column=Column(SAJSON))
    status: str = "open"
    decision: Optional[str] = None
    decided_at: Optional[datetime] = None
    dry_run_result: Optional[Dict[str, Any]] = Field(default=None, sa_column=Column(SAJSON))
    move_status: Optional[str] = None
    move_error: Optional[str] = None

class FolderProfile(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    centroid: Optional[List[float]] = Field(default=None, sa_column=Column(SAJSON))
    sender_hist: Optional[Dict[str, int]] = Field(default=None, sa_column=Column(SAJSON))
    updated_at: datetime = Field(default_factory=datetime.utcnow)

class Processed(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    folder: str
    message_uid: str
