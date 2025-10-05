"""Helpers to load and expose the configurable LLM hierarchy."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

_CONFIG_PATH = Path(__file__).with_name("llm_config.json")


@dataclass(frozen=True)
class FolderChild:
    name: str
    description: str
    children: List["FolderChild"] = field(default_factory=list)


@dataclass(frozen=True)
class ContextTagGuideline:
    name: str
    description: str
    folder: str


@dataclass(frozen=True)
class FolderTemplate:
    name: str
    description: str
    children: List[FolderChild]
    tag_guidelines: List[ContextTagGuideline]


@dataclass(frozen=True)
class TagSlot:
    name: str
    aliases: List[str]
    description: str
    options: List[str]


def _load_raw_config() -> Dict[str, object]:
    if not _CONFIG_PATH.exists():
        raise FileNotFoundError(f"Missing configuration file: {_CONFIG_PATH}")
    with _CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def get_catalog_data() -> Dict[str, Any]:
    """Return a deep copy of the raw catalog configuration."""

    raw = _load_raw_config()
    return json.loads(json.dumps(raw))


def _write_catalog(data: Dict[str, Any]) -> None:
    with _CONFIG_PATH.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    get_folder_templates.cache_clear()
    get_tag_slots.cache_clear()
    get_context_tag_guidelines.cache_clear()


def update_catalog(folder_templates: List[Dict[str, Any]], tag_slots: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Persist a new catalog definition and refresh cached views."""

    payload: Dict[str, Any] = {
        "folder_templates": folder_templates,
        "tag_slots": tag_slots,
    }
    _write_catalog(payload)
    return payload


@lru_cache(maxsize=1)
def get_folder_templates() -> List[FolderTemplate]:
    raw = _load_raw_config().get("folder_templates", [])
    entries = raw if isinstance(raw, list) else []
    templates: List[FolderTemplate] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        description = str(entry.get("description") or "").strip()
        if not name:
            continue
        def _parse_children(payload: object) -> List[FolderChild]:
            parsed: List[FolderChild] = []
            if not isinstance(payload, list):
                return parsed
            for child in payload:
                if not isinstance(child, dict):
                    continue
                child_name = str(child.get("name") or "").strip()
                child_desc = str(child.get("description") or "").strip()
                if not child_name:
                    continue
                nested_raw = child.get("children")
                nested_children = _parse_children(nested_raw) if isinstance(nested_raw, list) else []
                parsed.append(
                    FolderChild(
                        name=child_name,
                        description=child_desc,
                        children=nested_children,
                    )
                )
            return parsed

        children = _parse_children(entry.get("children"))
        tag_guidelines: List[ContextTagGuideline] = []
        guidelines_raw = entry.get("tag_guidelines")
        if isinstance(guidelines_raw, list):
            for item in guidelines_raw:
                if not isinstance(item, dict):
                    continue
                tag_name = str(item.get("name") or "").strip()
                tag_description = str(item.get("description") or "").strip()
                if tag_name:
                    tag_guidelines.append(
                        ContextTagGuideline(name=tag_name, description=tag_description, folder=name)
                    )
        templates.append(
            FolderTemplate(
                name=name,
                description=description,
                children=children,
                tag_guidelines=tag_guidelines,
            )
        )
    return templates


@lru_cache(maxsize=1)
def get_tag_slots() -> List[TagSlot]:
    raw_slots = _load_raw_config().get("tag_slots", [])
    entries = raw_slots if isinstance(raw_slots, list) else []
    slots: List[TagSlot] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        description = str(entry.get("description") or "").strip()
        options_raw = entry.get("options")
        aliases_raw = entry.get("aliases")
        if not name:
            continue
        options = [str(item).strip() for item in options_raw or [] if str(item).strip()]
        aliases = [str(item).strip() for item in aliases_raw or [] if str(item).strip()]
        slots.append(TagSlot(name=name, aliases=aliases, description=description, options=options))
    return slots


@lru_cache(maxsize=1)
def get_context_tag_guidelines() -> List[ContextTagGuideline]:
    templates = get_folder_templates()
    guidelines: List[ContextTagGuideline] = []
    for template in templates:
        guidelines.extend(template.tag_guidelines)
    return guidelines


