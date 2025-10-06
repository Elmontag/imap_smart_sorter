"""Background worker that scans the IMAP account and stores suggestions."""

from __future__ import annotations

import asyncio
import email
import logging
import re
from email import policy
from typing import Sequence

from classifier import (
    build_embedding_prompt,
    classify_with_model,
    embed,
    propose_new_folder_if_needed,
    score_profiles,
)
from configuration import max_tag_total
from database import (
    get_mode,
    get_monitored_folders,
    is_processed,
    list_folder_profiles,
    mark_failed,
    mark_moved,
    mark_processed,
    record_decision,
    record_filter_hit,
    save_suggestion,
)
from feedback import update_profiles_on_accept
from mailbox import (
    add_message_tag,
    ensure_folder_path,
    fetch_recent_messages,
    list_folders,
    move_message,
)
from models import Suggestion
from ollama_service import ensure_ollama_ready
from settings import S
from keyword_filters import evaluate_filters
from utils import extract_text, message_received_at, subject_from, thread_headers


logger = logging.getLogger(__name__)


_TAG_SANITIZE_RE = re.compile(r"[^0-9A-Za-z._+/:-]+")


def _format_ai_tag(label: str) -> str | None:
    cleaned = label.strip()
    if not cleaned:
        return None
    normalized = re.sub(r"\s+", "-", cleaned)
    normalized = _TAG_SANITIZE_RE.sub("", normalized)
    normalized = normalized.strip("-/")[:48]
    if not normalized:
        return None
    prefix = S.IMAP_AI_TAG_PREFIX.strip()
    if prefix:
        base = prefix.strip("/")
        if not base:
            return normalized
        return f"{base}/{normalized}"
    return normalized


def _apply_ai_tags(uid: str, folder: str, raw_tags: Sequence[str]) -> None:
    if not raw_tags:
        return
    processed_marker = (S.IMAP_PROCESSED_TAG or "").strip()
    unique: list[str] = []
    limit = max_tag_total()
    for tag in raw_tags:
        if not isinstance(tag, str):
            continue
        formatted = _format_ai_tag(tag)
        if not formatted:
            continue
        if processed_marker and formatted == processed_marker:
            continue
        if formatted in unique:
            continue
        unique.append(formatted)
        if len(unique) >= limit:
            break
    if not unique:
        return
    logger.debug("Adding AI Tags %s to %s", unique, uid)
    for tag in unique:
        add_message_tag(uid, folder, tag)


async def process_loop() -> None:
    """Continuously poll the mailbox and persist new suggestions."""

    await ensure_ollama_ready()
    while True:
        try:
            count = await one_shot_scan()
            if count:
                logger.info("Processed %s new messages", count)
        except Exception:  # pragma: no cover - defensive background handling
            logger.exception("Unexpected error while scanning mailbox")
        await asyncio.sleep(S.POLL_INTERVAL_SECONDS)


async def one_shot_scan(folders: Sequence[str] | None = None) -> int:
    """Scan the configured folders once and create suggestions for unseen mails."""

    if folders is not None:
        target_folders: Sequence[str] = [str(folder) for folder in folders if str(folder).strip()]
    else:
        configured = get_monitored_folders()
        target_folders = configured or [S.IMAP_INBOX]
    messages = await asyncio.to_thread(fetch_recent_messages, target_folders)
    all_folders = await asyncio.to_thread(list_folders)
    processed = 0
    for folder, payloads in messages.items():
        for uid, meta in payloads.items():
            uid_str = str(uid)
            raw_bytes = meta.body if hasattr(meta, "body") else meta
            if not raw_bytes or is_processed(folder, uid_str):
                continue
            try:
                await handle_message(uid_str, raw_bytes, folder, all_folders)
                mark_processed(folder, uid_str)
                processed += 1
            except Exception:  # pragma: no cover - defensive background handling
                logger.exception("Failed to process message %s in %s", uid, folder)
    return processed


