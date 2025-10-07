"""Calendar synchronisation settings helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from database import get_calendar_settings_entry, set_calendar_settings_entry
from settings import S


@dataclass
class CalendarSettings:
    enabled: bool
    caldav_url: str
    username: str
    calendar_name: str
    timezone: str
    processed_tag: str
    password: str | None = None

    def sanitized(self) -> "CalendarSettings":
        return CalendarSettings(
            enabled=self.enabled,
            caldav_url=self.caldav_url,
            username=self.username,
            calendar_name=self.calendar_name,
            timezone=self.timezone,
            processed_tag=self.processed_tag,
            password=None,
        )


def _base_defaults() -> Dict[str, Any]:
    return {
        "enabled": bool(S.CALENDAR_SYNC_ENABLED),
        "caldav_url": S.CALDAV_URL or "",
        "username": S.CALDAV_USERNAME or "",
        "calendar_name": S.CALDAV_CALENDAR or "",
        "timezone": S.CALENDAR_DEFAULT_TIMEZONE or "Europe/Berlin",
        "processed_tag": S.CALENDAR_PROCESSED_TAG or "Termin bearbeitet",
        "password": S.CALDAV_PASSWORD or "",
    }


def load_calendar_settings(include_password: bool = False) -> CalendarSettings:
    stored = _base_defaults()
    overrides = get_calendar_settings_entry()
    if overrides:
        stored.update({key: value for key, value in overrides.items() if value is not None})
    password_value = str(stored.get("password") or "").strip()
    settings = CalendarSettings(
        enabled=bool(stored.get("enabled", False)),
        caldav_url=str(stored.get("caldav_url") or "").strip(),
        username=str(stored.get("username") or "").strip(),
        calendar_name=str(stored.get("calendar_name") or "").strip(),
        timezone=str(stored.get("timezone") or "").strip() or "Europe/Berlin",
        processed_tag=str(stored.get("processed_tag") or "").strip() or "Termin bearbeitet",
        password=password_value if include_password and password_value else None,
    )
    return settings


def persist_calendar_settings(
    *,
    enabled: bool,
    caldav_url: str,
    username: str,
    calendar_name: str,
    timezone: str,
    processed_tag: str,
    password: str | None,
    clear_password: bool,
) -> CalendarSettings:
    current = get_calendar_settings_entry()
    payload: Dict[str, Any] = {
        "enabled": bool(enabled),
        "caldav_url": str(caldav_url or "").strip(),
        "username": str(username or "").strip(),
        "calendar_name": str(calendar_name or "").strip(),
        "timezone": str(timezone or "").strip() or "Europe/Berlin",
        "processed_tag": str(processed_tag or "").strip() or "Termin bearbeitet",
    }
    if clear_password:
        payload["password"] = ""
    elif password is not None:
        payload["password"] = password
    elif current and "password" in current:
        payload["password"] = current.get("password", "")
    set_calendar_settings_entry(payload)
    return load_calendar_settings(include_password=True)
