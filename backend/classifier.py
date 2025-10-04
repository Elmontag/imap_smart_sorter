
from __future__ import annotations

import json
import logging
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
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{S.OLLAMA_HOST}/api/embeddings",
            json={
                "model": S.EMBED_MODEL,
                "prompt": prompt[: S.EMBED_PROMPT_MAX_CHARS],
            },
        )
        response.raise_for_status()
        data = response.json()
        return data.get("embedding") or data.get("embeddings") or []


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


def build_classification_prompt(
    subject: str,
    sender: str,
    body: str,
    ranked: List[Tuple[str, float]],
) -> List[Dict[str, str]]:
    """Return chat messages instructing the LLM to refine folder suggestions."""

    system_prompt = (
        "Du bist ein Assistent, der eingehende E-Mails passenden Ordnern zuordnet. "
        "Nutze Score-Werte als Hinweis, darfst sie aber anpassen, wenn der Inhalt besser passt. "
        "Falls kein Ordner passt, schlage genau einen neuen Unterordner vor. "
        "Antwort ausschließlich als gültiges JSON mit den Schlüsseln 'ranked' und 'proposal'."
    )

    hint = S.EMBED_PROMPT_HINT.strip()
    if hint:
        system_prompt += f" Zusätzliche betriebliche Vorgabe: {hint}."

    user_prompt = (
        "E-Mail-Daten:\n"
        f"Betreff: {subject or '-'}\n"
        f"Von: {sender or '-'}\n"
        "Textauszug:\n"
        f"{body[: S.EMBED_PROMPT_MAX_CHARS]}\n\n"
        "Vorliegende Ordner-Scores:\n"
        f"{_format_ranked_for_prompt(ranked)}\n\n"
        "Schema (JSON):\n"
        '{"ranked": [{"name": "Ordner", "confidence": 0.0-1.0, "reason": "Kurzbegründung"}],'
        ' "proposal": {"parent": "Überordner", "name": "Neuer Unterordner", "reason": "Warum"} oder null}\n'
        "Maximal drei Einträge in 'ranked'."
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
    parent_hint: str | None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any] | None]:
    if not S.CLASSIFIER_MODEL:
        return _fallback_ranked(ranked), None

    messages = build_classification_prompt(subject, sender, body, ranked)
    try:
        response = await _chat(messages)
    except Exception as exc:  # pragma: no cover - network interaction
        logger.warning("Ollama Klassifikation fehlgeschlagen: %s", exc)
        return _fallback_ranked(ranked), None

    content = response.get("message", {}).get("content")
    if not content:
        return _fallback_ranked(ranked), None

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:  # pragma: no cover - depends on LLM output
        logger.warning("Konnte Ollama-Antwort nicht parsen: %s", exc)
        return _fallback_ranked(ranked), None

    refined_ranked = _parse_ranked(parsed.get("ranked"), ranked)
    proposal = _normalise_proposal(
        parsed.get("proposal"), parent_hint, ranked[0][1] if ranked else 0.0
    )
    return refined_ranked, proposal


async def rank_with_profiles(text: str, profiles: List[Dict[str, Any]]) -> List[Tuple[str, float]]:
    prompt = build_embedding_prompt("", "", text)
    embedding = await embed(prompt)
    return score_profiles(embedding, profiles) if embedding else []


async def propose_new_folder_if_needed(
    top_score: float, parent_hint: str | None = None
) -> Dict[str, Any] | None:
    if top_score < S.MIN_NEW_FOLDER_SCORE:
        parent = parent_hint or "Projects"
        name = "_auto/topic"
        full_path = f"{parent}/{name}".strip("/")
        return {
            "parent": parent,
            "name": name,
            "reason": "geringe Übereinstimmung mit bekannten Ordnern",
            "full_path": full_path,
            "status": "pending",
            "score_hint": float(top_score),
        }
    return None
