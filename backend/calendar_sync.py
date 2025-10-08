"""Calendar invitation scanning and CalDAV synchronisation."""

from __future__ import annotations

import asyncio
import email
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from email import policy
from typing import Iterable, List, Sequence, Tuple

from icalendar import Calendar  # type: ignore[import]
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from caldav import DAVClient  # type: ignore[import]
from caldav.lib.error import AuthorizationError, DAVError  # type: ignore[import]

from calendar_settings import load_calendar_settings
from database import (
    calendar_event_by_uid,
    calendar_event_metrics,
    get_calendar_event,
    list_calendar_events,
    update_calendar_event_status,
    upsert_calendar_event,
    get_monitored_folders,
)
from mailbox import MessageContent, add_message_tag, fetch_recent_messages, move_message
from models import CalendarEventEntry
from settings import S
from runtime_settings import resolve_mailbox_inbox
from utils import message_received_at, subject_from


logger = logging.getLogger(__name__)


@dataclass
class CalendarScanResult:
    scanned_messages: int
    processed_events: int
    created: int
    updated: int
    errors: List[str]


class CalendarImportError(RuntimeError):
    """Raised when the CalDAV import fails."""


def _load_user_timezone(name: str | None) -> ZoneInfo:
    fallback = "Europe/Berlin"
    candidate = (name or "").strip() or fallback
    try:
        return ZoneInfo(candidate)
    except ZoneInfoNotFoundError:
        logger.warning("Unbekannte Zeitzone %s – nutze UTC als Fallback", candidate)
        return ZoneInfo("UTC")


def _normalize_datetime(value: object, tz: ZoneInfo) -> Tuple[datetime | None, bool]:
    if value is None:
        return None, False
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=tz)
        return dt.astimezone(timezone.utc), False
    if isinstance(value, date):
        dt = datetime(value.year, value.month, value.day, tzinfo=tz)
        return dt.astimezone(timezone.utc), True
    return None, False


def _timezone_hint(component: object, fallback: str) -> str:
    if hasattr(component, "params"):
        params = getattr(component, "params")
        if isinstance(params, dict):
            tzid = params.get("TZID")
            if tzid:
                return str(tzid)
    return fallback


def _clean_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _clean_organizer(value: object | None) -> str | None:
    text = _clean_text(value)
    if not text:
        return None
    lowered = text.lower()
    if lowered.startswith("mailto:"):
        return text[6:]
    return text


def _iter_calendar_payloads(msg: email.message.Message) -> Iterable[str]:
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            filename = (part.get_filename() or "").lower()
            if content_type != "text/calendar" and not filename.endswith(".ics"):
                continue
            try:
                payload = part.get_payload(decode=True)
            except Exception:
                continue
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                yield payload.decode(charset, errors="ignore")
            except LookupError:
                yield payload.decode("utf-8", errors="ignore")
    else:
        payload = msg.get_payload(decode=True)
        if not payload:
            return
        charset = msg.get_content_charset() or "utf-8"
        try:
            yield payload.decode(charset, errors="ignore")
        except LookupError:
            yield payload.decode("utf-8", errors="ignore")


