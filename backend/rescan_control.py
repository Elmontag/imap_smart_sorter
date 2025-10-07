import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Sequence

from imap_worker import one_shot_scan

logger = logging.getLogger(__name__)


@dataclass
class RescanStatus:
    """Runtime information for the cancellable one-shot analysis."""

    active: bool = False
    folders: List[str] = field(default_factory=list)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    last_result_count: Optional[int] = None
    last_error: Optional[str] = None
    cancelled: bool = False


class RescanCancelledError(Exception):
    """Raised when an ongoing one-shot scan gets cancelled."""


class RescanBusyError(Exception):
    """Raised when a new one-shot scan is requested while one is active."""


class RescanController:
    """Manage a cancellable one-shot scan that can be stopped on demand."""

    def __init__(self) -> None:
        self._task: asyncio.Task[int] | None = None
        self._lock = asyncio.Lock()
        self._status = RescanStatus()

    @property
    def status(self) -> RescanStatus:
        return self._status

    async def run(self, folders: Sequence[str] | None = None) -> int:
        async with self._lock:
            if self._task and not self._task.done():
                raise RescanBusyError("one-shot scan already active")
            normalized = self._normalize_folders(folders)
            self._status.active = True
            self._status.cancelled = False
            self._status.started_at = datetime.utcnow()
            self._status.finished_at = None
            self._status.last_error = None
            self._status.last_result_count = None
            self._status.folders = list(normalized)
            task = asyncio.create_task(self._execute(normalized))
            self._task = task

        try:
            result = await task
            return result
        except asyncio.CancelledError as exc:  # pragma: no cover - cooperative cancellation
            raise RescanCancelledError() from exc
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

    async def _execute(self, folders: Sequence[str]) -> int:
        targets: Sequence[str] | None = folders if folders else None
        try:
            result = await one_shot_scan(targets)
            count = int(result)
            self._status.last_result_count = count
            return count
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive mailbox interaction
            logger.exception("One-shot scan failed")
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
            value = str(folder).strip()
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
        return normalized


controller = RescanController()

