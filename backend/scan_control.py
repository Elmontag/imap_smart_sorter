import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Sequence

from database import get_monitored_folders
from imap_worker import one_shot_scan
from settings import S
from runtime_settings import resolve_poll_interval_seconds

logger = logging.getLogger(__name__)


@dataclass
class ScanStatus:
    """Holds runtime information about the mailbox scan controller."""

    active: bool = False
    folders: List[str] = field(default_factory=list)
    poll_interval: float = field(default_factory=resolve_poll_interval_seconds)
    last_started_at: Optional[datetime] = None
    last_finished_at: Optional[datetime] = None
    last_error: Optional[str] = None
    last_result_count: Optional[int] = None


class ScanController:
    """Manage a cancellable background task that repeatedly scans the mailbox."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task[None]] = None
        self._lock = asyncio.Lock()
        self._status = ScanStatus()

    @property
    def status(self) -> ScanStatus:
        return self._status

    async def start(self, folders: Optional[Sequence[str]] = None) -> bool:
        async with self._lock:
            if self._task and not self._task.done():
                return False

            normalized = self._normalize_folders(folders)
            self._status.active = True
            self._status.folders = list(normalized)
            self._status.last_error = None
            self._status.last_result_count = None
            interval = resolve_poll_interval_seconds()
            self._status.poll_interval = interval

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
        try:
            while True:
                interval = resolve_poll_interval_seconds()
                self._status.poll_interval = interval
                current_targets = self._resolve_targets(folders)
                self._status.folders = current_targets
                self._status.last_started_at = datetime.utcnow()
                try:
                    result = await one_shot_scan(current_targets)
                    self._status.last_result_count = int(result)
                    self._status.last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # pragma: no cover - defensive mailbox interaction
                    logger.exception("Scan iteration failed")
                    self._status.last_error = str(exc)
                finally:
                    self._status.last_finished_at = datetime.utcnow()
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.debug("Scan controller cancelled")
            raise
        finally:
            self._status.active = False

    def _resolve_targets(self, folders: Optional[Sequence[str]]) -> List[str]:
        if folders:
            return [segment.strip() for segment in folders if str(segment).strip()]
        configured = get_monitored_folders()
        if configured:
            return [folder for folder in configured if folder.strip()]
        inbox = getattr(S, "IMAP_INBOX", "INBOX")
        return [inbox]

    def _normalize_folders(self, folders: Optional[Sequence[str]]) -> List[str]:
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


controller = ScanController()
