"""Background worker that scans the IMAP account and stores suggestions."""

from __future__ import annotations

import asyncio
import email
import logging
from email import policy
from typing import Sequence

from classifier import (
    build_embedding_prompt,
    embed,
    propose_new_folder_if_needed,
    score_profiles,
)
from database import (
    get_mode,
    is_processed,
    list_folder_profiles,
    mark_failed,
    mark_moved,
    mark_processed,
    record_decision,
    save_suggestion,
)
from feedback import update_profiles_on_accept
from mailbox import fetch_recent_messages, move_message
from models import Suggestion
from settings import S
from utils import extract_text, subject_from, thread_headers


logger = logging.getLogger(__name__)


async def process_loop() -> None:
    """Continuously poll the mailbox and persist new suggestions."""

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

    target_folders: Sequence[str] = [str(folder) for folder in folders] if folders else [S.IMAP_INBOX]
    messages = await asyncio.to_thread(fetch_recent_messages, target_folders)
    processed = 0
    for folder, payloads in messages.items():
        for uid, raw_bytes in payloads.items():
            uid_str = str(uid)
            if not raw_bytes or is_processed(folder, uid_str):
                continue
            try:
                await handle_message(uid_str, raw_bytes, folder)
                mark_processed(folder, uid_str)
                processed += 1
            except Exception:  # pragma: no cover - defensive background handling
                logger.exception("Failed to process message %s in %s", uid, folder)
    return processed


async def handle_message(uid: str, raw_bytes: bytes, src_folder: str) -> None:
    msg = email.message_from_bytes(raw_bytes, policy=policy.default)
    subject, from_addr = subject_from(msg)
    thread = thread_headers(msg)
    text = extract_text(msg)
    prompt = build_embedding_prompt(subject or "", from_addr or "", text)

    profiles = [
        {"name": fp.name, "centroid": fp.centroid}
        for fp in list_folder_profiles()
        if fp.centroid
    ]

    embedding = await embed(prompt)
    ranked = score_profiles(embedding, profiles) if embedding else []
    top_score = ranked[0][1] if ranked else 0.0
    proposal = await propose_new_folder_if_needed(top_score, parent_hint=src_folder)

    suggestion = Suggestion(
        message_uid=uid,
        src_folder=src_folder,
        subject=subject or "",
        from_addr=from_addr,
        date=str(msg.get("Date")),
        thread_id=thread.get("message_id"),
        ranked=[{"name": name, "score": score} for name, score in ranked],
        proposal=proposal,
        status="open",
        move_status="pending",
    )
    save_suggestion(suggestion)

    mode = get_mode() or S.MOVE_MODE
    should_auto_move = mode == "AUTO" and (
        (top_score >= S.AUTO_THRESHOLD) or bool(thread.get("in_reply_to"))
    )

    if should_auto_move and ranked:
        target = ranked[0][0]
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
