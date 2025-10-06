
from __future__ import annotations

from datetime import datetime, timezone
from email.header import decode_header
from email.message import Message
from email.utils import parsedate_to_datetime


def extract_text(msg: Message) -> str:
    if msg.is_multipart():
        parts: list[str] = []
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype == "text/plain":
                try:
                    payload = part.get_payload(decode=True)
                    text = (payload or b"").decode(part.get_content_charset() or "utf-8", errors="ignore")
                    parts.append(text)
                except Exception:
                    continue
        return "\n".join(parts)[:16000]
    try:
        return (msg.get_payload(decode=True) or b"").decode("utf-8", errors="ignore")[:16000]
    except Exception:
        return ""


def subject_from(msg: Message) -> tuple[str, str]:
    subj = msg.get("Subject", "")
    decoded = ""
    for value, encoding in decode_header(subj):
        if isinstance(value, bytes):
            decoded += value.decode(encoding or "utf-8", errors="ignore")
        else:
            decoded += value
    from_addr = msg.get("From", "")
    return decoded, from_addr


def thread_headers(msg: Message) -> dict[str, str | None]:
    return {
        "message_id": msg.get("Message-Id"),
        "in_reply_to": msg.get("In-Reply-To"),
        "references": msg.get("References"),
    }


def message_received_at(msg: Message) -> datetime | None:
    raw_date = msg.get("Date")
    if not raw_date:
        return None
    try:
        parsed = parsedate_to_datetime(raw_date)
    except (TypeError, ValueError, IndexError):
        return None
    if not parsed:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
