"""Keyword-based routing configuration for pre-classification."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List, Sequence

logger = logging.getLogger(__name__)

_CONFIG_PATH = Path(__file__).with_name("keyword_filters.json")


@dataclass(frozen=True)
class KeywordMatch:
    """Definition of keyword matching criteria."""

    mode: str
    terms: tuple[str, ...]
    fields: tuple[str, ...]


@dataclass(frozen=True)
class KeywordFilterRule:
    """Configuration entry describing an automated routing rule."""

    name: str
    description: str | None
    enabled: bool
    target_folder: str
    tags: tuple[str, ...]
    match: KeywordMatch
    date_after: date | None
    date_before: date | None


@dataclass(frozen=True)
class KeywordMatchResult:
    """Outcome of evaluating a single rule."""

    rule: KeywordFilterRule
    matched_terms: tuple[str, ...]


def _load_raw_config() -> dict:
    if not _CONFIG_PATH.exists():
        logger.info("Keyword filter configuration missing – creating default placeholder at %s", _CONFIG_PATH)
        _CONFIG_PATH.write_text(json.dumps({"rules": []}, indent=2) + "\n", encoding="utf-8")
    with _CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_raw_config(data: dict) -> None:
    with _CONFIG_PATH.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    get_filter_rules.cache_clear()


def get_filter_config() -> dict:
    """Return a deep copy of the stored keyword filter configuration."""

    raw = _load_raw_config()
    return json.loads(json.dumps(raw))


def _to_date(value: object) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            return None
    return None


def _normalise_terms(terms: Iterable[object]) -> tuple[str, ...]:
    seen: set[str] = set()
    ordered: list[str] = []
    for term in terms:
        cleaned = str(term).strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        ordered.append(cleaned)
    return tuple(ordered)


def _normalise_fields(fields: Iterable[object]) -> tuple[str, ...]:
    allowed = {"subject", "sender", "body"}
    cleaned = [str(field).strip().lower() for field in fields if str(field).strip()]
    filtered = [field for field in cleaned if field in allowed]
    return tuple(filtered) if filtered else ("subject", "sender", "body")


@lru_cache(maxsize=1)
def get_filter_rules() -> tuple[KeywordFilterRule, ...]:
    raw = _load_raw_config()
    entries = raw.get("rules", [])
    rules: List[KeywordFilterRule] = []
    if not isinstance(entries, list):
        return tuple()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        target_folder = str(entry.get("target_folder") or "").strip()
        if not name or not target_folder:
            continue
        description = str(entry.get("description") or "").strip() or None
        enabled = bool(entry.get("enabled", True))
        tags = _normalise_terms(entry.get("tags") or [])
        raw_match = entry.get("match") or {}
        if isinstance(raw_match, dict):
            mode = str(raw_match.get("mode") or "all").strip().lower()
            if mode not in {"all", "any"}:
                mode = "all"
            terms = _normalise_terms(raw_match.get("terms") or [])
            fields = _normalise_fields(raw_match.get("fields") or [])
        else:
            mode = "all"
            terms = tuple()
            fields = ("subject", "sender", "body")
        match = KeywordMatch(mode=mode, terms=terms, fields=fields)
        raw_date = entry.get("date") if isinstance(entry.get("date"), dict) else {}
        after = _to_date(raw_date.get("after")) if isinstance(raw_date, dict) else None
        before = _to_date(raw_date.get("before")) if isinstance(raw_date, dict) else None
        rules.append(
            KeywordFilterRule(
                name=name,
                description=description,
                enabled=enabled,
                target_folder=target_folder,
                tags=tags,
                match=match,
                date_after=after,
                date_before=before,
            )
        )
    return tuple(rules)


def update_filter_config(rules: Sequence[dict]) -> dict:
    payload = {"rules": list(rules)}
    _write_raw_config(payload)
    return payload


def _combine_fields(
    subject: str,
    sender: str,
    body: str,
) -> dict[str, str]:
    mapping = {
        "subject": subject,
        "sender": sender,
        "body": body,
    }
    return {field: mapping.get(field, "") for field in {"subject", "sender", "body"}}


def _normalise(value: str) -> str:
    return value.casefold()


def _term_matches(term: str, content: str) -> bool:
    return _normalise(term) in _normalise(content)


def _date_in_range(rule: KeywordFilterRule, received: datetime | None) -> bool:
    if not received:
        return rule.date_after is None and rule.date_before is None
    local_date = received.date()
    if rule.date_after and local_date < rule.date_after:
        return False
    if rule.date_before and local_date > rule.date_before:
        return False
    return True


def evaluate_filters(
    subject: str,
    sender: str,
    body: str,
    received: datetime | None,
) -> KeywordMatchResult | None:
    """Return the first matching keyword filter or ``None`` if no rule applies."""

    for rule in get_filter_rules():
        if not rule.enabled:
            continue
        if not _date_in_range(rule, received):
            continue
        terms = rule.match.terms
        fields = rule.match.fields or ("subject", "sender", "body")
        combined = _combine_fields(subject, sender, body)
        matches: list[str] = []
        if terms:
            for term in terms:
                if any(_term_matches(term, combined[field]) for field in fields if combined.get(field)):
                    matches.append(term)
            if rule.match.mode == "all" and len(matches) < len(terms):
                continue
            if rule.match.mode == "any" and not matches:
                continue
        result_terms = tuple(matches if matches else terms)
        return KeywordMatchResult(rule=rule, matched_terms=result_terms)
    return None


__all__ = [
    "KeywordFilterRule",
    "KeywordMatchResult",
    "evaluate_filters",
    "get_filter_config",
    "get_filter_rules",
    "update_filter_config",
]
