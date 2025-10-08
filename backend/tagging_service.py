"""Helpers to apply AI and processed tags consistently."""

from __future__ import annotations

import logging
import re
from typing import Iterable, List, Sequence

from configuration import max_tag_total
from mailbox import add_message_tag
from runtime_settings import resolve_mailbox_inbox, resolve_mailbox_tags


logger = logging.getLogger(__name__)


_TAG_SANITIZE_RE = re.compile(r"[^0-9A-Za-z._+/:-]+")


def _format_ai_tag(label: str, prefix: str | None) -> str | None:
    cleaned = label.strip()
    if not cleaned:
        return None
    normalized = re.sub(r"\s+", "-", cleaned)
    normalized = _TAG_SANITIZE_RE.sub("", normalized)
    normalized = normalized.strip("-/")[:48]
    if not normalized:
        return None
    if prefix:
        base = prefix.strip("/")
        if not base:
            return normalized
        return f"{base}/{normalized}"
    return normalized


def _unique_limited(values: Iterable[str], limit: int) -> List[str]:
    seen: list[str] = []
    for value in values:
        if not value:
            continue
        if value in seen:
            continue
        seen.append(value)
        if len(seen) >= limit:
            break
    return seen


def sanitise_ai_tags(raw_tags: Sequence[str] | None) -> List[str]:
    if not raw_tags:
        return []
    _, processed_tag, prefix = resolve_mailbox_tags()
    processed_value = (processed_tag or "").strip()
    formatted: List[str] = []
    for tag in raw_tags:
        if not isinstance(tag, str):
            continue
        candidate = _format_ai_tag(tag, prefix)
        if not candidate:
            continue
        if processed_value and candidate == processed_value:
            continue
        formatted.append(candidate)
    return _unique_limited(formatted, max_tag_total())


def apply_suggestion_tags(
    uid: str,
    folder: str | None,
    raw_tags: Sequence[str] | None,
    *,
    include_processed: bool = True,
) -> None:
    target_folder = folder or resolve_mailbox_inbox()
    _, processed_tag, _ = resolve_mailbox_tags()
    processed_value = (processed_tag or "").strip()
    if include_processed and processed_value:
        logger.debug("Adding processed tag %s to %s in %s", processed_value, uid, target_folder)
        add_message_tag(uid, target_folder, processed_value)

    for tag in sanitise_ai_tags(raw_tags):
        logger.debug("Adding AI tag %s to %s in %s", tag, uid, target_folder)
        add_message_tag(uid, target_folder, tag)
