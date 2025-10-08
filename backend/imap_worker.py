"""Background worker that scans the IMAP account and stores suggestions."""

from __future__ import annotations

import asyncio
import email
import logging
import os
from email import policy
from typing import Sequence

from classifier import (
    build_embedding_prompt,
    classify_with_model,
    embed,
    propose_new_folder_if_needed,
    score_profiles,
)
from database import (
    get_monitored_folders,
    known_suggestion_uids,
    list_folder_profiles,
    mark_failed,
    mark_moved,
    mark_processed,
    processed_uids_by_folder,
    record_decision,
    record_filter_hit,
    save_suggestion,
)
from feedback import update_profiles_on_accept
from mailbox import add_message_tag, ensure_folder_path, fetch_recent_messages, list_folders, move_message
from models import Suggestion
from runtime_settings import resolve_mailbox_inbox, resolve_mailbox_tags
from ollama_service import OllamaModelStatus, OllamaStatus, ensure_ollama_ready
from settings import S
from runtime_settings import (
    analysis_module_uses_filters,
    analysis_module_uses_llm,
    resolve_analysis_module,
    resolve_move_mode,
    resolve_poll_interval_seconds,
)
from keyword_filters import evaluate_filters
from utils import extract_text, message_received_at, subject_from, thread_headers
from tagging_service import apply_suggestion_tags


logger = logging.getLogger(__name__)


def _should_autostart() -> bool:
    raw = os.getenv("IMAP_WORKER_AUTOSTART")
    if raw is None:
        return False
    normalized = raw.strip().lower()
    return normalized in {"1", "true", "yes", "on"}


async def _idle_loop(interval: float) -> None:
    delay = max(interval, 5.0)
    while True:
        await asyncio.sleep(delay)


def _ollama_requirements_met(status: OllamaStatus) -> bool:
    """Return True when the Ollama host and required models are ready."""

    if not status.reachable:
        return False

    required: list[OllamaModelStatus] = [
        model
        for model in status.models
        if model.purpose in {"classifier", "embedding"}
    ]
    if not required:
        return status.reachable

    return all(model.available for model in required)


async def process_loop() -> None:
    """Continuously poll the mailbox and persist new suggestions."""

    llm_ready = False
    while True:
        try:
            module = resolve_analysis_module()
            if analysis_module_uses_llm(module):
                if not llm_ready:
                    status = await ensure_ollama_ready()
                    llm_ready = _ollama_requirements_met(status)
            else:
                llm_ready = False
            count = await one_shot_scan()
            if count:
                logger.info("Processed %s new messages", count)
        except Exception:  # pragma: no cover - defensive background handling
            logger.exception("Unexpected error while scanning mailbox")
        await asyncio.sleep(resolve_poll_interval_seconds())


async def one_shot_scan(folders: Sequence[str] | None = None) -> int:
    """Scan the configured folders once and create suggestions for unseen mails."""

    if folders is not None:
        target_folders: Sequence[str] = [str(folder) for folder in folders if str(folder).strip()]
    else:
        configured = get_monitored_folders()
        inbox = resolve_mailbox_inbox()
        target_folders = configured or [inbox]
    processed_map = processed_uids_by_folder(target_folders)
    known_suggestions = known_suggestion_uids()
    messages = await asyncio.to_thread(
        fetch_recent_messages,
        target_folders,
        processed_lookup=processed_map,
        skip_known_uids=known_suggestions,
    )
    all_folders = await asyncio.to_thread(list_folders)
    processed = 0
    for folder, payloads in messages.items():
        processed_for_folder = processed_map.setdefault(folder, set())
        for uid, meta in payloads.items():
            uid_str = str(uid)
            raw_bytes = meta.body if hasattr(meta, "body") else meta
            if not raw_bytes:
                continue
            if uid_str in known_suggestions:
                continue
            if processed_for_folder and uid_str in processed_for_folder:
                continue
            try:
                await handle_message(uid_str, raw_bytes, folder, all_folders)
                mark_processed(folder, uid_str)
                processed += 1
                processed_for_folder.add(uid_str)
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

    module = resolve_analysis_module()
    use_filters = analysis_module_uses_filters(module)
    use_llm = analysis_module_uses_llm(module)

    match = None
    if use_filters:
        try:
            match = evaluate_filters(subject or "", from_addr or "", text, received_at)
        except Exception:  # pragma: no cover - defensive logging
            logger.exception("Keyword filter evaluation failed for message %s", uid)
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
        _, processed_tag, _ = resolve_mailbox_tags()
        processed_value = (processed_tag or "").strip()
        if processed_value:
            await asyncio.to_thread(add_message_tag, uid, target_folder, processed_value)
        extra_tags: list[str] = []
        if match.rule.tag_future_dates and received_at:
            base_date = received_at.date()
            future_dates = sorted({candidate for candidate in match.content_dates if candidate > base_date})
            extra_tags = [f"datum-{candidate.isoformat()}" for candidate in future_dates]
        combined_tags: list[str] = []
        seen_tags: set[str] = set()
        for tag in [*match.rule.tags, *extra_tags]:
            cleaned = tag.strip()
            if not cleaned:
                continue
            key = cleaned.casefold()
            if key in seen_tags:
                continue
            seen_tags.add(key)
            combined_tags.append(cleaned)
        for tag in combined_tags:
            await asyncio.to_thread(add_message_tag, uid, target_folder, tag)
        record_filter_hit(
            message_uid=uid,
            rule_name=match.rule.name,
            src_folder=src_folder,
            target_folder=target_folder,
            applied_tags=combined_tags,
            matched_terms=match.matched_terms,
            message_date=received_at,
        )
        return

    if not use_llm:
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

    mode = resolve_move_mode()
    auto_mode = mode == "AUTO"
    if auto_mode:
        apply_suggestion_tags(uid, src_folder, tags, include_processed=True)

    should_auto_move = auto_mode and (
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
        if _should_autostart():
            asyncio.run(process_loop())
        else:
            logger.info(
                "Mailbox worker im Idle-Modus – setze IMAP_WORKER_AUTOSTART=1, um die Daueranalyse automatisch zu starten."
            )
            interval = float(getattr(S, "POLL_INTERVAL_SECONDS", 60))
            asyncio.run(_idle_loop(interval))
    except KeyboardInterrupt:  # pragma: no cover - manual stop
        pass