def _process_calendar_attachment(
    *,
    raw_ics: str,
    message_uid: str,
    folder: str,
    subject: str,
    from_addr: str | None,
    message_date: datetime | None,
    timezone_name: str,
) -> Tuple[int, int, int]:
    events_found = 0
    created = 0
    updated = 0
    try:
        calendar = Calendar.from_ical(raw_ics)
    except Exception as exc:
        logger.warning("ICS-Anhang konnte nicht geparst werden: %s", exc)
        return events_found, created, updated
    method = _clean_text(calendar.get("method"))
    tz_info = _load_user_timezone(timezone_name)
    for component in calendar.walk():
        if getattr(component, "name", "").upper() != "VEVENT":
            continue
        events_found += 1
        event_uid = _clean_text(component.get("uid"))
        if not event_uid:
            continue
        sequence_raw = component.get("sequence")
        try:
            sequence = int(sequence_raw) if sequence_raw is not None else None
        except (TypeError, ValueError):
            sequence = None
        dtstart_prop = component.get("dtstart")
        dtend_prop = component.get("dtend")
        timezone_hint = _timezone_hint(dtstart_prop, timezone_name)
        tz_for_entry = _load_user_timezone(timezone_hint)
        starts_at, all_day = _normalize_datetime(
            getattr(dtstart_prop, "dt", dtstart_prop), tz_for_entry
        )
        ends_at, _ = _normalize_datetime(getattr(dtend_prop, "dt", dtend_prop), tz_for_entry)
        status_text = _clean_text(component.get("status")) or ""
        is_cancelled = status_text.upper() == "CANCELLED" or (method or "").upper() == "CANCEL"
        summary = _clean_text(component.get("summary"))
        organizer = _clean_organizer(component.get("organizer"))
        location = _clean_text(component.get("location"))
        existing = calendar_event_by_uid(message_uid, event_uid)
        status = "pending"
        last_error = None
        last_import_at = None
        if existing:
            status = existing.status
            last_error = existing.last_error
            last_import_at = existing.last_import_at
            if sequence is not None and (existing.sequence or -1) < sequence:
                status = "pending"
                last_error = None
            elif existing.raw_ics != raw_ics or existing.cancellation != is_cancelled:
                status = "pending"
                last_error = None
        entry = upsert_calendar_event(
            CalendarEventEntry(
                id=existing.id if existing else None,
                message_uid=message_uid,
                folder=folder,
                subject=subject or None,
                from_addr=from_addr or None,
                message_date=message_date,
                event_uid=event_uid,
                sequence=sequence,
                summary=summary,
                organizer=organizer,
                location=location,
                starts_at=starts_at,
                ends_at=ends_at,
                all_day=all_day,
                timezone=timezone_hint,
                method=method,
                cancellation=is_cancelled,
                status=status,
                last_error=last_error,
                last_import_at=last_import_at,
                raw_ics=raw_ics,
            )
        )
        if existing is None:
            created += 1
        elif any(
            getattr(existing, field) != getattr(entry, field)
            for field in (
                "summary",
                "organizer",
                "location",
                "starts_at",
                "ends_at",
                "all_day",
                "timezone",
                "sequence",
                "status",
                "cancellation",
                "raw_ics",
            )
        ):
            updated += 1
    return events_found, created, updated


async def scan_calendar_mailboxes(folders: Sequence[str] | None = None) -> CalendarScanResult:
    configured = [folder for folder in (folders or []) if str(folder).strip()]
    if not configured:
        settings = load_calendar_settings(include_password=False)
        configured = [folder for folder in settings.source_folders if folder.strip()]
        if not configured:
            configured = get_monitored_folders()
    if not configured:
        configured = [resolve_mailbox_inbox()]
    payloads = await asyncio.to_thread(fetch_recent_messages, configured)
    timezone_name = load_calendar_settings(include_password=False).timezone
    seen_messages: set[str] = set()
    created_total = 0
    updated_total = 0
    processed_total = 0
    errors: List[str] = []
    for folder, messages in payloads.items():
        for uid, meta in messages.items():
            payload = meta.body if isinstance(meta, MessageContent) else meta
            if not payload:
                continue
            uid_str = str(uid)
            seen_messages.add(uid_str)
            try:
                msg = email.message_from_bytes(payload, policy=policy.default)
            except Exception as exc:
                logger.warning("E-Mail %s konnte nicht geparst werden: %s", uid_str, exc)
                errors.append(f"Mail {uid_str} konnte nicht gelesen werden: {exc}")
                continue
            subject, from_addr = subject_from(msg)
            received_at = message_received_at(msg)
            attachments = list(_iter_calendar_payloads(msg))
            if not attachments:
                continue
            for raw_ics in attachments:
                events_found, created, updated = _process_calendar_attachment(
                    raw_ics=raw_ics,
                    message_uid=uid_str,
                    folder=str(folder),
                    subject=subject,
                    from_addr=from_addr,
                    message_date=received_at,
                    timezone_name=timezone_name,
                )
                processed_total += events_found
                created_total += created
                updated_total += updated
    return CalendarScanResult(
        scanned_messages=len(seen_messages),
        processed_events=processed_total,
        created=created_total,
        updated=updated_total,
        errors=errors,
    )


