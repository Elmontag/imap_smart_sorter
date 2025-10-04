"""Helpers to load and expose the configurable LLM hierarchy."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

_CONFIG_PATH = Path(__file__).with_name("llm_config.json")


@dataclass(frozen=True)
class FolderChild:
    name: str
    description: str


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
        children: List[FolderChild] = []
        children_raw = entry.get("children")
        if isinstance(children_raw, list):
            for child in children_raw:
                if not isinstance(child, dict):
                    continue
                child_name = str(child.get("name") or "").strip()
                child_desc = str(child.get("description") or "").strip()
                if child_name:
                    children.append(FolderChild(name=child_name, description=child_desc))
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
    for template in templates:
        child_names = ", ".join(child.name for child in template.children)
        lines.append(f"- {template.name}: {template.description or 'keine Beschreibung'}")
        if child_names:
            lines.append(f"  Unterordner: {child_names}")
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
