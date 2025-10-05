"""Aggregation helpers for AI-generated tag suggestions."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Dict, List, Sequence

from database import get_session
from models import Suggestion
from sqlmodel import select


@dataclass
class TagExample:
    """Lightweight preview of a suggestion that proposed a specific tag."""

    message_uid: str
    subject: str
    from_addr: str | None
    folder: str | None
    date: str | None


@dataclass
class TagSuggestion:
    """Aggregated representation of a tag across multiple suggestions."""

    tag: str
    occurrences: int
    last_seen: datetime | None
    examples: List[TagExample] = field(default_factory=list)

    def serialisable_examples(self) -> List[Dict[str, str | None]]:
        return [
            {
                "message_uid": example.message_uid,
                "subject": example.subject,
                "from_addr": example.from_addr,
                "folder": example.folder,
                "date": example.date,
            }
            for example in self.examples
        ]


def _normalise_tag(tag: str) -> str | None:
    cleaned = tag.strip()
    return cleaned or None


def _parse_mail_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):  # pragma: no cover - depends on email header format
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _deduplicate_tags(tags: Sequence[str] | None) -> List[str]:
    result: List[str] = []
    if not tags:
        return result
    for item in tags:
        if not isinstance(item, str):
            continue
        normalised = _normalise_tag(item)
        if not normalised or normalised in result:
            continue
        result.append(normalised)
    return result


def _append_example(aggregate: TagSuggestion, suggestion: Suggestion, limit: int) -> None:
    if len(aggregate.examples) >= limit:
        return
    aggregate.examples.append(
        TagExample(
            message_uid=suggestion.message_uid,
            subject=(suggestion.subject or "").strip() or "(kein Betreff)",
            from_addr=(suggestion.from_addr or None),
            folder=(suggestion.src_folder or None),
            date=suggestion.date,
        )
    )


def load_tag_suggestions(max_examples: int = 3, limit: int = 60) -> List[TagSuggestion]:
    """Aggregate all AI generated tags grouped by label."""

    with get_session() as session:
        rows: List[Suggestion] = list(
            session.exec(select(Suggestion).order_by(Suggestion.id.desc()))
        )

    aggregates: Dict[str, TagSuggestion] = {}
    for suggestion in rows:
        unique_tags = _deduplicate_tags(suggestion.tags)
        if not unique_tags:
            continue
        seen_date = _parse_mail_date(suggestion.date)
        for tag in unique_tags:
            bucket = aggregates.get(tag)
            if not bucket:
                bucket = TagSuggestion(tag=tag, occurrences=0, last_seen=seen_date, examples=[])
                aggregates[tag] = bucket
            bucket.occurrences += 1
            if seen_date and (bucket.last_seen is None or seen_date > bucket.last_seen):
                bucket.last_seen = seen_date
            _append_example(bucket, suggestion, max_examples)

    ordered = sorted(
        aggregates.values(),
        key=lambda item: (
            -(item.occurrences),
            item.last_seen.timestamp() if item.last_seen else float("-inf"),
            item.tag.lower(),
        ),
    )

    return ordered[:limit]
