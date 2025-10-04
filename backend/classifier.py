
from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import httpx

from settings import S


logger = logging.getLogger(__name__)


def _cosine(a: Sequence[float], b: Sequence[float] | None) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    num = sum(x * y for x, y in zip(a, b))
    den = (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5)
    return num / den if den else 0.0


def build_embedding_prompt(subject: str, sender: str, body: str) -> str:
    """Create a consistent prompt for Ollama embeddings."""

    header_lines = [
        "Du bist ein Assistent, der E-Mails für eine Ordnerklassifikation analysiert.",
        "Erstelle eine kompakte semantische Repräsentation aus Betreff, Absender und Kerninhalt.",
    ]
    hint = S.EMBED_PROMPT_HINT.strip()
    if hint:
        header_lines.append(f"Zusätzliche Vorgabe: {hint}")

    email_lines = [
        f"Betreff: {subject or '-'}",
        f"Von: {sender or '-'}",
        "Inhalt (gekürzt):",
        (body.strip() or "(kein Text vorhanden)")[: S.EMBED_PROMPT_MAX_CHARS],
    ]

    prompt = "\n".join([*header_lines, "", *email_lines])
    return prompt


async def embed(prompt: str) -> List[float]:
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{S.OLLAMA_HOST}/api/embed",
                json={
                    "model": S.EMBED_MODEL,
                    "input": [prompt[: S.EMBED_PROMPT_MAX_CHARS]],
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:  # pragma: no cover - network interaction
        logger.warning(
            "Ollama Embedding fehlgeschlagen (%s): %s", S.OLLAMA_HOST, exc
        )
        return []

    data = response.json()
    embedding = data.get("embedding")
    if isinstance(embedding, list):
        if embedding and isinstance(embedding[0], list):
            return embedding[0]
        return embedding
    embeddings = data.get("embeddings")
    if isinstance(embeddings, list) and embeddings:
        first = embeddings[0]
        if isinstance(first, list):
            return first
    return []


def score_profiles(embedding: Sequence[float], profiles: Iterable[Dict[str, Any]]) -> List[Tuple[str, float]]:
    scores = [(profile["name"], _cosine(embedding, profile.get("centroid"))) for profile in profiles]
    scores.sort(key=lambda item: item[1], reverse=True)
    return scores[: S.MAX_SUGGESTIONS]


def _format_ranked_for_prompt(ranked: List[Tuple[str, float]]) -> str:
    if not ranked:
        return "Keine bisherigen Zuordnungen verfügbar."
    rows = [
        f"- {name}: Score {score:.2f}"
        for name, score in ranked[: S.MAX_SUGGESTIONS]
    ]
    return "\n".join(rows)


def _summarize_hierarchy(folders: Sequence[str]) -> str:
    groups: Dict[str, List[str]] = defaultdict(list)
    for raw in folders:
        if not isinstance(raw, str):
            continue
        parts = [part.strip() for part in raw.split("/") if part.strip()]
        if not parts:
            continue
        head = parts[0]
        tail = "/".join(parts[1:]) if len(parts) > 1 else ""
        if tail:
            groups[head].append(tail)
        else:
            groups.setdefault(head, [])
    if not groups:
        return "Keine Ordnerstruktur vorhanden."
    lines: List[str] = []
    for head in sorted(groups):
        children = sorted({child for child in groups[head] if child})
        if children:
            snippet = ", ".join(children[:5])
            lines.append(f"- {head}: {snippet}")
        else:
            lines.append(f"- {head}")
    return "\n".join(lines)


def build_classification_prompt(
    subject: str,
    sender: str,
    body: str,
    ranked: List[Tuple[str, float]],
    folders: Sequence[str],
    parent_hint: str | None,
) -> List[Dict[str, str]]:
    """Return chat messages instructing the LLM to refine folder suggestions."""

    system_prompt = (
        "Du bist ein Assistent, der eingehende E-Mails passenden Ordnern zuordnet. "
        "Nutze Score-Werte als Hinweis, darfst sie aber anpassen, wenn der Inhalt besser passt. "
        "Falls kein Ordner passt, schlage genau einen neuen Unterordner vor. "
        "Finde außerdem einen übergeordneten Themenbegriff und bis zu drei aussagekräftige Tags. "
        "Antwort ausschließlich als gültiges JSON mit den Schlüsseln 'ranked', 'category', 'proposal' und 'tags'."
    )

    hint = S.EMBED_PROMPT_HINT.strip()
    if hint:
        system_prompt += f" Zusätzliche betriebliche Vorgabe: {hint}."

    structure = _summarize_hierarchy(folders)
    origin = (parent_hint or "(kein Hinweis)").strip() or "(kein Hinweis)"
    user_prompt = (
        "E-Mail-Daten:\n"
        f"Betreff: {subject or '-'}\n"
        f"Von: {sender or '-'}\n"
        "Textauszug:\n"
        f"{body[: S.EMBED_PROMPT_MAX_CHARS]}\n\n"
        "Ausgangsordner: "
        f"{origin}\n\n"
        "Bekannte Ordnerstruktur (Gruppierung nach erster Ebene):\n"
        f"{structure}\n\n"
        "Vorliegende Ordner-Scores:\n"
        f"{_format_ranked_for_prompt(ranked)}\n\n"
        "Schema (JSON):\n"
        '{"ranked": [{"name": "Ordner", "confidence": 0.0-1.0, "reason": "Kurzbegründung"}],'
        ' "category": {"label": "Überbegriff", "matched_folder": "Ordnerpfad oder null", "confidence": 0.0-1.0, "reason": "Warum"},'
        ' "proposal": {"parent": "Überordner", "name": "Neuer Unterordner", "reason": "Warum"} oder null,'
        ' "tags": ["Tag1", "Tag2"] }\n'
        "Maximal drei Einträge in 'ranked' und höchstens drei Tags."
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


async def _chat(messages: List[Dict[str, str]]) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            f"{S.OLLAMA_HOST}/api/chat",
            json={"model": S.CLASSIFIER_MODEL, "messages": messages, "format": "json"},
        )
        response.raise_for_status()
        return response.json()


def _fallback_ranked(ranked: List[Tuple[str, float]]) -> List[Dict[str, Any]]:
    return [
        {"name": name, "score": float(score)}
        for name, score in ranked[: S.MAX_SUGGESTIONS]
    ]


def _parse_ranked(payload: Any, fallback: List[Tuple[str, float]]) -> List[Dict[str, Any]]:
    ranked: List[Dict[str, Any]] = []
    if isinstance(payload, list):
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            confidence_raw = entry.get("confidence", entry.get("score", 0.0))
            try:
                confidence = float(confidence_raw)
            except (TypeError, ValueError):
                confidence = 0.0
            item: Dict[str, Any] = {
                "name": name.strip(),
                "score": max(0.0, min(confidence, 1.0)),
            }
            reason = entry.get("reason")
            if isinstance(reason, str) and reason.strip():
                item["reason"] = reason.strip()
            ranked.append(item)
    if ranked:
        return ranked[: S.MAX_SUGGESTIONS]
    return _fallback_ranked(fallback)


def _parse_category(payload: Any) -> Dict[str, Any] | None:
    if isinstance(payload, dict):
        label_raw = payload.get("label") or payload.get("name") or payload.get("category")
        label = str(label_raw).strip() if label_raw else ""
        matched_raw = payload.get("matched_folder") or payload.get("folder")
        matched = str(matched_raw).strip() if matched_raw else ""
        reason_raw = payload.get("reason")
        reason = str(reason_raw).strip() if isinstance(reason_raw, str) else ""
        confidence_raw = payload.get("confidence") or payload.get("score")
        try:
            confidence = float(confidence_raw) if confidence_raw is not None else None
        except (TypeError, ValueError):
            confidence = None
        result: Dict[str, Any] = {}
        if label:
            result["label"] = label
        if matched:
            result["matched_folder"] = matched
        if reason:
            result["reason"] = reason
        if confidence is not None:
            result["confidence"] = max(0.0, min(confidence, 1.0))
        return result or None
    if isinstance(payload, str) and payload.strip():
        return {"label": payload.strip()}
    return None


def _parse_tags(payload: Any) -> List[str]:
    tags: List[str] = []
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, str):
                continue
            candidate = item.strip()
            if not candidate:
                continue
            if candidate not in tags:
                tags.append(candidate[:48])
            if len(tags) >= 3:
                break
    elif isinstance(payload, str) and payload.strip():
        tags.append(payload.strip()[:48])
    return tags[:3]


