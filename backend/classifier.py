
from __future__ import annotations

import json
import logging
import re
import textwrap
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import httpx

from configuration import (
    context_tag_summary,
    ensure_top_level_parent,
    find_top_level_for_label,
    folder_templates_summary,
    folder_catalog_paths,
    get_context_tag_guidelines,
    get_tag_slots,
    TagSlot,
    max_tag_total,
    tag_slots_summary,
    tag_slot_options_map,
    top_level_folder_names,
)
from ollama_service import get_model_context_window
from settings import S
from runtime_settings import resolve_classifier_model


logger = logging.getLogger(__name__)


_DOMAIN_RE = re.compile(r"@([A-Za-z0-9.-]+)")
_MIN_NUM_CTX = 2048
_PROMPT_CHAR_PER_TOKEN = 4
_PROMPT_HEADROOM_RATIO = 0.9
_CLASSIFIER_CONTEXT_CACHE: Dict[str, int] = {}


def _is_user_override(field_name: str) -> bool:
    configured = getattr(S, "model_fields_set", set())
    return field_name in configured if isinstance(configured, set) else False


def _configured_num_ctx() -> int:
    try:
        num_ctx = int(S.CLASSIFIER_NUM_CTX)
    except (TypeError, ValueError):
        num_ctx = 4096
    return max(_MIN_NUM_CTX, num_ctx)


async def _resolve_context_window() -> int:
    fallback = _configured_num_ctx()
    user_override = fallback if _is_user_override("CLASSIFIER_NUM_CTX") else None

    if getattr(S, "CLASSIFIER_NUM_CTX_MATCH_MODEL", False):
        cache_key = resolve_classifier_model().strip()
        if cache_key:
            if cache_key in _CLASSIFIER_CONTEXT_CACHE:
                resolved = _CLASSIFIER_CONTEXT_CACHE[cache_key]
            else:
                try:
                    resolved = await get_model_context_window(cache_key)
                except Exception as exc:  # pragma: no cover - network interaction
                    logger.debug("Kontextfenster konnte nicht ermittelt werden: %s", exc)
                    resolved = None
                if isinstance(resolved, int) and resolved > 0:
                    _CLASSIFIER_CONTEXT_CACHE[cache_key] = resolved
            if cache_key in _CLASSIFIER_CONTEXT_CACHE:
                resolved = _CLASSIFIER_CONTEXT_CACHE[cache_key]
                if user_override is not None:
                    resolved = min(resolved, user_override)
                return max(_MIN_NUM_CTX, resolved)

    return user_override or fallback


def _approx_prompt_char_budget(num_ctx: int) -> int:
    if num_ctx <= 0:
        return int(S.EMBED_PROMPT_MAX_CHARS)
    budget = int(num_ctx * _PROMPT_CHAR_PER_TOKEN * _PROMPT_HEADROOM_RATIO)
    return max(int(S.EMBED_PROMPT_MAX_CHARS * 0.5), budget)