def load_calendar_overview() -> Tuple[List[CalendarEventEntry], dict]:
    events = list_calendar_events()
    metrics = calendar_event_metrics()
    return events, metrics


def _select_calendar(client: DAVClient, calendar_name: str) -> object:
    principal = client.principal()
    calendars = principal.calendars()
    if not calendars:
        raise CalendarImportError("Auf dem CalDAV-Server wurde kein Kalender gefunden.")
    if calendar_name:
        normalized = calendar_name.strip().lower()
        for calendar in calendars:
            name = getattr(calendar, "name", None)
            if name and str(name).strip().lower() == normalized:
                return calendar
            try:
                display_name = calendar.get_properties(["{DAV:}displayname"]).get("{DAV:}displayname")
            except Exception:  # pragma: no cover - depends on library implementation
                display_name = None
            if display_name and str(display_name).strip().lower() == normalized:
                return calendar
    return calendars[0]


async def import_calendar_event(event_id: int) -> object:
    settings = load_calendar_settings(include_password=True)
    event = get_calendar_event(event_id)
    if not event:
        raise CalendarImportError("Kalendereintrag wurde nicht gefunden.")
    if not settings.enabled:
        raise CalendarImportError("Kalendersynchronisation ist deaktiviert.")
    if not settings.caldav_url:
        raise CalendarImportError("CalDAV-URL ist nicht konfiguriert.")
    if not event.raw_ics:
        raise CalendarImportError("Für diesen Eintrag liegt kein ICS-Anhang vor.")
    password = settings.password or ""
    try:
        client = DAVClient(settings.caldav_url, username=settings.username or None, password=password)
        calendar = _select_calendar(client, settings.calendar_name)
        await asyncio.to_thread(calendar.add_event, event.raw_ics)
    except AuthorizationError as exc:
        update_calendar_event_status(event.id, "failed", error=str(exc), imported_at=event.last_import_at)
        raise CalendarImportError("CalDAV-Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.") from exc
    except DAVError as exc:
        update_calendar_event_status(event.id, "failed", error=str(exc), imported_at=event.last_import_at)
        raise CalendarImportError(f"CalDAV-Fehler: {exc}") from exc
    except Exception as exc:  # pragma: no cover - network interaction
        update_calendar_event_status(event.id, "failed", error=str(exc), imported_at=event.last_import_at)
        raise CalendarImportError(f"Unbekannter Fehler beim Import: {exc}") from exc
    updated = update_calendar_event_status(event.id, "imported", error=None, imported_at=datetime.utcnow())
    if settings.processed_tag:
        try:
            inbox = resolve_mailbox_inbox()
            add_message_tag(event.message_uid, event.folder or inbox, settings.processed_tag)
        except Exception:  # pragma: no cover - network interaction
            logger.warning(
                "Tag %s konnte nach dem Import nicht gesetzt werden", settings.processed_tag, exc_info=True
            )
    if settings.processed_folder:
        try:
            move_message(
                event.message_uid,
                settings.processed_folder,
                src_folder=event.folder or resolve_mailbox_inbox(),
            )
        except Exception:  # pragma: no cover - network interaction
            logger.warning(
                "Terminmail %s konnte nicht nach %s verschoben werden",
                event.message_uid,
                settings.processed_folder,
                exc_info=True,
            )
    return updated if updated is not None else get_calendar_event(event.id)


async def validate_calendar_connection(
    *, caldav_url: str, username: str, password: str | None, calendar_name: str
) -> None:
    if not caldav_url.strip():
        raise CalendarImportError("CalDAV-URL fehlt für den Verbindungstest.")

    def _probe() -> None:
        client = DAVClient(caldav_url, username=username or None, password=password or "")
        _select_calendar(client, calendar_name)

    try:
        await asyncio.to_thread(_probe)
    except AuthorizationError as exc:
        raise CalendarImportError("CalDAV-Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.") from exc
    except DAVError as exc:
        raise CalendarImportError(f"CalDAV-Fehler: {exc}") from exc
    except Exception as exc:  # pragma: no cover - network interaction
        raise CalendarImportError(f"Unbekannter Fehler beim Verbindungstest: {exc}") from exc
