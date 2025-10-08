"""Helpers to resolve runtime configuration with persisted overrides."""

from __future__ import annotations

from typing import Tuple

from settings import S
from database import (
    get_analysis_module_override,
    get_classifier_model,
    get_mailbox_tags,
    get_mode_override,
)
from mail_settings import MailboxSettings, load_mailbox_settings


def resolve_move_mode() -> str:
    """Return the effective move mode considering persisted overrides."""

    override = get_mode_override()
    if override:
        return override
    return S.MOVE_MODE


def resolve_classifier_model() -> str:
    """Return the classifier model, falling back to the static setting."""

    override = get_classifier_model()
    if override:
        return override
    return S.CLASSIFIER_MODEL


def resolve_mailbox_tags() -> Tuple[str | None, str | None, str | None]:
    """Return the configured mailbox tags (protected, processed, ai prefix)."""

    stored_protected, stored_processed, stored_prefix = get_mailbox_tags()
    protected = stored_protected if stored_protected is not None else (S.IMAP_PROTECTED_TAG or None)
    processed = stored_processed if stored_processed is not None else (S.IMAP_PROCESSED_TAG or None)
    prefix = stored_prefix if stored_prefix is not None else (S.IMAP_AI_TAG_PREFIX or None)
    return protected, processed, prefix


def resolve_mailbox_settings(include_password: bool = False) -> MailboxSettings:
    """Return the active mailbox connection settings including overrides."""

    return load_mailbox_settings(include_password=include_password)


def resolve_mailbox_inbox() -> str:
    """Return the configured inbox folder name with sane defaults."""

    settings = load_mailbox_settings(include_password=False)
    inbox = settings.inbox.strip() if settings.inbox else ""
    return inbox or "INBOX"


def resolve_analysis_module() -> str:
    """Return the selected analysis module with persisted overrides."""

    override = get_analysis_module_override()
    if override:
        return override
    return S.ANALYSIS_MODULE


def analysis_module_uses_llm(module: str | None = None) -> bool:
    """Return True if the given (or active) module relies on Ollama/LLM calls."""

    value = (module or resolve_analysis_module() or "").strip().upper()
    return value in {"HYBRID", "LLM_PURE"}


def analysis_module_uses_filters(module: str | None = None) -> bool:
    """Return True if the module should evaluate keyword-based static rules."""

    value = (module or resolve_analysis_module() or "").strip().upper()
    return value in {"STATIC", "HYBRID"}
