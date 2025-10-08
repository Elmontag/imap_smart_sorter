"""Helpers to compute pending (unprocessed) mailbox items."""

from __future__ import annotations

import asyncio
import email
from dataclasses import dataclass
from datetime import timezone
from email import policy
from email.utils import parsedate_to_datetime
from threading import Lock
from time import monotonic
from typing import Dict, List, Sequence, Set, Tuple

from database import (
    get_monitored_folders,
    known_suggestion_uids_by_folder,
    processed_uids_by_folder,
)
from mailbox import MessageContent, fetch_recent_messages
from settings import S
from utils import subject_from


@dataclass
class PendingMail:
    """Lightweight representation of a message that still awaits processing."""

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
    limit_active: bool

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


@dataclass
class _PendingCacheEntry:
    overview: PendingOverview
    list_limit: int
    limit_active: bool
    created_at: float


_pending_cache: Dict[Tuple[str, ...], _PendingCacheEntry] = {}
_pending_cache_lock = Lock()


def _resolve_cache_ttl() -> float:
    raw = getattr(S, "PENDING_CACHE_SECONDS", 0)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return max(value, 0.0)


def _resolve_fetch_window(list_limit: int, limit_active: bool) -> int | None:
    if limit_active:
        base = max(list_limit, 1)
        return max(base * 4, base + 50)
    raw = getattr(S, "PENDING_FETCH_LIMIT", 0)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value


def invalidate_pending_cache() -> None:
    with _pending_cache_lock:
        _pending_cache.clear()


async def load_pending_overview(
    folders: Sequence[str] | None = None,
    *,
    force_refresh: bool = False,
) -> PendingOverview:
    """Return metadata about messages that still await automated processing."""

    if folders is not None:
        target_folders = [str(folder).strip() for folder in folders if str(folder).strip()]
    else:
        configured = [str(folder).strip() for folder in get_monitored_folders() if str(folder).strip()]
        inbox = str(S.IMAP_INBOX).strip()
        target_folders = configured or [inbox]
    cache_key = tuple(sorted(target_folders))
    raw_limit = int(getattr(S, "PENDING_LIST_LIMIT", 0) or 0)
    list_limit = max(raw_limit, 0)
    limit_active = list_limit > 0

    cache_ttl = _resolve_cache_ttl()
    use_cache = cache_ttl > 0 and not force_refresh
    if use_cache:
        with _pending_cache_lock:
            cached = _pending_cache.get(cache_key)
        if (
            cached
            and cached.list_limit == list_limit
            and cached.limit_active == limit_active
            and monotonic() - cached.created_at < cache_ttl
        ):
            return cached.overview

    processed_map = processed_uids_by_folder(target_folders)
    suggestion_map = known_suggestion_uids_by_folder()

    target_lookup: Set[str] = set()
    for folder in target_folders:
        value = str(folder)
        if value:
            target_lookup.add(value)
            stripped = value.strip()
            if stripped:
                target_lookup.add(stripped)

    suggestion_uids: Set[str] = set()
    for key, values in suggestion_map.items():
        if key is None:
            suggestion_uids.update(str(uid).strip() for uid in values if str(uid).strip())
            continue
        normalized = str(key)
        stripped = normalized.strip()
        if normalized in target_lookup or stripped in target_lookup:
            suggestion_uids.update(str(uid).strip() for uid in values if str(uid).strip())

    fetch_window = _resolve_fetch_window(list_limit, limit_active)
    raw_payloads = await asyncio.to_thread(
        fetch_recent_messages,
        target_folders,
        processed_lookup=processed_map,
        skip_known_uids=suggestion_map,
        uid_limit=fetch_window,
        content_attribute=b"BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)]",
    )

    pending_entries: List[PendingMail] = []
    processed_total = sum(len(items) for items in processed_map.values())
    suggestion_total = len(suggestion_uids)

    for folder, messages in raw_payloads.items():
        lookup_key = str(folder).strip()
        processed_for_folder = processed_map.get(folder) or processed_map.get(lookup_key, set())
        for uid, meta in messages.items():
            uid_str = str(uid)
            if uid_str in processed_for_folder:
                continue
            if suggestion_uids and uid_str in suggestion_uids:
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

    def _sort_key(item: PendingMail) -> tuple[float, str, str]:
        parsed = None
        if item.date:
            try:
                parsed = parsedate_to_datetime(item.date)
            except (TypeError, ValueError, IndexError):
                parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            else:
                parsed = parsed.astimezone(timezone.utc)
            timestamp = parsed.timestamp()
        else:
            timestamp = 0.0
        return (-timestamp, item.folder.lower(), item.message_uid)

    pending_entries.sort(key=_sort_key)
    pending_total = len(pending_entries)
    processed_count = processed_total + suggestion_total

    if limit_active:
        visible_entries = pending_entries[:list_limit]
    else:
        visible_entries = pending_entries

    visible_entries = list(visible_entries)

    total_messages = pending_total + processed_count

    overview = PendingOverview(
        total_messages=total_messages,
        processed_count=processed_count,
        pending_total=pending_total,
        pending=visible_entries,
        list_limit=list_limit,
        limit_active=limit_active,
    )
    if cache_ttl > 0:
        entry = _PendingCacheEntry(
            overview=overview,
            list_limit=list_limit,
            limit_active=limit_active,
            created_at=monotonic(),
        )
        with _pending_cache_lock:
            _pending_cache[cache_key] = entry
    return overview