def _normalise_proposal(proposal: Any, parent_hint: str | None, top_score: float) -> Dict[str, Any] | None:
    if isinstance(proposal, dict):
        parent = str(proposal.get("parent", parent_hint or "")).strip() or parent_hint or "Projects"
        name = str(proposal.get("name", "")).strip()
        reason = str(proposal.get("reason", "")) or "automatischer Vorschlag"
        if name:
            full_path = f"{parent}/{name}".strip("/")
            return {
                "parent": parent,
                "name": name,
                "reason": reason,
                "full_path": full_path,
                "status": "pending",
                "score_hint": float(top_score),
            }
    return None


async def classify_with_model(
    subject: str,
    sender: str,
    body: str,
    ranked: List[Tuple[str, float]],
    folders: Sequence[str],
    parent_hint: str | None,
) -> Tuple[
    List[Dict[str, Any]],
    Dict[str, Any] | None,
    Dict[str, Any] | None,
    List[str],
]:
    if not S.CLASSIFIER_MODEL:
        return _fallback_ranked(ranked), None, None, []

    messages = build_classification_prompt(subject, sender, body, ranked, folders, parent_hint)
    try:
        response = await _chat(messages)
    except Exception as exc:  # pragma: no cover - network interaction
        logger.warning("Ollama Klassifikation fehlgeschlagen: %s", exc)
        return _fallback_ranked(ranked), None, None, []

    content = response.get("message", {}).get("content")
    if not content:
        return _fallback_ranked(ranked), None, None, []

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:  # pragma: no cover - depends on LLM output
        logger.warning("Konnte Ollama-Antwort nicht parsen: %s", exc)
        return _fallback_ranked(ranked), None, None, []

    refined_ranked = _parse_ranked(parsed.get("ranked"), ranked)
    proposal = _normalise_proposal(
        parsed.get("proposal"), parent_hint, ranked[0][1] if ranked else 0.0
    )
    category = _parse_category(parsed.get("category"))
    tags = _parse_tags(parsed.get("tags"))
    return refined_ranked, proposal, category, tags


