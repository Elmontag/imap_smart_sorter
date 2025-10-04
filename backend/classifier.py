
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Sequence, Tuple

import httpx

from settings import S


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
        "Erstelle eine aussagekräftige semantische Repräsentation auf Basis von Betreff, Absender und Kerninhalten.",
    ]
    hint = S.EMBED_PROMPT_HINT.strip()
    if hint:
        header_lines.append(f"Zusätzliche Vorgabe: {hint}")

    email_lines = [
        f"Betreff: {subject or '-'}",
        f"Von: {sender or '-'}",
        "Inhalt:",
        body.strip() or "(kein Text vorhanden)",
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


async def rank_with_profiles(text: str, profiles: List[Dict[str, Any]]) -> List[Tuple[str, float]]:
    prompt = build_embedding_prompt("", "", text)
    embedding = await embed(prompt)
    return score_profiles(embedding, profiles) if embedding else []


async def propose_new_folder_if_needed(
    top_score: float, parent_hint: str | None = None
) -> Dict[str, Any] | None:
    if top_score < S.MIN_NEW_FOLDER_SCORE:
        return {
            "parent": parent_hint or "Projects",
            "name": "_auto/topic",
            "reason": "niedrige Ähnlichkeit",
        }
    return None
