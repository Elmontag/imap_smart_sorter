"""Helpers to compute pending (unprocessed) mailbox items."""

from __future__ import annotations

import asyncio
import email
from dataclasses import dataclass
from email import policy
from typing import List, Sequence

from database import get_monitored_folders, known_suggestion_uids, processed_uids_by_folder
from mailbox import MessageContent, fetch_recent_messages
from settings import S
from utils import subject_from


@dataclass
class PendingMail:
    """Lightweight representation of a message without AI processing."""

    message_uid: str
    folder: str
    subject: str
    from_addr: str | None
    date: str | None


@dataclass
class PendingOverview:
    """Aggregated statistics about pending messages."""

    total_messages: int
    processed_count: int
    pending_total: int
    pending: List[PendingMail]
    list_limit: int

    @property
    def pending_count(self) -> int:
        return self.pending_total

    @property
    def pending_ratio(self) -> float:
        if self.total_messages == 0:
            return 0.0
        return self.pending_count / self.total_messages

    @property
    def displayed_pending(self) -> int:
        return len(self.pending)


async def load_pending_overview(folders: Sequence[str] | None = None) -> PendingOverview:
    """Return metadata about messages that have not been processed by the AI yet."""

    if folders is not None:
        target_folders: List[str] = [str(folder) for folder in folders if str(folder).strip()]
    else:
        configured = get_monitored_folders()
        target_folders = [str(folder) for folder in configured] or [S.IMAP_INBOX]
    raw_payloads = await asyncio.to_thread(fetch_recent_messages, target_folders)
    processed_map = processed_uids_by_folder(target_folders)
    known_suggestions = known_suggestion_uids()

    pending_entries: List[PendingMail] = []
    total_messages = 0
    list_limit = max(int(getattr(S, "PENDING_LIST_LIMIT", 0)), 0)

    for folder, messages in raw_payloads.items():
        total_messages += len(messages)
        processed_for_folder = processed_map.get(folder, set())
        for uid, meta in messages.items():
            uid_str = str(uid)
            if uid_str in processed_for_folder or uid_str in known_suggestions:
                continue
            payload = meta.body if isinstance(meta, MessageContent) else meta
            if not payload:
                continue
            msg = email.message_from_bytes(payload, policy=policy.default)
            subject, from_addr = subject_from(msg)
            pending_entries.append(
                PendingMail(
                    message_uid=uid_str,
                    folder=folder,
                    subject=subject or "",
                    from_addr=from_addr or None,
                    date=str(msg.get("Date")) if msg.get("Date") else None,
                )
            )

    pending_entries.sort(key=lambda item: (item.folder, item.message_uid))
    pending_total = len(pending_entries)
    processed_count = max(total_messages - pending_total, 0)

    if list_limit == 0:
        visible_entries: List[PendingMail] = []
    else:
        visible_entries = pending_entries[:list_limit]

    return PendingOverview(
        total_messages=total_messages,
        processed_count=processed_count,
        pending_total=pending_total,
        pending=visible_entries,
        list_limit=list_limit,
    )
