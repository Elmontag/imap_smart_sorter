import importlib
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest


MODULE_PREFIX = "backend."
MODULES = [
    "backend.settings",
    "backend.database",
    "backend.mail_settings",
    "backend.calendar_settings",
    "backend.calendar_sync",
    "backend.runtime_settings",
    "backend.ollama_service",
    "backend.app",
]


def _install_calendar_stub() -> None:
    if "icalendar" in sys.modules:
        return

    class _FakeDateTime:
        def __init__(self, value: datetime | None) -> None:
            self.dt = value

    def _parse_datetime(value: str) -> datetime | None:
        stripped = value.strip()
        if not stripped:
            return None
        formats = ["%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S", "%Y%m%d"]
        for fmt in formats:
            try:
                dt = datetime.strptime(stripped, fmt)
                return dt.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        return None

    class _FakeEvent:
        name = "VEVENT"

        def __init__(self, payload: dict[str, str]) -> None:
            self._payload = payload

        def get(self, key: str) -> object | None:
            normalized = key.upper()
            if normalized in {"DTSTART", "DTEND"}:
                raw = self._payload.get(normalized)
                if raw is None:
                    return None
                return _FakeDateTime(_parse_datetime(raw))
            if normalized == "ORGANIZER":
                raw = self._payload.get(normalized)
                if raw is None:
                    return None
                return f"mailto:{raw}" if not raw.lower().startswith("mailto:") else raw
            if normalized == "SEQUENCE":
                raw = self._payload.get(normalized)
                if raw is None:
                    return None
                try:
                    return int(raw)
                except ValueError:
                    return None
            return self._payload.get(normalized)

    class _FakeCalendar:
        def __init__(self, method: str | None, events: list[_FakeEvent]) -> None:
            self._method = method
            self._events = events

        def get(self, key: str, default: object | None = None) -> object | None:
            if key.upper() == "METHOD":
                return self._method or default
            return default

        def walk(self):
            return list(self._events)

        @classmethod
        def from_ical(cls, raw: str) -> "_FakeCalendar":
            method: str | None = None
            current: dict[str, str] | None = None
            events: list[_FakeEvent] = []
            for line in raw.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                upper = stripped.upper()
                if upper == "BEGIN:VEVENT":
                    current = {}
                    continue
                if upper == "END:VEVENT":
                    if current is not None:
                        events.append(_FakeEvent(current))
                        current = None
                    continue
                if ":" not in stripped:
                    continue
                key, value = stripped.split(":", 1)
                normalized_key = key.upper()
                if current is None:
                    if normalized_key == "METHOD":
                        method = value.strip()
                    continue
                stored_value = value.strip()
                if normalized_key == "ORGANIZER":
                    stored_value = stored_value.split(":", 1)[1] if ":" in stored_value else stored_value
                current[normalized_key] = stored_value
            return cls(method, events)

    module = types.ModuleType("icalendar")
    module.Calendar = _FakeCalendar  # type: ignore[attr-defined]
    sys.modules["icalendar"] = module


def _install_caldav_stub() -> None:
    if "caldav" in sys.modules:
        return
    caldav_module = types.ModuleType("caldav")

    class _DummyClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("Dummy DAVClient should be patched in tests")

    caldav_module.DAVClient = _DummyClient  # type: ignore[attr-defined]

    lib_module = types.ModuleType("caldav.lib")
    error_module = types.ModuleType("caldav.lib.error")

    class _AuthorizationError(Exception):
        pass

    class _DAVError(Exception):
        pass

    error_module.AuthorizationError = _AuthorizationError  # type: ignore[attr-defined]
    error_module.DAVError = _DAVError  # type: ignore[attr-defined]
    lib_module.error = error_module  # type: ignore[attr-defined]

    caldav_module.lib = lib_module  # type: ignore[attr-defined]

    sys.modules["caldav"] = caldav_module
    sys.modules["caldav.lib"] = lib_module
    sys.modules["caldav.lib.error"] = error_module


@pytest.fixture()
def backend_env(tmp_path, monkeypatch):
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    backend_path = project_root / "backend"
    if str(backend_path) not in sys.path:
        sys.path.insert(0, str(backend_path))

    monkeypatch.chdir(tmp_path)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    db_path = data_dir / "app.db"

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("INIT_RUN", "0")
    monkeypatch.setenv("ANALYSIS_MODULE", "STATIC")

    _install_calendar_stub()
    _install_caldav_stub()

    for name in list(sys.modules):
        if name == "backend" or name.startswith(MODULE_PREFIX):
            sys.modules.pop(name)

    modules = {}
    for module_name in MODULES:
        modules[module_name] = importlib.import_module(module_name)

    modules["backend.database"].init_db()

    return {
        "settings": modules["backend.settings"],
        "database": modules["backend.database"],
        "mail_settings": modules["backend.mail_settings"],
        "calendar_settings": modules["backend.calendar_settings"],
        "calendar_sync": modules["backend.calendar_sync"],
        "runtime_settings": modules["backend.runtime_settings"],
        "ollama_service": modules["backend.ollama_service"],
        "app_module": modules["backend.app"],
        "data_dir": data_dir,
    }