def folder_templates_summary() -> str:
    templates = get_folder_templates()
    if not templates:
        return "Keine Vorlagen definiert."
    lines: List[str] = []

    def _render_children(children: Sequence[FolderChild], indent: str = "  ") -> List[str]:
        rendered: List[str] = []
        for child in children:
            rendered.append(f"{indent}- {child.name}: {child.description or 'keine Beschreibung'}")
            if child.children:
                rendered.extend(_render_children(child.children, indent + "  "))
        return rendered

    for template in templates:
        lines.append(f"- {template.name}: {template.description or 'keine Beschreibung'}")
        if template.children:
            lines.extend(_render_children(template.children))
        if template.tag_guidelines:
            tags = "; ".join(
                f"{guideline.name} → {guideline.description}" for guideline in template.tag_guidelines
            )
            lines.append(f"  Kontext-Tags: {tags}")
    return "\n".join(lines)


def tag_slots_summary() -> str:
    slots = get_tag_slots()
    if not slots:
        return "Keine Tag-Slots definiert."
    lines = []
    for slot in slots:
        options = ", ".join(slot.options) if slot.options else "frei wählbar"
        lines.append(f"- {slot.name}: {slot.description or 'keine Beschreibung'} (Optionen: {options})")
    return "\n".join(lines)


def context_tag_summary() -> str:
    guidelines = get_context_tag_guidelines()
    if not guidelines:
        return "Keine Kontext-Tags definiert."
    lines = []
    for guideline in guidelines:
        lines.append(f"- {guideline.name} ({guideline.folder}): {guideline.description or 'keine Beschreibung'}")
    return "\n".join(lines)


def top_level_folder_names() -> List[str]:
    return [template.name for template in get_folder_templates()]


def _iter_child_paths(prefix: str, children: Sequence[FolderChild]) -> Iterable[str]:
    for child in children:
        path = f"{prefix}/{child.name}" if prefix else child.name
        yield path
        if child.children:
            yield from _iter_child_paths(path, child.children)


def folder_catalog_paths(limit: int | None = None) -> List[str]:
    paths: List[str] = []
    for template in get_folder_templates():
        paths.append(template.name)
        paths.extend(_iter_child_paths(template.name, template.children))
        if limit is not None and len(paths) >= limit:
            break
    deduped = list(dict.fromkeys(path for path in paths if path))
    if limit is not None:
        return deduped[:limit]
    return deduped


def tag_slot_count() -> int:
    slots = get_tag_slots()
    return max(len(slots), 3)


def max_tag_total() -> int:
    base = tag_slot_count()
    extras = len(get_context_tag_guidelines())
    return max(base + extras, base)


def find_top_level_for_label(label: str | None) -> str | None:
    if not label:
        return None
    needle = label.strip().lower()
    if not needle:
        return None
    for template in get_folder_templates():
        if template.name.lower() == needle:
            return template.name
        for child in template.children:
            if child.name.lower() == needle:
                return template.name
    return None


def ensure_top_level_parent(path: str | None) -> str | None:
    top_levels = top_level_folder_names()
    if not top_levels:
        return path
    if not path:
        return top_levels[0]
    first_segment = path.split("/")[0].strip()
    if not first_segment:
        return top_levels[0]
    for candidate in top_levels:
        if candidate.lower() == first_segment.lower():
            return candidate
    for candidate in top_levels:
        if first_segment.lower() in candidate.lower() or candidate.lower() in first_segment.lower():
            return candidate
    return first_segment


def slot_lookup_keys(slots: Sequence[TagSlot]) -> List[List[str]]:
    lookup: List[List[str]] = []
    for slot in slots:
        keys = [slot.name]
        keys.extend(alias for alias in slot.aliases if alias)
        normalised = []
        for key in keys:
            lowered = key.strip()
            if lowered and lowered not in normalised:
                normalised.append(lowered)
        lookup.append(normalised)
    return lookup


def iter_slot_options(slots: Sequence[TagSlot]) -> Iterable[str]:
    for slot in slots:
        for option in slot.options:
            yield option


def tag_slot_options_map() -> Dict[str, List[str]]:
    return {slot.name: list(slot.options) for slot in get_tag_slots()}
