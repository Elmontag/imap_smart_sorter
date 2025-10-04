"""Utilities for interacting with the IMAP server."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, Iterator, List

from imapclient import IMAPClient

from settings import S


logger = logging.getLogger(__name__)


@contextmanager
def _connect() -> Iterator[IMAPClient]:
    server = IMAPClient(S.IMAP_HOST, port=S.IMAP_PORT, ssl=S.IMAP_USE_SSL)
    server.login(S.IMAP_USERNAME, S.IMAP_PASSWORD)
    try:
        yield server
    finally:
        try:
            server.logout()
        except Exception:  # pragma: no cover - best effort cleanup
            logger.debug("Failed to logout from IMAP server", exc_info=True)


def list_folders() -> list[str]:
    try:
        with _connect() as server:
            response = server.list_folders()
            return [folder[2] for folder in response]
    except Exception as exc:  # pragma: no cover - network interaction
        logger.warning("Could not list folders: %s", exc)
        return []


def folder_exists(name: str) -> bool:
    return name in list_folders()


def _since_date() -> date:
    days = int(getattr(S, "SINCE_DAYS", 30))
    return (datetime.utcnow() - timedelta(days=days)).date()


def _search_criteria() -> list[object]:
    criteria: list[object] = ["SINCE", _since_date()]
    if getattr(S, "PROCESS_ONLY_SEEN", True):
        criteria.insert(0, "SEEN")
    else:
        criteria.insert(0, "UNSEEN")
    return criteria


def search_recent(server: IMAPClient, folder: str) -> list[int]:
    server.select_folder(folder, readonly=True)
    return server.search(_search_criteria())


def fetch_messages(server: IMAPClient, uids, batch_size: int = 100):
    if not uids:
        return {}
    out = {}
    for i in range(0, len(uids), batch_size):
        chunk = uids[i : i + batch_size]
        data = server.fetch(chunk, [b"RFC822", b"FLAGS"])
        out.update(data)
    return out


def fetch_recent_messages(folders: Iterable[str]) -> Dict[str, Dict[int, bytes]]:
    """Return the RFC822 payload for recently seen messages in the given folders."""

    folders = list(folders)
    if not folders:
        return {}

    payloads: Dict[str, Dict[int, bytes]] = {}
    try:
        with _connect() as server:
            for folder in folders:
                try:
                    uids = search_recent(server, folder)
                    data = fetch_messages(server, uids)
                except Exception as exc:  # pragma: no cover - defensive network handling
                    logger.warning("Failed to fetch messages for %s: %s", folder, exc)
                    continue
                payloads[folder] = {
                    uid: msg.get(b"RFC822", b"") for uid, msg in data.items() if msg
                }
    except Exception as exc:  # pragma: no cover - defensive network handling
        logger.error("Failed to open IMAP connection: %s", exc)
        return {}
    return payloads


def move_message(uid: str, target_folder: str, src_folder: str | None = None) -> None:
    with _connect() as server:
        server.select_folder(src_folder or S.IMAP_INBOX)
        i_uid = int(uid) if not isinstance(uid, int) else uid
        try:
            server.move([i_uid], target_folder)
        except Exception as exc:  # pragma: no cover - depends on IMAP server
            logger.warning("Direct move failed (%s), falling back to copy+delete", exc)
            server.copy([i_uid], target_folder)
            server.delete_messages([i_uid])
            server.expunge()


def ensure_folder_path(path: str) -> str:
    """Create the given folder (including parents) if it does not exist."""

    normalized = path.strip().strip("/")
    if not normalized:
        raise ValueError("invalid folder path")

    segments: List[str] = [segment.strip() for segment in normalized.split("/") if segment.strip()]
    if not segments:
        raise ValueError("invalid folder path")

    with _connect() as server:
        try:
            existing_response = server.list_folders()
            delimiter = next(
                (item[1] for item in existing_response if isinstance(item[1], str) and item[1]),
                "/",
            )
            existing_server = {folder[2] for folder in existing_response}
            existing_display = {
                (name.replace(delimiter, "/") if isinstance(name, str) else "")
                for name in existing_server
            }
        except Exception as exc:  # pragma: no cover - network interaction
            logger.warning("Could not fetch current folders before creating %s: %s", normalized, exc)
            delimiter = "/"
            existing_server = set()
            existing_display = set()

        created_path_parts: List[str] = []
        for segment in segments:
            created_path_parts.append(segment)
            display_candidate = "/".join(created_path_parts)
            server_candidate = (
                delimiter.join(created_path_parts) if delimiter and delimiter != "/" else display_candidate
            )
            if display_candidate in existing_display or server_candidate in existing_server:
                continue
            try:
                server.create_folder(server_candidate)
                existing_server.add(server_candidate)
                existing_display.add(display_candidate)
                logger.info("Created IMAP folder %s", display_candidate)
            except Exception as exc:  # pragma: no cover - server specific behaviour
                logger.error("Failed to create IMAP folder %s: %s", server_candidate, exc)
                raise

    return "/".join(segments)