async def rank_with_profiles(text: str, profiles: List[Dict[str, Any]]) -> List[Tuple[str, float]]:
    prompt = build_embedding_prompt("", "", text)
    embedding = await embed(prompt)
    return score_profiles(embedding, profiles) if embedding else []


_STOPWORDS = {
    "re",
    "fw",
    "fwd",
    "wg",
    "wegen",
    "und",
    "oder",
    "the",
    "ein",
    "eine",
    "der",
    "die",
    "das",
    "info",
    "newsletter",
    "update",
    "subject",
}


def _normalize_token(token: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-zÄÖÜäöüß]+", "-", token.strip().lower())
    cleaned = cleaned.strip("-")
    return cleaned


def _subject_slug(subject: str) -> str | None:
    tokens = [_normalize_token(part) for part in re.split(r"\s+", subject) if part.strip()]
    filtered = [token for token in tokens if token and token not in _STOPWORDS]
    slug = "-".join(filtered[:3])
    return slug or None


def _sender_slug(sender: str | None) -> str | None:
    if not sender:
        return None
    match = re.search(r"@([A-Za-z0-9._-]+)", sender)
    domain = match.group(1) if match else sender
    primary = domain.split(".")[0]
    cleaned = _normalize_token(primary)
    return cleaned or None


def _derive_folder_name(subject: str, sender: str | None) -> Tuple[str, str]:
    slug = _subject_slug(subject)
    if slug:
        return slug[:32], f'Betreff "{subject.strip()[:40]}"'
    sender_slug = _sender_slug(sender)
    if sender_slug:
        return sender_slug[:32], f"Absender {sender}"[:48]
    return "topic", "Fallback"


async def propose_new_folder_if_needed(
    top_score: float,
    subject: str = "",
    sender: str | None = None,
    parent_hint: str | None = None,
    category: Dict[str, Any] | None = None,
) -> Dict[str, Any] | None:
    if top_score >= S.MIN_NEW_FOLDER_SCORE:
        return None

    category_parent: str | None = None
    if category:
        matched = category.get("matched_folder")
        if isinstance(matched, str) and matched.strip():
            category_parent = matched.strip().split("/")[0]
        label = category.get("label")
        if isinstance(label, str) and label.strip():
            category_parent = category_parent or label.strip()

    parent_candidate = category_parent or parent_hint or "Projects"
    parent = str(parent_candidate).strip("/") or "Projects"
    leaf, basis = _derive_folder_name(subject, sender)
    full_path = "/".join(segment for segment in (parent, leaf) if segment).strip("/")
    proposal_name = leaf
    reason_parts = ["geringe Übereinstimmung mit bekannten Ordnern"]
    if basis != "Fallback":
        reason_parts.append(f"neuer Themenordner aus {basis}")
    if category_parent:
        reason_parts.append(f"Überbegriff {category_parent}")
    reason = "; ".join(reason_parts)

    return {
        "parent": parent,
        "name": proposal_name,
        "reason": reason,
        "full_path": full_path,
        "status": "pending",
        "score_hint": float(top_score),
    }
