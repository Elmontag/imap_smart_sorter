"""Controller for one-shot calendar scans that can be cancelled."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Sequence

from calendar_sync import CalendarScanResult, scan_calendar_mailboxes


logger = logging.getLogger(__name__)


@dataclass
class CalendarRescanStatus:
    """Runtime information about the most recent manual calendar scan."""

    active: bool = False
    folders: List[str] = field(default_factory=list)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    last_summary: Optional[CalendarScanResult] = None
    last_error: Optional[str] = None
    cancelled: bool = False


class CalendarRescanBusyError(Exception):
    """Raised when a manual scan is triggered while another is active."""


class CalendarRescanCancelledError(Exception):
    """Raised when a manual scan has been cancelled."""


class CalendarRescanController:
    """Manage cancellable one-shot calendar scans."""

    def __init__(self) -> None:
        self._task: asyncio.Task[CalendarScanResult] | None = None
        self._lock = asyncio.Lock()
        self._status = CalendarRescanStatus()

    @property
    def status(self) -> CalendarRescanStatus:
        return self._status

    async def run(self, folders: Sequence[str] | None = None) -> CalendarScanResult:
        async with self._lock:
            if self._task and not self._task.done():
                raise CalendarRescanBusyError("calendar scan already active")
            normalized = self._normalize_folders(folders)
            self._status.active = True
            self._status.cancelled = False
            self._status.started_at = datetime.utcnow()
            self._status.finished_at = None
            self._status.last_error = None
            self._status.last_summary = None
            self._status.folders = list(normalized)
            task = asyncio.create_task(self._execute(normalized))
            self._task = task

        try:
            result = await task
            return result
        except asyncio.CancelledError as exc:  # pragma: no cover - cooperative cancellation
            raise CalendarRescanCancelledError() from exc
        finally:
            await self._finalize()

    async def stop(self) -> bool:
        async with self._lock:
            task = self._task
            self._task = None
        if not task:
            return False

        self._status.cancelled = True
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:  # pragma: no cover - cooperative cancellation
            pass
        finally:
            await self._finalize(cancelled=True)
        return True

    async def _execute(self, folders: Sequence[str]) -> CalendarScanResult:
        targets: Sequence[str] | None = folders if folders else None
        try:
            result = await scan_calendar_mailboxes(targets)
            self._status.last_summary = result
            return result
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive mailbox interaction
            logger.exception("Kalender-Einzelscan fehlgeschlagen")
            self._status.last_error = str(exc)
            raise

    async def _finalize(self, cancelled: bool = False) -> None:
        self._status.active = False
        self._status.cancelled = self._status.cancelled or cancelled
        self._status.finished_at = datetime.utcnow()
        async with self._lock:
            self._task = None

    def _normalize_folders(self, folders: Sequence[str] | None) -> List[str]:
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


controller = CalendarRescanController()

