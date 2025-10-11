"""Utilities for interacting with the IMAP server."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Collection, Dict, Iterable, Iterator, List, Mapping, Sequence, Set

from imapclient import IMAPClient

from runtime_settings import (
    resolve_mailbox_inbox,
    resolve_mailbox_settings,
    resolve_mailbox_tags,
)


logger = logging.getLogger(__name__)


@dataclass
class MessageContent:
    body: bytes
    flags: Sequence[str]


@contextmanager
def _connect() -> Iterator[IMAPClient]:
    settings = resolve_mailbox_settings(include_password=True)
    server = IMAPClient(settings.host, port=settings.port, ssl=settings.use_ssl)
    server.login(settings.username, settings.password or "")
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
    settings = resolve_mailbox_settings(include_password=False)
    days = int(settings.since_days)
    return (datetime.utcnow() - timedelta(days=days)).date()


def _search_criteria() -> list[object]:
    criteria: list[object] = ["SINCE", _since_date()]
    settings = resolve_mailbox_settings(include_password=False)
    if settings.process_only_seen:
        criteria.insert(0, "SEEN")
    else:
        criteria.insert(0, "UNSEEN")
    return criteria


def search_recent(server: IMAPClient, folder: str) -> list[int]:
    server.select_folder(folder, readonly=True)
    return server.search(_search_criteria())


def fetch_messages(server: IMAPClient, uids, attributes: Sequence[bytes], batch_size: int = 100):
    if not uids:
        return {}
    out = {}
    uid_list = list(uids)
    for i in range(0, len(uid_list), batch_size):
        chunk = uid_list[i : i + batch_size]
        data = server.fetch(chunk, list(attributes))
        out.update(data)
    return out


def _normalize_flags(raw_flags: Iterable[object]) -> List[str]:
    normalized: List[str] = []
    for flag in raw_flags:
        if isinstance(flag, bytes):
            try:
                decoded = flag.decode("utf-8")
            except UnicodeDecodeError:
                decoded = flag.decode("utf-8", errors="ignore")
            normalized.append(decoded)
        else:
            normalized.append(str(flag))
    return normalized


def fetch_recent_messages(
    folders: Iterable[str],
    *,
    processed_lookup: Mapping[str, Collection[str]] | None = None,
    skip_known_uids: Mapping[str | None, Collection[str]] | None = None,
    uid_limit: int | None = None,
    content_attribute: bytes = b"RFC822",
) -> Dict[str, Dict[int, MessageContent]]:
    """Return the RFC822 payload for recently seen messages in the given folders."""

    folders = list(folders)
    if not folders:
        return {}

    payloads: Dict[str, Dict[int, MessageContent]] = {}
    protected_tag, processed_tag, _ = resolve_mailbox_tags()
    protected_tag = (protected_tag or "").strip()
    processed_tag = (processed_tag or "").strip()
    processed_lookup = processed_lookup or {}
    skip_lookup_raw = skip_known_uids or {}
    skip_lookup: Dict[str | None, Set[str]] = {}
    for key, values in skip_lookup_raw.items():
        normalized_key = str(key).strip() if isinstance(key, str) and key else None
        bucket = skip_lookup.setdefault(normalized_key, set())
        bucket.update({str(uid).strip() for uid in values if str(uid).strip()})
    global_known = skip_lookup.get(None, set())
    try:
        with _connect() as server:
            for folder in folders:
                try:
                    uids = search_recent(server, folder)
                except Exception as exc:  # pragma: no cover - defensive network handling
                    logger.warning("Failed to fetch messages for %s: %s", folder, exc)
                    continue
                if uid_limit and uid_limit > 0 and len(uids) > uid_limit:
                    uids = uids[-uid_limit:]
                if not uids:
                    payloads[folder] = {}
                    continue
                processed_for_folder = {
                    str(uid)
                    for uid in processed_lookup.get(folder, set())
                    if str(uid).strip()
                }
                lookup_key = str(folder).strip()
                if lookup_key and lookup_key != folder:
                    processed_for_folder.update(
                        {
                            str(uid)
                            for uid in processed_lookup.get(lookup_key, set())
                            if str(uid).strip()
                        }
                    )
                folder_known = skip_lookup.get(lookup_key, set()) or skip_lookup.get(folder, set())
                try:
                    flag_data = fetch_messages(server, uids, [b"FLAGS"])
                except Exception as exc:  # pragma: no cover - defensive network handling
                    logger.warning("Failed to fetch flags for %s: %s", folder, exc)
                    payloads[folder] = {}
                    continue

                eligible_flags: Dict[int, Sequence[str]] = {}
                for uid, msg in flag_data.items():
                    if not msg:
                        continue
                    raw_flags = msg.get(b"FLAGS", []) or []
                    normalized_flags = tuple(_normalize_flags(raw_flags))
                    if protected_tag and protected_tag in normalized_flags:
                        continue
                    if processed_tag and processed_tag in normalized_flags:
                        continue
                    uid_str = str(uid)
                    if processed_for_folder and uid_str in processed_for_folder:
                        continue
                    if folder_known and uid_str in folder_known:
                        continue
                    if global_known and uid_str in global_known:
                        continue
                    eligible_flags[int(uid)] = normalized_flags

                if not eligible_flags:
                    payloads[folder] = {}
                    continue

                try:
                    body_data = fetch_messages(server, eligible_flags.keys(), [content_attribute])
                except Exception as exc:  # pragma: no cover - defensive network handling
                    logger.warning("Failed to fetch message bodies for %s: %s", folder, exc)
                    payloads[folder] = {}
                    continue

                filtered: Dict[int, MessageContent] = {}
                for uid, msg in body_data.items():
                    if not msg:
                        continue
                    raw_body = msg.get(content_attribute)
                    if raw_body is None and isinstance(content_attribute, bytes):
                        alt_key = content_attribute.decode("ascii", errors="ignore")
                        raw_body = msg.get(alt_key)
                    if not raw_body:
                        continue
                    if isinstance(raw_body, str):
                        raw_body = raw_body.encode("utf-8", errors="ignore")
                    flags = eligible_flags.get(int(uid), ())
                    filtered[int(uid)] = MessageContent(body=raw_body, flags=tuple(flags))
                payloads[folder] = filtered
    except Exception as exc:  # pragma: no cover - defensive network handling
        logger.error("Failed to open IMAP connection: %s", exc)
        return {}
    return payloads


def add_message_tag(uid: str, folder: str, tag: str) -> None:
    normalized = tag.strip()
    if not normalized:
        return
    inbox = resolve_mailbox_inbox()
    with _connect() as server:
        server.select_folder(folder or inbox)
        i_uid = int(uid) if not isinstance(uid, int) else uid
        try:
            server.add_flags([i_uid], [normalized])
        except Exception as exc:  # pragma: no cover - network specific behaviour
            logger.warning(
                "Failed to add tag %s to message %s in %s: %s", normalized, uid, folder or inbox, exc
            )


def move_message(uid: str, target_folder: str, src_folder: str | None = None) -> None:
    inbox = resolve_mailbox_inbox()
    with _connect() as server:
        server.select_folder(src_folder or inbox)
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