def _catalog_line_limit(num_ctx: int) -> int:
    if num_ctx <= 0:
        return 40
    computed = max(20, num_ctx // 64)
    return min(80, computed)


def _truncate_body_for_context(body: str, num_ctx: int, overhead_chars: int) -> str:
    if not body:
        return ""

    char_budget = _approx_prompt_char_budget(num_ctx)
    available = max(0, char_budget - overhead_chars)

    reserve_tokens = getattr(S, "CLASSIFIER_CONTEXT_RESERVE_TOKENS", 1200)
    try:
        reserve_tokens = int(reserve_tokens)
    except (TypeError, ValueError):
        reserve_tokens = 1200
    reserve_tokens = max(400, reserve_tokens)
    reserve_chars = int(reserve_tokens * _PROMPT_CHAR_PER_TOKEN)
    if char_budget:
        available = max(0, min(available, char_budget - reserve_chars))

    max_chars = min(len(body), S.EMBED_PROMPT_MAX_CHARS)
    if available > 0:
        max_chars = min(max_chars, available)
    return body[: max(0, max_chars)]


def _sender_domain(value: str) -> str:
    if not value:
        return ""
    match = _DOMAIN_RE.search(value)
    if not match:
        return ""
    return match.group(1).lower().strip()


def _cosine(a: Sequence[float], b: Sequence[float] | None) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    num = sum(x * y for x, y in zip(a, b))
    den = (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5)
    return num / den if den else 0.0


def build_embedding_prompt(subject: str, sender: str, body: str) -> str:
    """Create a consistent prompt for Ollama embeddings."""

    sender_domain = _sender_domain(sender)

    header_lines = [
        "Du bist ein Assistent, der E-Mails für eine Ordnerklassifikation analysiert.",
        "Erstelle eine vollständige, strukturierte Repräsentation mit Fokus auf Unternehmen, Geschäftsfall und eindeutige Kennzeichen.",
        "Arbeite mit vollständigen Sätzen und fasse zusammen, welche Aufgabe oder Anfrage die Mail beschreibt.",
    ]
    hint = S.EMBED_PROMPT_HINT.strip()
    if hint:
        header_lines.append(f"Zusätzliche Vorgabe: {hint}")

    email_lines = [
        "Metadaten:",
        f"- Betreff: {subject or '-'}",
        f"- Von: {sender or '-'}",
        f"- Absender-Domain: {sender_domain or '-'}",
        "Wesentlicher Inhalt (max. 8000 Zeichen):",
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


def _normalise_score_value(raw: Any) -> Tuple[float, float]:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0, 0.0
    if value > 1.0:
        rating = max(0.0, min(value, 100.0))
        return rating / 100.0, rating
    clamped = max(0.0, min(value, 1.0))
    rating = clamped * 100.0
    return clamped, rating


_CATALOG_STOPWORDS = {"inbox"}

# Tokens that indicate that the LLM left placeholders unchanged. They are
# filtered out aggressively so that downstream consumers never see unresolved
# template markers such as "NAME" or "YYYY".
_PLACEHOLDER_TOKENS = {
    "NAME",
    "ORT",
    "PLACEHOLDER",
    "PLATZHALTER",
    "SAMPLE",
    "BEISPIEL",
    "VALUE",
    "WERT",
    "TODO",
    "TBD",
}

# Numeric placeholders (e.g. YYYY-MM-TT) are tracked separately to avoid false
# positives for real words that just happen to contain one of the short tokens.
_PLACEHOLDER_NUMERIC_TOKENS = {"YYYY", "YY", "MM", "TT", "DD"}


def _split_catalog_segments(value: str) -> List[str]:
    normalised = re.sub(r"[\\]+", "/", value or "")
    segments = [segment.strip() for segment in normalised.split("/") if segment.strip()]
    return segments


def _catalog_signature(value: str) -> str:
    if not isinstance(value, str):
        return ""
    parts = re.split(r"[\\s/]+", value.lower())
    tokens: List[str] = []
    for part in parts:
        cleaned = re.sub(r"[^0-9a-zäöüß]+", "", part)
        if cleaned and cleaned not in _CATALOG_STOPWORDS:
            tokens.append(cleaned)
    return " ".join(tokens)


def _catalog_index() -> List[Tuple[str, str]]:
    return [(path, _catalog_signature(path)) for path in folder_catalog_paths()]


def _match_catalog_path(name: str, catalog_index: Sequence[Tuple[str, str]] | None = None) -> Tuple[str, float] | None:
    if not isinstance(name, str):
        return None
    candidate = name.strip()
    if not candidate:
        return None
    index = list(catalog_index or _catalog_index())
    if not index:
        return None

    def _iter_variants(raw: str) -> Iterable[str]:
        segments = _split_catalog_segments(raw)
        if not segments:
            return []
        seen: set[str] = set()
        inbox_aliases = {"inbox"}
        inbox_value = (S.IMAP_INBOX or "").strip().lower()
        if inbox_value:
            inbox_aliases.add(inbox_value)
        joined = "/".join(segments)
        if joined and joined.lower() not in seen:
            seen.add(joined.lower())
            yield joined
        trimmed = list(segments)
        while trimmed and trimmed[0].strip().lower() in inbox_aliases:
            trimmed = trimmed[1:]
        if trimmed and trimmed != segments:
            trimmed_joined = "/".join(trimmed)
            if trimmed_joined and trimmed_joined.lower() not in seen:
                seen.add(trimmed_joined.lower())
                yield trimmed_joined
        for start in range(1, len(segments)):
            variant_segments = segments[start:]
            if not variant_segments:
                continue
            variant = "/".join(variant_segments)
            lowered_variant = variant.lower()
            if lowered_variant in seen:
                continue
            seen.add(lowered_variant)
            yield variant

    lowered = candidate.lower()
    for path, _ in index:
        if path.lower() == lowered:
            return path, 100.0

    best_path: str | None = None
    best_score = 0.0
    for variant in _iter_variants(candidate):
        signature = _catalog_signature(variant)
        if not signature:
            continue
        for path, catalog_sig in index:
            if not catalog_sig:
                continue
            if path.lower() == variant.lower():
                return path, 100.0
            ratio = SequenceMatcher(None, signature, catalog_sig).ratio()
            if ratio > best_score:
                best_score = ratio
                best_path = path
                if ratio >= 0.999:
                    return best_path, 100.0
    if best_path is None:
        return None
    rating = max(0.0, min(best_score * 100.0, 100.0))
    if rating < float(S.MIN_MATCH_SCORE or 0):
        return None
    return best_path, rating


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
    *,
    body_snippet: str | None = None,
    max_catalog_entries: int | None = None,
) -> List[Dict[str, str]]:
    """Return chat messages instructing the LLM to refine folder suggestions."""

    sender_domain = _sender_domain(sender)
    templates_overview = folder_templates_summary()
    tag_overview = tag_slots_summary()
    context_overview = context_tag_summary()
    top_levels = ", ".join(top_level_folder_names()) or "(keine Vorgaben)"
    folder_catalog = folder_catalog_paths()
    tag_catalog = tag_slot_options_map()
    threshold = S.MIN_MATCH_SCORE

    limit = 80 if max_catalog_entries is None else max(5, min(80, max_catalog_entries))
    folder_catalog_lines = [f"- {path}" for path in folder_catalog[:limit]]
    if len(folder_catalog) > limit:
        folder_catalog_lines.append("- … (weitere Pfade im Katalog verfügbar)")
    folder_catalog_overview = "\n".join(folder_catalog_lines) or "- (leer)"

    tag_catalog_lines: List[str] = []
    for slot_name, options in tag_catalog.items():
        rendered_options = ", ".join(options) if options else "(keine Optionen)"
        tag_catalog_lines.append(f"- {slot_name}: {rendered_options}")
    tag_catalog_overview = "\n".join(tag_catalog_lines) or "- (keine Tags definiert)"

    tag_slots = get_tag_slots()
    slot_schema_parts: List[str] = []
    for slot in tag_slots:
        options = " | ".join(slot.options) if slot.options else "frei"
        slot_schema_parts.append(f'"{slot.name}": "Wert aus {options}"')
    extras_samples = [f"{item.name}-wert" for item in get_context_tag_guidelines()[:2]]
    if extras_samples:
        extras_literal = ", ".join(f'"{sample}"' for sample in extras_samples)
        extras_part = f'"extras": [{extras_literal}]'
    else:
        extras_part = '"extras": []'
    schema_parts = list(slot_schema_parts)
    schema_parts.append(extras_part)
    tag_schema = "{" + ", ".join(schema_parts) + "}"

    system_prompt = textwrap.dedent(
        f"""
        Du bist ein Assistent, der eingehende E-Mails anhand eines festen Ordner- und Tag-Katalogs analysiert.
        Aufgaben:
        1. Lies Betreff, Absender (inklusive Domain) und Textauszug vollständig und identifiziere das Kernthema.
        2. Vergleiche die Mail mit dem Ordnerkatalog und den vorhandenen Scores, um die beste Zuordnung zu finden.
        3. Bewerte jeden Treffer mit 0 bis 100 Punkten und liefere begründete Vorschläge für neue Unterordner nur bei Bedarf.

        Bewertungsrichtlinie:
        - Verwende ausschließlich Pfade aus dem Ordnerkatalog. Wird der Schwellwert von {threshold} Punkten nicht erreicht, kennzeichne das Ergebnis als "unmatched".
        - Vergib für jeden Tag-Slot genau eine Option aus dem Tag-Katalog und bewerte sie nach demselben Punkteschema.
        - Nutze verständliche, kurze deutsche Begründungen.

        Ausgabeformat:
        - Antworte ausschließlich als gültiges JSON mit den Schlüsseln 'ranked', 'category', 'proposal', 'tags' und optional 'extras'.
        - 'ranked' enthält bis zu {S.MAX_SUGGESTIONS} Einträge mit 'name', 'score' (0–1), 'rating' (0–100) und einer kurzen 'reason'.
        - 'category' beschreibt den Top-Level-Ordner, den passenden Pfad und die Bewertung.
        - 'proposal' enthält nur bei Bedarf einen neuen Unterordner mit Begründung.
        - 'tags' enthält je Slot exakt eine Option; 'extras' listet eindeutige Kontext-Stichworte.

        Konsistenzregeln:
        - Ersetze Platzhalter wie NAME, ORT oder YYYY konsequent durch echte Werte.
        - Nutze identische Pfade für wiederkehrende Geschäftsprozesse (z. B. Amazon-Bestellungen) und bleibe bei ähnlichen Fällen konsistent.
        - Liefere keine freien Texte außerhalb des JSON.
        """
    ).strip()

    hint = S.EMBED_PROMPT_HINT.strip()
    if hint:
        system_prompt += f" Zusätzliche betriebliche Vorgabe: {hint}."

    structure = _summarize_hierarchy(folders)
    origin = (parent_hint or "(kein Hinweis)").strip() or "(kein Hinweis)"
    schema_prefix = (
        '{"ranked": [{"name": "Pfad aus Ordnerkatalog", "score": 0-100, "reason": "Kurzbegründung"}],'
        ' "category": {"label": "Top-Level oder '"'unmatched'"'", "matched_folder": "Pfad oder null", "score": 0-100, "reason": "Warum"},'
        ' "proposal": {"parent": "Top-Level", "name": "Neuer Unterordner", "reason": "Warum"} oder null,'
    )
    snippet = body_snippet
    if snippet is None:
        snippet = body[: S.EMBED_PROMPT_MAX_CHARS]

    user_prompt = textwrap.dedent(
        f"""
        ## Metadaten
        - Betreff: {subject or '-'}
        - Von: {sender or '-'}
        - Absender-Domain: {sender_domain or '-'}
        - Ausgangsordner: {origin}

        ## Textauszug
        {snippet}

        ## Konfigurierte Top-Level-Ordner
        {top_levels}

        ## Vorgegebene Struktur
        {templates_overview}

        ## Ordnerkatalog (verwende exakt diese Pfade)
        {folder_catalog_overview}

        ## Bekannte Ordnerstruktur (Gruppierung nach erster Ebene)
        {structure}

        ## Tag-Slots
        {tag_overview}

        ## Tag-Katalog (Optionen je Slot)
        {tag_catalog_overview}

        ## Kontext-Tags
        {context_overview}

        ## Vorliegende Ordner-Scores
        {_format_ranked_for_prompt(ranked)}

        ## Schema (JSON)
        {schema_prefix} "tags": {tag_schema} }}

        Arbeitsanweisung:
        - Fülle jeden Tag-Slot mit genau einer Option aus dem Katalog (oder einem eindeutigen Ein-Wort-Synonym).
        - Ergänze in 'extras' nur eindeutige zusätzliche Schlagwörter.
        - Verwende konsistente Ordnerpfade und kurze deutsche Begründungen.
        """
    ).strip()

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


_JSON_DECODER = json.JSONDecoder()
_CLASSIFIER_KEYS = {"ranked", "category", "tags", "extras", "proposal"}


def _strip_code_fence(content: str) -> str:
    text = content.strip()
    if not text.startswith("```"):
        return text
    stripped = text[3:]
    stripped = stripped.lstrip()
    if stripped.lower().startswith("json"):
        stripped = stripped[4:].lstrip()
    closing = stripped.rfind("```")
    if closing != -1:
        stripped = stripped[:closing]
    return stripped.strip()


def _candidate_json_segments(content: Any) -> List[str]:
    if not isinstance(content, str):
        return []

    text = content.strip()
    if not text:
        return []

    candidates: List[str] = []

    fenced = _strip_code_fence(text)
    if fenced:
        candidates.append(fenced)

    if text and text not in candidates:
        candidates.append(text)

    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start != -1 and brace_end != -1 and brace_end > brace_start:
        inner = text[brace_start : brace_end + 1].strip()
        if inner and inner not in candidates:
            candidates.append(inner)

    return candidates


def _looks_like_classifier_payload(payload: Dict[str, Any]) -> bool:
    if any(key in payload for key in _CLASSIFIER_KEYS):
        return True
    return False


def _load_json_payload(
    content: Any,
    *,
    _visited: set[int] | None = None,
    _depth: int = 0,
) -> Dict[str, Any] | None:
    if _visited is None:
        _visited = set()

    if isinstance(content, (dict, list)):
        marker = id(content)
        if marker in _visited:
            return None
        _visited.add(marker)

    if isinstance(content, dict):
        if _looks_like_classifier_payload(content):
            return content
        if _depth > 6:
            return None
        nested_keys = (
            "message",
            "content",
            "response",
            "data",
            "delta",
            "value",
            "payload",
            "body",
        )
        for key in nested_keys:
            if key in content:
                parsed = _load_json_payload(
                    content[key], _visited=_visited, _depth=_depth + 1
                )
                if parsed:
                    return parsed
        for value in content.values():
            parsed = _load_json_payload(value, _visited=_visited, _depth=_depth + 1)
            if parsed:
                return parsed
        return None

    if isinstance(content, list):
        if _depth > 6:
            return None
        for item in content:
            parsed = _load_json_payload(item, _visited=_visited, _depth=_depth + 1)
            if parsed:
                return parsed
        return None

    if isinstance(content, str):
        for candidate in _candidate_json_segments(content):
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                try:
                    parsed, _ = _JSON_DECODER.raw_decode(candidate)
                except json.JSONDecodeError:
                    continue
            if isinstance(parsed, dict) and _looks_like_classifier_payload(parsed):
                return parsed
        return None

    return None


async def _chat(
    messages: List[Dict[str, str]], *, num_ctx: int | None = None
) -> Dict[str, Any]:
    try:
        temperature = float(S.CLASSIFIER_TEMPERATURE)
    except (TypeError, ValueError):
        temperature = 0.1
    temperature = max(0.0, temperature)

    try:
        top_p = float(S.CLASSIFIER_TOP_P)
    except (TypeError, ValueError):
        top_p = 0.4
    top_p = min(1.0, max(0.0, top_p))

    try:
        num_predict = int(S.CLASSIFIER_NUM_PREDICT)
    except (TypeError, ValueError):
        num_predict = 512
    if num_predict < 128:
        num_predict = 128

    if not isinstance(num_ctx, int) or num_ctx <= 0:
        num_ctx = _configured_num_ctx()

    payload = {
        "model": resolve_classifier_model(),
        "messages": messages,
        "format": "json",
        "stream": True,
        "keep_alive": "15m",
        "options": {
            "temperature": temperature,
            "top_p": top_p,
            "num_predict": num_predict,
            "num_ctx": num_ctx,
            "repeat_penalty": 1.1,
        },
    }
    timeout = httpx.Timeout(connect=30.0, read=300.0, write=120.0, pool=None)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream("POST", f"{S.OLLAMA_HOST}/api/chat", json=payload) as response:
                response.raise_for_status()

                content_chunks: List[str] = []
                structured_content: Any | None = None
                final_payload: Dict[str, Any] | None = None
                latest_payload: Dict[str, Any] | None = None

                decoder = json.JSONDecoder()
                buffer = ""
                done_received = False

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    chunk = line.strip()
                    if not chunk:
                        continue
                    if chunk.startswith(":"):
                        continue
                    prefix = chunk.split(":", 1)[0].strip().lower()
                    if prefix in {"event", "id", "retry"}:
                        continue
                    if chunk.startswith("data:"):
                        chunk = chunk[5:].strip()
                        if not chunk:
                            continue
                    if chunk in {"[DONE]", "done"}:
                        break

                    buffer += chunk

                    while buffer:
                        working = buffer.lstrip()
                        if working is not buffer:
                            buffer = working
                        try:
                            data, offset = decoder.raw_decode(buffer)
                        except json.JSONDecodeError:
                            if len(buffer) > 262144:
                                buffer = buffer[-262144:]
                            break
                        buffer = buffer[offset:]
                        if isinstance(data, dict) and data.get("error"):
                            raise RuntimeError(str(data.get("error")))
                        if not isinstance(data, dict):
                            continue
                        latest_payload = data
                        message = data.get("message")
                        if isinstance(message, dict):
                            piece = message.get("content")
                            if isinstance(piece, str):
                                if piece:
                                    content_chunks.append(piece)
                            elif piece is not None:
                                structured_content = piece
                        response_piece = data.get("response")
                        if isinstance(response_piece, str):
                            if response_piece:
                                content_chunks.append(response_piece)
                        elif response_piece is not None:
                            structured_content = response_piece
                        if data.get("done"):
                            final_payload = data
                            done_received = True
                            break
                    if done_received:
                        break

                combined = "".join(content_chunks).strip()
                fallback_source = final_payload or latest_payload
                if structured_content is None and not combined and fallback_source:
                    message = fallback_source.get("message")
                    if isinstance(message, dict):
                        fallback_content = message.get("content")
                        if isinstance(fallback_content, str) and fallback_content.strip():
                            combined = fallback_content.strip()
                        elif fallback_content is not None:
                            structured_content = fallback_content
                    if structured_content is None and not combined:
                        response_payload = fallback_source.get("response")
                        if isinstance(response_payload, str) and response_payload.strip():
                            combined = response_payload.strip()
                        elif response_payload is not None:
                            structured_content = response_payload

                if not combined and structured_content is None:
                    raise RuntimeError("Leere Antwort von Ollama")

                source_payload = final_payload or latest_payload or {}
                base_payload: Dict[str, Any] = source_payload.copy()
                message_payload = base_payload.get("message")
                if not isinstance(message_payload, dict):
                    message_payload = {}
                if structured_content is not None:
                    message_payload["content"] = structured_content
                else:
                    message_payload["content"] = combined
                base_payload["message"] = message_payload
                return base_payload
        except httpx.TimeoutException as exc:  # pragma: no cover - network interaction
            raise RuntimeError("Ollama Chat Timeout überschritten") from exc
        except httpx.HTTPStatusError as exc:  # pragma: no cover - network interaction
            status = exc.response.status_code if exc.response is not None else "?"
            raise RuntimeError(f"Ollama Chat HTTP-Fehler: {status}") from exc


def _fallback_ranked(ranked: List[Tuple[str, float]]) -> List[Dict[str, Any]]:
    raw_items: List[Dict[str, Any]] = []
    for name, score in ranked[: S.MAX_SUGGESTIONS]:
        normalised, rating = _normalise_score_value(score)
        raw_items.append({"name": name, "score": normalised, "rating": rating})
    canonical = _canonicalize_ranked(raw_items)
    if canonical:
        return canonical
    return []


def _parse_ranked(payload: Any, fallback: List[Tuple[str, float]]) -> List[Dict[str, Any]]:
    ranked: List[Dict[str, Any]] = []
    if isinstance(payload, list):
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("path")
            if not isinstance(name, str) or not name.strip():
                continue
            confidence_raw = (
                entry.get("score")
                if "score" in entry
                else entry.get("confidence", entry.get("rating", 0.0))
            )
            normalised, rating = _normalise_score_value(confidence_raw)
            item: Dict[str, Any] = {
                "name": name.strip(),
                "score": normalised,
                "rating": rating,
            }
            reason = entry.get("reason")
            if isinstance(reason, str) and reason.strip():
                item["reason"] = reason.strip()
            ranked.append(item)
    canonical = _canonicalize_ranked(ranked)
    if canonical:
        return canonical
    return _fallback_ranked(fallback)


def _parse_category(payload: Any) -> Dict[str, Any] | None:
    if isinstance(payload, dict):
        label_raw = payload.get("label") or payload.get("name") or payload.get("category")
        label = str(label_raw).strip() if label_raw else ""
        matched_raw = payload.get("matched_folder") or payload.get("folder")
        matched = str(matched_raw).strip() if matched_raw else ""
        reason_raw = payload.get("reason")
        reason = str(reason_raw).strip() if isinstance(reason_raw, str) else ""
        confidence_raw = None
        if "score" in payload:
            confidence_raw = payload.get("score")
        elif "confidence" in payload:
            confidence_raw = payload.get("confidence")
        elif "rating" in payload:
            confidence_raw = payload.get("rating")
        confidence: float | None = None
        rating: float | None = None
        if confidence_raw is not None:
            confidence, rating = _normalise_score_value(confidence_raw)
        result: Dict[str, Any] = {}
        if label:
            result["label"] = label
        if matched:
            result["matched_folder"] = matched
        if reason:
            result["reason"] = reason
        if confidence is not None:
            result["confidence"] = max(0.0, min(confidence, 1.0))
        if rating is not None:
            result["rating"] = rating
        lowered_label = result.get("label", "").strip().lower() if result.get("label") else ""
        if lowered_label != "unmatched":
            catalog_match = None
            if matched:
                catalog_match = _match_catalog_path(matched)
            if not catalog_match and label:
                catalog_match = _match_catalog_path(label)
            if catalog_match:
                canonical, match_rating = catalog_match
                result["matched_folder"] = canonical
                top_level = canonical.split("/")[0]
                result["label"] = top_level
                existing_rating = result.get("rating")
                try:
                    numeric = float(existing_rating) if existing_rating is not None else match_rating
                except (TypeError, ValueError):
                    numeric = match_rating
                numeric = max(0.0, min(numeric, 100.0))
                final_rating = max(numeric, match_rating)
                result["rating"] = final_rating
                result["confidence"] = max(0.0, min(final_rating / 100.0, 1.0))
            else:
                resolved_top_level = find_top_level_for_label(label)
                if resolved_top_level:
                    result["label"] = resolved_top_level
                    result.pop("matched_folder", None)
        return result or None
    if isinstance(payload, str) and payload.strip():
        return {"label": payload.strip()}
    return None


def _canonicalize_ranked(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not items:
        return []
    catalog_index = _catalog_index()
    trimmed: List[Dict[str, Any]] = []
    for entry in items[: S.MAX_SUGGESTIONS]:
        cleaned: Dict[str, Any] = {}
        if isinstance(entry.get("name"), str):
            cleaned["name"] = entry["name"].strip()
        score_val = entry.get("score")
        rating_val = entry.get("rating")
        if isinstance(score_val, (int, float)):
            cleaned["score"] = max(0.0, min(float(score_val), 1.0))
        if isinstance(rating_val, (int, float)):
            cleaned["rating"] = max(0.0, min(float(rating_val), 100.0))
        reason_val = entry.get("reason")
        if isinstance(reason_val, str) and reason_val.strip():
            cleaned["reason"] = reason_val.strip()
        if cleaned:
            trimmed.append(cleaned)
    if not catalog_index:
        return trimmed
    normalised: Dict[str, Dict[str, Any]] = {}
    for entry in items:
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        match = _match_catalog_path(name, catalog_index)
        if not match:
            continue
        canonical, match_rating = match
        rating_raw = entry.get("rating")
        if rating_raw is None and "score" in entry:
            rating_raw = float(entry.get("score", 0.0)) * 100.0
        try:
            rating_value = float(rating_raw) if rating_raw is not None else match_rating
        except (TypeError, ValueError):
            rating_value = match_rating
        rating_value = max(0.0, min(rating_value, 100.0))
        final_rating = max(rating_value, match_rating)
        final_score = final_rating / 100.0
        reason_val = entry.get("reason")
        cleaned_entry: Dict[str, Any] = {
            "name": canonical,
            "score": final_score,
            "rating": final_rating,
        }
        if isinstance(reason_val, str) and reason_val.strip():
            cleaned_entry["reason"] = reason_val.strip()
        existing = normalised.get(canonical)
        if existing is None or existing.get("rating", 0.0) < final_rating:
            normalised[canonical] = cleaned_entry
    ordered = sorted(normalised.values(), key=lambda row: row.get("rating", 0.0), reverse=True)
    if ordered:
        return ordered[: S.MAX_SUGGESTIONS]
    return trimmed


def _normalise_tag_word(raw: Any) -> str | None:
    if raw is None:
        return None
    candidate = str(raw).strip()
    if not candidate:
        return None
    token = re.split(r"[\s,;/|]+", candidate, maxsplit=1)[0]
    cleaned = re.sub(r"[^0-9A-Za-zÄÖÜäöüß+-]", "", token)
    cleaned = cleaned.strip("-_+")
    return cleaned[:32] or None


def _has_placeholder_token(word: str, *, ignore_prefix: bool = False) -> bool:
    """Return True when a tag candidate still contains obvious placeholders.

    The classifier prompt strongly encourages the model to replace placeholders
    such as "NAME" or "YYYY". Should a response still contain these tokens we
    silently drop the suggestion to avoid propagating incomplete data.
    """

    if not word:
        return False
    segments = [segment for segment in re.split(r"[-_/]+", word) if segment]
    if ignore_prefix and segments:
        segments = segments[1:]
    for segment in segments:
        upper = segment.upper()
        if upper in _PLACEHOLDER_TOKENS:
            return True
        if upper in _PLACEHOLDER_NUMERIC_TOKENS:
            return True
    return False


def _parse_tags(payload: Any, extras_payload: Any | None = None) -> List[str]:
    slots = get_tag_slots()
    max_total = max_tag_total()
    threshold = float(S.MIN_MATCH_SCORE or 0)

    def _slot_slug(slot: Any) -> str:
        base = ""
        if isinstance(slot, TagSlot):
            base = slot.aliases[0] if slot.aliases else slot.name
        else:
            base = str(slot or "")
        slug = re.sub(r"[^0-9A-Za-z]+", "-", base.strip().lower())
        return slug.strip("-") or "tag"

    def _resolve_slot(key: str) -> TagSlot | None:
        lowered = key.strip().lower()
        for slot in slots:
            candidates = [slot.name, *slot.aliases]
            for candidate in candidates:
                if candidate.strip().lower() == lowered:
                    return slot
        return None

    def _resolve_option(slot: TagSlot, value: str) -> str | None:
        if not value:
            return None
        candidate = value.strip()
        if not candidate:
            return None
        option_lookup = {opt.lower(): opt for opt in slot.options}
        lowered = candidate.lower()
        if lowered in option_lookup:
            return option_lookup[lowered]
        normalised_candidate = (_normalise_tag_word(candidate) or "").lower()
        if not normalised_candidate:
            return None
        for opt in slot.options:
            if (_normalise_tag_word(opt) or "").lower() == normalised_candidate:
                return opt
        return None

    def _extract_extras(value: Any) -> List[str]:
        extras: List[str] = []
        if isinstance(value, list):
            for item in value:
                word = _normalise_tag_word(item)
                if word and word not in extras and not _has_placeholder_token(word, ignore_prefix=True):
                    extras.append(word)
        elif isinstance(value, str):
            word = _normalise_tag_word(value)
            if word and not _has_placeholder_token(word, ignore_prefix=True):
                extras.append(word)
        return extras

    slot_candidates: List[Tuple[TagSlot | None, Any, Any]] = []
    extras_candidate = extras_payload

    if isinstance(payload, dict):
        lower_map = {
            str(key).strip().lower(): value for key, value in payload.items()
            if isinstance(key, str)
        }
        for key, value in payload.items():
            if not isinstance(key, str):
                continue
            lowered = key.strip().lower()
            if lowered in {"extras", "kontext", "context", "additional", "more"}:
                extras_candidate = value
                continue
            slot = _resolve_slot(key)
            if not slot:
                continue
            if isinstance(value, dict):
                label = value.get("value") or value.get("label") or value.get("name") or value.get("tag")
                score = value.get("score")
                if score is None:
                    score = value.get("rating", value.get("confidence"))
            else:
                label = value
                score = None
            slot_candidates.append((slot, label, score))
        if not extras_candidate:
            for key in ("extras", "kontext", "context", "additional", "more"):
                if key in lower_map:
                    extras_candidate = lower_map[key]
                    break
    elif isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                slot_key = item.get("slot") or item.get("name") or item.get("key")
                slot = _resolve_slot(str(slot_key)) if slot_key else None
                if not slot:
                    continue
                label = item.get("value") or item.get("label") or item.get("tag")
                score = item.get("score")
                if score is None:
                    score = item.get("rating", item.get("confidence"))
                slot_candidates.append((slot, label, score))
            else:
                # Fallback: treat as loose tag without slot
                slot_candidates.append((None, item, None))
    elif isinstance(payload, str):
        slot_candidates.append((None, payload, None))

    assignments: Dict[str, Tuple[str, float]] = {}
    extras: List[str] = []

    for slot, label, score in slot_candidates:
        value_word = _normalise_tag_word(label)
        if slot is None:
            if value_word and value_word not in extras:
                if not _has_placeholder_token(value_word, ignore_prefix=True):
                    extras.append(value_word)
            continue
        option = _resolve_option(slot, label if isinstance(label, str) else "") if isinstance(label, str) else None
        if not option:
            continue
        _, rating = _normalise_score_value(score if score is not None else threshold)
        if rating < threshold:
            continue
        slot_slug = _slot_slug(slot)
        value_slug = (_normalise_tag_word(option) or option).lower()
        tag_value = f"{slot_slug}-{value_slug}".strip("-")
        if not tag_value:
            continue
        if _has_placeholder_token(tag_value, ignore_prefix=True):
            continue
        previous = assignments.get(slot.name)
        if previous and previous[1] >= rating:
            continue
        assignments[slot.name] = (tag_value, rating)

    if extras_candidate is not None:
        extras.extend(_extract_extras(extras_candidate))

    ordered_tags: List[str] = []
    for slot in slots:
        assigned = assignments.get(slot.name)
        if assigned:
            tag_value = assigned[0]
            if tag_value and tag_value not in ordered_tags:
                ordered_tags.append(tag_value)

    for extra in extras:
        if extra and extra not in ordered_tags:
            ordered_tags.append(extra)
        if len(ordered_tags) >= max_total:
            break

    if ordered_tags:
        return ordered_tags[:max_total]

    # Fallback to the previous behaviour to remain resilient against unexpected payloads.
    normalised: List[str] = []
    if isinstance(payload, list):
        for item in payload:
            word = _normalise_tag_word(item)
            if not word or word in normalised or _has_placeholder_token(word, ignore_prefix=True):
                continue
            normalised.append(word)
            if len(normalised) >= max_total:
                break
    elif isinstance(payload, str):
        word = _normalise_tag_word(payload)
        if word and not _has_placeholder_token(word, ignore_prefix=True):
            normalised.append(word)

    if extras_candidate:
        for word in _extract_extras(extras_candidate):
            if word and word not in normalised:
                normalised.append(word)

    slot_count = len(slots)
    if len(normalised) < slot_count:
        normalised.extend([""] * (slot_count - len(normalised)))
    return normalised[:max_total]


def _normalise_proposal(proposal: Any, parent_hint: str | None, top_score: float) -> Dict[str, Any] | None:
    if isinstance(proposal, dict):
        # Reject explicit proposals whenever a confident catalog match exists –
        # otherwise we would create duplicates for folders that already scored
        # above the automatic creation threshold.
        if top_score >= float(S.MIN_NEW_FOLDER_SCORE or 0):
            return None
        parent_raw = str(proposal.get("parent", parent_hint or "")).strip()
        ensured_parent = ensure_top_level_parent(parent_raw or parent_hint)
        top_levels = top_level_folder_names()
        parent = ensured_parent or (top_levels[0] if top_levels else "Projects")
        name = str(proposal.get("name", "")).strip()
        reason = str(proposal.get("reason", "")) or "automatischer Vorschlag"
        if name:
            full_path = "/".join(segment for segment in (parent, name) if segment).strip("/")
            return {
                "parent": parent,
                "name": name,
                "reason": reason,
                "full_path": full_path,
                "status": "pending",
                "score_hint": float(top_score),
            }
    return None


def _align_proposal_with_matches(
    proposal: Dict[str, Any],
    ranked: Sequence[Dict[str, Any]],
    category: Dict[str, Any] | None,
    parent_hint: str | None,
) -> Dict[str, Any] | None:
    """Ensure generated folder proposals remain consistent with known matches."""

    if not proposal:
        return None

    aligned = proposal.copy()
    ranked_paths = [
        str(item.get("name", "")).strip()
        for item in ranked
        if isinstance(item.get("name"), str) and str(item.get("name")).strip()
    ]
    preferred_parent = _category_parent_segment(category)
    if not preferred_parent and ranked_paths:
        preferred_parent = ensure_top_level_parent(ranked_paths[0])
    if not preferred_parent and parent_hint:
        preferred_parent = ensure_top_level_parent(parent_hint)

    name = aligned.get("name", "").strip()
    if preferred_parent and name:
        aligned["parent"] = preferred_parent
        aligned["full_path"] = "/".join(
            segment for segment in (preferred_parent, name) if segment
        ).strip("/")

    if ranked_paths:
        ranked_lower = {path.lower() for path in ranked_paths}
        full_path = str(aligned.get("full_path", "")).strip()
        if full_path and full_path.lower() in ranked_lower:
            return None

    return aligned


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
    model_name = resolve_classifier_model().strip()
    if not model_name:
        return _fallback_ranked(ranked), None, None, []

    num_ctx = await _resolve_context_window()
    catalog_limit = _catalog_line_limit(num_ctx)
    base_messages = build_classification_prompt(
        subject,
        sender,
        body,
        ranked,
        folders,
        parent_hint,
        body_snippet="",
        max_catalog_entries=catalog_limit,
    )
    overhead_chars = sum(len(item.get("content", "")) for item in base_messages)
    body_snippet = _truncate_body_for_context(body, num_ctx, overhead_chars)
    messages = build_classification_prompt(
        subject,
        sender,
        body,
        ranked,
        folders,
        parent_hint,
        body_snippet=body_snippet,
        max_catalog_entries=catalog_limit,
    )
    char_budget = _approx_prompt_char_budget(num_ctx)
    total_chars = sum(len(item.get("content", "")) for item in messages)
    if body_snippet and total_chars > char_budget and char_budget > 0:
        overflow = total_chars - char_budget
        if overflow > 0:
            adjusted_length = max(0, len(body_snippet) - overflow)
            if adjusted_length < len(body_snippet):
                body_snippet = body[:adjusted_length]
                messages = build_classification_prompt(
                    subject,
                    sender,
                    body,
                    ranked,
                    folders,
                    parent_hint,
                    body_snippet=body_snippet,
                    max_catalog_entries=catalog_limit,
                )
                total_chars = sum(len(item.get("content", "")) for item in messages)
    while total_chars > char_budget and char_budget > 0 and catalog_limit > 20:
        previous_limit = catalog_limit
        catalog_limit = max(20, catalog_limit - 10)
        if catalog_limit == previous_limit:
            break
        messages = build_classification_prompt(
            subject,
            sender,
            body,
            ranked,
            folders,
            parent_hint,
            body_snippet=body_snippet,
            max_catalog_entries=catalog_limit,
        )
        total_chars = sum(len(item.get("content", "")) for item in messages)
    if total_chars > char_budget and char_budget > 0:
        logger.debug(
            "Klassifikationsprompt überschreitet das Zielbudget (Budget %s, Länge %s)",
            char_budget,
            total_chars,
        )
    try:
        response = await _chat(messages, num_ctx=num_ctx)
    except Exception as exc:  # pragma: no cover - network interaction
        logger.warning("Ollama Klassifikation fehlgeschlagen: %s", exc)
        return _fallback_ranked(ranked), None, None, []

    content = response.get("message", {}).get("content")
    if not content:
        return _fallback_ranked(ranked), None, None, []

    parsed = _load_json_payload(content)
    if not isinstance(parsed, dict):
        parsed = _load_json_payload(response)
    if not isinstance(parsed, dict):
        preview_source = ""
        if isinstance(content, str):
            preview_source = content.strip()
        elif isinstance(response, dict):
            snippet = json.dumps(response, ensure_ascii=False)
            preview_source = snippet[:200]
        preview = preview_source.splitlines() if preview_source else []
        sample = preview[0][:200] if preview else preview_source
        logger.warning(
            "Konnte Ollama-Antwort nicht parsen (Vorschau: %s)", sample
        )
        return _fallback_ranked(ranked), None, None, []

    refined_ranked = _parse_ranked(parsed.get("ranked"), ranked)
    category = _parse_category(parsed.get("category"))
    extras_payload = parsed.get("extras")
    tags = _parse_tags(parsed.get("tags"), extras_payload)

    best_rating = 0.0
    for item in refined_ranked:
        rating_value = item.get("rating")
        if rating_value is None:
            rating_value = float(item.get("score", 0.0)) * 100.0
        try:
            rating = float(rating_value)
        except (TypeError, ValueError):
            rating = 0.0
        best_rating = max(best_rating, rating)

    if best_rating < float(S.MIN_MATCH_SCORE or 0):
        refined_ranked = []
        if category is None:
            category = {}
        category.setdefault("label", "unmatched")
        category["matched_folder"] = None
        category["confidence"] = 0.0
        category["rating"] = best_rating
        category["status"] = "unmatched"
        tags = []
        proposal = None
    else:
        proposal = _normalise_proposal(
            parsed.get("proposal"), parent_hint, best_rating / 100 if best_rating else 0.0
        )
        if proposal:
            proposal = _align_proposal_with_matches(proposal, refined_ranked, category, parent_hint)

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


def _beautify_segment(raw: str) -> str:
    cleaned = re.sub(r"[\\/]+", " ", raw)
    parts = [part for part in re.split(r"[-_\s]+", cleaned) if part]
    if not parts:
        return cleaned.strip()[:48] or "Allgemein"
    human = " ".join(part.capitalize() if len(part) > 1 else part.upper() for part in parts)
    return human.strip()[:48] or "Allgemein"


def _derive_leaf(subject: str, sender: str | None) -> Tuple[str, str | None]:
    slug = _subject_slug(subject)
    if slug:
        label = _beautify_segment(slug)
        summary = subject.strip().replace("\n", " ")[:40]
        return label, f'Betreff "{summary or subject.strip() or label}"'
    sender_slug = _sender_slug(sender)
    if sender_slug:
        return _beautify_segment(sender_slug), f"Absender {sender}"[:64]
    return "Allgemein", None


def _base_parent_segment(parent_hint: str | None) -> str:
    ensured = ensure_top_level_parent(parent_hint)
    if ensured:
        return ensured
    fallback = (S.IMAP_INBOX or "INBOX").strip() or "INBOX"
    fallback_ensured = ensure_top_level_parent(fallback)
    return fallback_ensured or fallback


def _category_parent_segment(category: Dict[str, Any] | None) -> str | None:
    if not category:
        return None
    matched = category.get("matched_folder")
    if isinstance(matched, str) and matched.strip():
        candidate = ensure_top_level_parent(matched)
        if candidate:
            return candidate
    label = category.get("label")
    if isinstance(label, str) and label.strip():
        configured = find_top_level_for_label(label)
        if configured:
            return configured
        return _beautify_segment(label)
    return None


async def propose_new_folder_if_needed(
    top_score: float,
    subject: str = "",
    sender: str | None = None,
    parent_hint: str | None = None,
    category: Dict[str, Any] | None = None,
) -> Dict[str, Any] | None:
    if top_score >= S.MIN_NEW_FOLDER_SCORE:
        return None

    base_parent = _base_parent_segment(parent_hint)
    category_parent = _category_parent_segment(category)
    sender_segment = _sender_slug(sender)
    sender_parent = _beautify_segment(sender_segment) if sender_segment else None

    parent_segments = [base_parent]
    reason_parts = ["geringe Übereinstimmung mit bekannten Ordnern"]

    if category_parent:
        parent_segments.append(category_parent)
        reason_parts.append(f"Überbegriff {category_parent}")
    elif sender_parent:
        parent_segments.append(sender_parent)
        reason_parts.append(f"Gruppierung nach Absender {sender_parent}")

    leaf, basis = _derive_leaf(subject, sender)
    if basis:
        reason_parts.append(f"neuer Themenordner aus {basis}")

    parent = "/".join(dict.fromkeys(segment.strip("/") for segment in parent_segments if segment)).strip("/")
    full_path = "/".join(segment for segment in (parent, leaf) if segment).strip("/")
    proposal_name = leaf
    reason = "; ".join(reason_parts)

    return {
        "parent": parent,
        "name": proposal_name,
        "reason": reason,
        "full_path": full_path,
        "status": "pending",
        "score_hint": float(top_score),
    }
