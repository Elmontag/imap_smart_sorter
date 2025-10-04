"""Helpers to compute pending (unprocessed) mailbox items."""

from __future__ import annotations

import asyncio
import email
from dataclasses import dataclass
from email import policy
from typing import List, Sequence

from database import known_suggestion_uids, processed_uids_by_folder
from mailbox import fetch_recent_messages
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
    pending: List[PendingMail]

    @property
    def pending_count(self) -> int:
        return len(self.pending)

    @property
    def pending_ratio(self) -> float:
        if self.total_messages == 0:
            return 0.0
        return self.pending_count / self.total_messages


async def load_pending_overview(folders: Sequence[str] | None = None) -> PendingOverview:
    """Return metadata about messages that have not been processed by the AI yet."""

    target_folders: List[str] = [str(folder) for folder in folders] if folders else [S.IMAP_INBOX]
    raw_payloads = await asyncio.to_thread(fetch_recent_messages, target_folders)
    processed_map = processed_uids_by_folder(target_folders)
    known_suggestions = known_suggestion_uids()

    pending_entries: List[PendingMail] = []
    total_messages = 0

    for folder, messages in raw_payloads.items():
        total_messages += len(messages)
        processed_for_folder = processed_map.get(folder, set())
        for uid, payload in messages.items():
            uid_str = str(uid)
            if uid_str in processed_for_folder or uid_str in known_suggestions:
                continue
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
    processed_count = max(total_messages - len(pending_entries), 0)
    return PendingOverview(total_messages=total_messages, processed_count=processed_count, pending=pending_entries)
