from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from imapclient import IMAPClient

from database import get_mailbox_settings_entry, set_mailbox_settings_entry
from settings import S


@dataclass
class MailboxSettings:
    host: str
    port: int
    username: str
    inbox: str
    use_ssl: bool
    process_only_seen: bool
    since_days: int
    password: str | None = None

    def sanitized(self) -> "MailboxSettings":
        return MailboxSettings(
            host=self.host,
            port=self.port,
            username=self.username,
            inbox=self.inbox,
            use_ssl=self.use_ssl,
            process_only_seen=self.process_only_seen,
            since_days=self.since_days,
            password=None,
        )


def _base_defaults() -> Dict[str, Any]:
    return {
        "host": S.IMAP_HOST or "localhost",
        "port": int(getattr(S, "IMAP_PORT", 993) or 993),
        "username": S.IMAP_USERNAME or "",
        "password": S.IMAP_PASSWORD or "",
        "inbox": S.IMAP_INBOX or "INBOX",
        "use_ssl": bool(getattr(S, "IMAP_USE_SSL", True)),
        "process_only_seen": bool(getattr(S, "PROCESS_ONLY_SEEN", False)),
        "since_days": int(getattr(S, "SINCE_DAYS", 30) or 30),
    }


def _normalize_port(value: Any) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError("Port muss eine Zahl sein.") from None
    if port <= 0 or port > 65535:
        raise ValueError("Port muss zwischen 1 und 65535 liegen.")
    return port


def _normalize_since_days(value: Any) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        raise ValueError("Zeitraum (Tage) muss eine Zahl sein.") from None
    if days < 0:
        raise ValueError("Zeitraum (Tage) darf nicht negativ sein.")
    return days


def load_mailbox_settings(include_password: bool = False) -> MailboxSettings:
    stored = _base_defaults()
    overrides = get_mailbox_settings_entry()
    if overrides:
        stored.update({key: value for key, value in overrides.items() if value is not None})
    password_value = str(stored.get("password") or "").strip()
    try:
        port = _normalize_port(stored.get("port", 993))
    except ValueError:
        port = 993
    try:
        since_days = _normalize_since_days(stored.get("since_days", 30))
    except ValueError:
        since_days = 30
    settings = MailboxSettings(
        host=str(stored.get("host") or "").strip() or "localhost",
        port=port,
        username=str(stored.get("username") or "").strip(),
        inbox=str(stored.get("inbox") or "").strip() or "INBOX",
        use_ssl=bool(stored.get("use_ssl", True)),
        process_only_seen=bool(stored.get("process_only_seen", False)),
        since_days=since_days,
        password=password_value if include_password and password_value else None,
    )
    return settings


def persist_mailbox_settings(
    *,
    host: str,
    port: int,
    username: str,
    inbox: str,
    use_ssl: bool,
    process_only_seen: bool,
    since_days: int,
    password: str | None,
    clear_password: bool,
) -> MailboxSettings:
    normalized_host = host.strip()
    if not normalized_host:
        raise ValueError("Host darf nicht leer sein.")
    normalized_username = username.strip()
    if not normalized_username:
        raise ValueError("Benutzername darf nicht leer sein.")
    normalized_inbox = inbox.strip() or "INBOX"
    normalized_port = _normalize_port(port)
    normalized_since = _normalize_since_days(since_days)

    current = get_mailbox_settings_entry()
    payload: Dict[str, Any] = {
        "host": normalized_host,
        "port": normalized_port,
        "username": normalized_username,
        "inbox": normalized_inbox,
        "use_ssl": bool(use_ssl),
        "process_only_seen": bool(process_only_seen),
        "since_days": normalized_since,
    }
    if clear_password:
        payload["password"] = ""
    elif password is not None:
        payload["password"] = password
    elif current and "password" in current:
        payload["password"] = current.get("password", "")
    set_mailbox_settings_entry(payload)
    return load_mailbox_settings(include_password=True)


def verify_mailbox_connection(
    *,
    host: str,
    port: int,
    username: str,
    password: str,
    inbox: str,
    use_ssl: bool,
) -> None:
    normalized_host = host.strip()
    if not normalized_host:
        raise ValueError("Host darf nicht leer sein.")
    normalized_username = username.strip()
    if not normalized_username:
        raise ValueError("Benutzername darf nicht leer sein.")
    normalized_inbox = inbox.strip() or "INBOX"
    normalized_port = _normalize_port(port)
    if not password:
        raise ValueError("Passwort darf nicht leer sein.")

    client = IMAPClient(normalized_host, port=normalized_port, ssl=bool(use_ssl))
    try:
        client.login(normalized_username, password)
        client.select_folder(normalized_inbox)
    finally:
        try:
            client.logout()
        except Exception:
            pass