async def handle_message(
    uid: str,
    raw_bytes: bytes,
    src_folder: str,
    folder_structure: Sequence[str] | None = None,
) -> None:
    msg = email.message_from_bytes(raw_bytes, policy=policy.default)
    subject, from_addr = subject_from(msg)
    thread = thread_headers(msg)
    text = extract_text(msg)
    received_at = message_received_at(msg)

    try:
        match = evaluate_filters(subject or "", from_addr or "", text, received_at)
    except Exception:  # pragma: no cover - defensive logging
        logger.exception("Keyword filter evaluation failed for message %s", uid)
        match = None
    if match:
        target_folder = match.rule.target_folder
        logger.info(
            "Routing message %s from %s via keyword rule '%s' to %s",
            uid,
            src_folder,
            match.rule.name,
            target_folder,
        )
        try:
            await asyncio.to_thread(ensure_folder_path, target_folder)
        except Exception:  # pragma: no cover - network interaction
            logger.exception("Failed to ensure folder %s before routing message %s", target_folder, uid)
            return
        await asyncio.to_thread(move_message, uid, target_folder, src_folder)
        processed_tag = (S.IMAP_PROCESSED_TAG or "").strip()
        if processed_tag:
            await asyncio.to_thread(add_message_tag, uid, target_folder, processed_tag)
        for tag in match.rule.tags:
            await asyncio.to_thread(add_message_tag, uid, target_folder, tag)
        record_filter_hit(
            message_uid=uid,
            rule_name=match.rule.name,
            src_folder=src_folder,
            target_folder=target_folder,
            applied_tags=match.rule.tags,
            matched_terms=match.matched_terms,
            message_date=received_at,
        )
        return
    prompt = build_embedding_prompt(subject or "", from_addr or "", text)

    folder_profiles = list_folder_profiles()
    profiles = [
        {"name": fp.name, "centroid": fp.centroid}
        for fp in folder_profiles
        if fp.centroid
    ]

    embedding = await embed(prompt)
    ranked_pairs = score_profiles(embedding, profiles) if embedding else []
    folder_names = [fp.name for fp in folder_profiles if fp.name]
    structure_candidates: list[str] = []
    if folder_structure:
        structure_candidates.extend(
            str(name).strip()
            for name in folder_structure
            if isinstance(name, str) and str(name).strip()
        )
    structure_candidates.extend(name for name in folder_names if name)
    structure_overview = list(dict.fromkeys(structure_candidates))

    refined_ranked, proposal, category, tags = await classify_with_model(
        subject or "",
        from_addr or "",
        text,
        ranked_pairs,
        structure_overview,
        parent_hint=src_folder,
    )
    match_score = refined_ranked[0]["score"] if refined_ranked else 0.0
    match_rating = refined_ranked[0].get("rating", match_score * 100.0) if refined_ranked else 0.0
    meets_threshold = match_rating >= float(S.MIN_MATCH_SCORE or 0)

    if meets_threshold and not proposal:
        proposal = await propose_new_folder_if_needed(
            match_score,
            subject or "",
            from_addr,
            parent_hint=src_folder,
            category=category,
        )

    suggestion = Suggestion(
        message_uid=uid,
        src_folder=src_folder,
        subject=subject or "",
        from_addr=from_addr,
        date=str(msg.get("Date")),
        thread_id=thread.get("message_id"),
        ranked=refined_ranked,
        proposal=proposal,
        category=category,
        tags=tags or None,
        status="open",
        move_status="pending",
    )
    save_suggestion(suggestion)
    add_message_tag(uid, src_folder, S.IMAP_PROCESSED_TAG)
    _apply_ai_tags(uid, src_folder, tags)

    mode = get_mode() or S.MOVE_MODE
    should_auto_move = mode == "AUTO" and (
        (match_score >= S.AUTO_THRESHOLD) or bool(thread.get("in_reply_to"))
    )

    if should_auto_move and refined_ranked:
        target = refined_ranked[0]["name"]
        try:
            move_message(uid, target, src_folder=src_folder)
            mark_moved(uid)
            record_decision(uid, "accept")
            update_profiles_on_accept(target, embedding)
        except Exception as exc:  # pragma: no cover - depends on IMAP
            logger.warning("Auto move failed for %s -> %s: %s", uid, target, exc)
            mark_failed(uid, str(exc))


if __name__ == "__main__":
    logging.basicConfig(level=getattr(logging, S.LOG_LEVEL.upper(), logging.INFO))
    try:
        asyncio.run(process_loop())
    except KeyboardInterrupt:  # pragma: no cover - manual stop
        pass
