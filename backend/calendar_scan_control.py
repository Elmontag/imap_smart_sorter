"""Asynchronous controller for continuous calendar mailbox scanning."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Sequence

from calendar_settings import load_calendar_settings
from calendar_sync import CalendarScanResult, scan_calendar_mailboxes
from database import get_monitored_folders
from settings import S


logger = logging.getLogger(__name__)


@dataclass
class CalendarScanStatus:
    """Runtime status information for the calendar auto-scan."""

    active: bool = False
    folders: List[str] = field(default_factory=list)
    poll_interval: float = float(getattr(S, "CALENDAR_POLL_INTERVAL_SECONDS", 900) or 900)
    last_started_at: Optional[datetime] = None
    last_finished_at: Optional[datetime] = None
    last_error: Optional[str] = None
    last_summary: Optional[CalendarScanResult] = None


class CalendarScanController:
    """Manage a cancellable background task for repeated calendar scans."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._status = CalendarScanStatus()

    @property
    def status(self) -> CalendarScanStatus:
        return self._status

    async def start(self, folders: Sequence[str] | None = None) -> bool:
        async with self._lock:
            if self._task and not self._task.done():
                return False

            normalized = self._normalize_folders(folders)
            self._status.active = True
            self._status.folders = list(normalized)
            self._status.last_error = None
            self._status.last_summary = None
            interval = float(getattr(S, "CALENDAR_POLL_INTERVAL_SECONDS", 900) or 900)
            self._status.poll_interval = interval if interval > 0 else 900.0

            self._task = asyncio.create_task(self._run(normalized if normalized else None))
            return True

    async def stop(self) -> bool:
        async with self._lock:
            if not self._task:
                return False
            task = self._task
            self._task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            self._status.active = False
            self._status.folders = []
        return True

    async def _run(self, folders: Optional[Sequence[str]]) -> None:
        interval = self._status.poll_interval or 900.0
        try:
            while True:
                targets = self._resolve_targets(folders)
                self._status.folders = list(targets)
                self._status.last_started_at = datetime.utcnow()
                try:
                    result = await scan_calendar_mailboxes(targets)
                    self._status.last_summary = result
                    self._status.last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # pragma: no cover - defensive mailbox interaction
                    logger.exception("Kalender-Autoscan fehlgeschlagen")
                    self._status.last_error = str(exc)
                finally:
                    self._status.last_finished_at = datetime.utcnow()
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.debug("Kalender-Scancontroller gestoppt")
            raise
        finally:
            self._status.active = False

    def _resolve_targets(self, folders: Optional[Sequence[str]]) -> List[str]:
        if folders:
            return [str(folder).strip() for folder in folders if str(folder).strip()]
        settings = load_calendar_settings(include_password=False)
        configured = [folder for folder in settings.source_folders if folder.strip()]
        if configured:
            return configured
        fallback = get_monitored_folders()
        if fallback:
            return [folder for folder in fallback if str(folder).strip()]
        return [getattr(S, "IMAP_INBOX", "INBOX")]

    def _normalize_folders(self, folders: Optional[Sequence[str]]) -> List[str]:
        if not folders:
            return []
        seen: set[str] = set()
        normalized: List[str] = []
        for folder in folders:
            value = str(folder or "").strip()
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
        return normalized


controller = CalendarScanController()

