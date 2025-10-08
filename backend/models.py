
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
    category: Optional[Dict[str, Any]] = Field(default=None, sa_column=Column(SAJSON))
    tags: Optional[List[str]] = Field(default=None, sa_column=Column(SAJSON))
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


class FilterHit(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_uid: str
    rule_name: str
    src_folder: Optional[str] = None
    target_folder: str
    applied_tags: Optional[List[str]] = Field(default=None, sa_column=Column(SAJSON))
    matched_terms: Optional[List[str]] = Field(default=None, sa_column=Column(SAJSON))
    message_date: Optional[datetime] = None
    matched_at: datetime = Field(default_factory=datetime.utcnow)


class CalendarEventEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_uid: str
    folder: str
    subject: Optional[str] = None
    from_addr: Optional[str] = None
    message_date: Optional[datetime] = None
    event_uid: str
    sequence: Optional[int] = None
    summary: Optional[str] = None
    organizer: Optional[str] = None
    location: Optional[str] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    all_day: bool = False
    timezone: Optional[str] = None
    method: Optional[str] = None
    cancellation: bool = False
    status: str = "pending"
    last_error: Optional[str] = None
    last_import_at: Optional[datetime] = None
    raw_ics: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
