"""FastAPI application for the IMAP Smart Sorter backend."""

from __future__ import annotations

import asyncio
import logging

from datetime import datetime, date
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Sequence

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket
from fastapi import WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from uvicorn.protocols.utils import ClientDisconnected

from configuration import (
    get_catalog_data,
    get_context_tag_guidelines,
    get_folder_templates,
    get_tag_slots,
    update_catalog,
)
from database import (
    filter_activity_summary,
    find_suggestion_by_uid,
    get_monitored_folders,
    init_db,
    list_suggestions,
    mark_failed,
    mark_moved,
    record_decision,
    record_dry_run,
    set_analysis_module,
    set_classifier_model,
    set_mailbox_tags,
    set_mode,
    set_monitored_folders,
    suggestion_status_counts,
    update_proposal,
)
from rescan_control import (
    RescanBusyError,
    RescanCancelledError,
    RescanStatus,
    controller as rescan_controller,
)
from mailbox import ensure_folder_path, folder_exists, list_folders, move_message
from scan_control import ScanStatus, controller as scan_controller
from models import Suggestion
from pending import PendingMail, PendingOverview, load_pending_overview
from tags import TagSuggestion, load_tag_suggestions
from ollama_service import OllamaStatus, ensure_ollama_ready, get_status, status_as_dict
from keyword_filters import get_filter_config as load_keyword_filter_config
from keyword_filters import get_filter_rules, update_filter_config as store_keyword_filters
from settings import S
from runtime_settings import (
    analysis_module_uses_llm,
    resolve_analysis_module,
    resolve_classifier_model,
    resolve_mailbox_tags,
    resolve_move_mode,
)


class MoveMode(str, Enum):
    DRY_RUN = "DRY_RUN"
    CONFIRM = "CONFIRM"
    AUTO = "AUTO"


class AnalysisModule(str, Enum):
    STATIC = "STATIC"
    HYBRID = "HYBRID"
    LLM_PURE = "LLM_PURE"


class ModeResponse(BaseModel):
    mode: MoveMode


class ModeUpdate(BaseModel):
    mode: MoveMode


class MoveRequest(BaseModel):
    message_uid: str = Field(..., min_length=1)
    target_folder: str = Field(..., min_length=1)
    dry_run: bool = False


class DecisionRequest(MoveRequest):
    decision: str = Field("accept", pattern=r"^(accept|reject)$")


class BulkMoveRequest(BaseModel):
    items: List[MoveRequest] = Field(default_factory=list)


class KeywordFilterMatchModel(BaseModel):
    mode: Literal["all", "any"] = Field("all", pattern=r"^(all|any)$")
    fields: List[Literal["subject", "sender", "body"]] = Field(
        default_factory=lambda: ["subject", "sender", "body"]
    )
    terms: List[str] = Field(default_factory=list)


class KeywordFilterDateModel(BaseModel):
    after: Optional[date] = None
    before: Optional[date] = None
    include_future: bool = False


class KeywordFilterRuleModel(BaseModel):
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    enabled: bool = True
    target_folder: str = Field(..., min_length=1)
    tags: List[str] = Field(default_factory=list)
    match: KeywordFilterMatchModel = Field(default_factory=KeywordFilterMatchModel)
    date: Optional[KeywordFilterDateModel] = None
    tag_future_dates: bool = False


class KeywordFilterConfigResponse(BaseModel):
    rules: List[KeywordFilterRuleModel]


class CatalogImportRequest(BaseModel):
    exclude_defaults: List[str] = Field(default_factory=list)


class KeywordFilterActivityRule(BaseModel):
    name: str
    target_folder: str
    count: int
    last_match: Optional[datetime] = None
    tags: List[str] = Field(default_factory=list)


class KeywordFilterRecentEntry(BaseModel):
    message_uid: str
    rule_name: str
    src_folder: Optional[str] = None
    target_folder: str
    applied_tags: List[str] = Field(default_factory=list)
    matched_terms: List[str] = Field(default_factory=list)
    matched_at: datetime
    message_date: Optional[datetime] = None


class KeywordFilterActivityResponse(BaseModel):
    total_hits: int
    hits_last_24h: int
    window_days: int
    rules: List[KeywordFilterActivityRule]
    recent: List[KeywordFilterRecentEntry]


def _clean_terms(values: Sequence[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for value in values:
        cleaned = str(value).strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        ordered.append(cleaned)
    return ordered


def _parse_datetime(value: str | None) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _keyword_config_response() -> KeywordFilterConfigResponse:
    raw = load_keyword_filter_config()
    entries = raw.get("rules", [])
    rules: List[KeywordFilterRuleModel] = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or "").strip()
            target_folder = str(entry.get("target_folder") or "").strip()
            if not name or not target_folder:
                continue
            description_raw = entry.get("description")
            description = str(description_raw).strip() if description_raw else None
            try:
                match_model = KeywordFilterMatchModel.model_validate(entry.get("match") or {})
            except Exception:
                match_model = KeywordFilterMatchModel()
            match_model.terms = _clean_terms(match_model.terms)
            date_model: Optional[KeywordFilterDateModel] = None
            if isinstance(entry.get("date"), dict):
                try:
                    date_model = KeywordFilterDateModel.model_validate(entry.get("date"))
                except Exception:
                    date_model = None
            rule = KeywordFilterRuleModel(
                name=name,
                description=description,
                enabled=bool(entry.get("enabled", True)),
                target_folder=target_folder,
                tags=_clean_terms(entry.get("tags") or []),
                match=match_model,
                date=date_model,
                tag_future_dates=bool(entry.get("tag_future_dates")),
            )
            rules.append(rule)
    return KeywordFilterConfigResponse(rules=rules)


def _serialise_filter_rule(rule: KeywordFilterRuleModel) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "name": rule.name.strip(),
        "description": (rule.description.strip() if isinstance(rule.description, str) and rule.description.strip() else None),
        "enabled": bool(rule.enabled),
        "target_folder": rule.target_folder.strip(),
        "tags": _clean_terms(rule.tags),
        "match": {
            "mode": rule.match.mode,
            "fields": rule.match.fields or ["subject", "sender", "body"],
            "terms": _clean_terms(rule.match.terms),
        },
    }
    if rule.date and (rule.date.after or rule.date.before or rule.date.include_future):
        date_payload: Dict[str, Any] = {}
        if rule.date.after:
            date_payload["after"] = rule.date.after.isoformat()
        if rule.date.before:
            date_payload["before"] = rule.date.before.isoformat()
        if rule.date.include_future:
            date_payload["include_future"] = True
        payload["date"] = date_payload
    payload["tag_future_dates"] = bool(rule.tag_future_dates)
    return payload


def _keyword_activity_response() -> KeywordFilterActivityResponse:
    summary = filter_activity_summary()
    rule_tags = {rule.name: list(rule.tags) for rule in get_filter_rules()}

    rules = [
        KeywordFilterActivityRule(
            name=str(entry.get("name")),
            target_folder=str(entry.get("target_folder")),
            count=int(entry.get("count", 0)),
            last_match=_parse_datetime(entry.get("last_match")),
            tags=rule_tags.get(str(entry.get("name")), []),
        )
        for entry in summary.get("rules", [])
        if isinstance(entry, dict)
    ]

    recent = [
        KeywordFilterRecentEntry(
            message_uid=str(entry.get("message_uid")),
            rule_name=str(entry.get("rule_name")),
            src_folder=entry.get("src_folder"),
            target_folder=str(entry.get("target_folder")),
            applied_tags=[str(tag) for tag in entry.get("applied_tags", []) if str(tag).strip()],
            matched_terms=[str(term) for term in entry.get("matched_terms", []) if str(term).strip()],
            matched_at=_parse_datetime(entry.get("matched_at")) or datetime.utcnow(),
            message_date=_parse_datetime(entry.get("message_date")),
        )
        for entry in summary.get("recent", [])
        if isinstance(entry, dict)
    ]

    return KeywordFilterActivityResponse(
        total_hits=int(summary.get("total_hits", 0)),
        hits_last_24h=int(summary.get("hits_last_24h", 0)),
        window_days=int(summary.get("window_days", 0)),
        rules=rules,
        recent=recent,
    )


class SuggestionsResponse(BaseModel):
    suggestions: List[Suggestion]
    open_count: int
    decided_count: int
    error_count: int
    total_count: int


class FolderSelectionResponse(BaseModel):
    available: List[str]
    selected: List[str]


class FolderSelectionUpdate(BaseModel):
    folders: List[str] = Field(default_factory=list)


class FolderCreateRequest(BaseModel):
    path: str


class FolderCreateResponse(BaseModel):
    created: str
    existed: bool


class ScanStatusResponse(BaseModel):
    active: bool
    folders: List[str]
    poll_interval: float
    last_started_at: datetime | None = None
    last_finished_at: datetime | None = None
    last_error: str | None = None
    last_result_count: int | None = None
    rescan_active: bool = False
    rescan_folders: List[str] = Field(default_factory=list)
    rescan_started_at: datetime | None = None
    rescan_finished_at: datetime | None = None
    rescan_error: str | None = None
    rescan_result_count: int | None = None
    rescan_cancelled: bool = False

    @classmethod
    def from_status(
        cls,
        status: ScanStatus,
        *,
        rescan_status: RescanStatus | None = None,
    ) -> "ScanStatusResponse":
        rescan = rescan_status or RescanStatus()
        return cls(
            active=status.active,
            folders=list(status.folders),
            poll_interval=float(status.poll_interval),
            last_started_at=status.last_started_at,
            last_finished_at=status.last_finished_at,
            last_error=status.last_error,
            last_result_count=status.last_result_count,
            rescan_active=rescan.active,
            rescan_folders=list(rescan.folders),
            rescan_started_at=rescan.started_at,
            rescan_finished_at=rescan.finished_at,
            rescan_error=rescan.last_error,
            rescan_result_count=rescan.last_result_count,
            rescan_cancelled=rescan.cancelled,
        )


class ScanStartRequest(BaseModel):
    folders: List[str] | None = Field(default=None)


class ScanStartResponse(BaseModel):
    started: bool
    status: ScanStatusResponse


class ScanStopResponse(BaseModel):
    stopped: bool
    status: ScanStatusResponse


class ProposalDecisionRequest(BaseModel):
    message_uid: str = Field(..., min_length=1)
    accept: bool


class OllamaModelStatusResponse(BaseModel):
    name: str
    normalized_name: str
    purpose: str
    available: bool
    pulled: bool
    digest: str | None = None
    size: int | None = None
    message: str | None = None


class OllamaStatusResponse(BaseModel):
    host: str
    reachable: bool
    message: str | None = None
    last_checked: datetime | None = None
    models: List[OllamaModelStatusResponse] = Field(default_factory=list)


class ConfigResponse(BaseModel):
    dev_mode: bool
    pending_list_limit: int
    mode: MoveMode
    analysis_module: AnalysisModule
    classifier_model: str
    protected_tag: str | None = None
    processed_tag: str | None = None
    ai_tag_prefix: str | None = None
    ollama: OllamaStatusResponse | None = None
    folder_templates: List["FolderTemplateConfig"] = Field(default_factory=list)
    tag_slots: List["TagSlotConfig"] = Field(default_factory=list)
    context_tags: List["ContextTagConfig"] = Field(default_factory=list)


class ConfigUpdateRequest(BaseModel):
    mode: Optional[MoveMode] = None
    analysis_module: Optional[AnalysisModule] = None
    classifier_model: Optional[str] = Field(default=None, min_length=1)
    protected_tag: Optional[str] = None
    processed_tag: Optional[str] = None
    ai_tag_prefix: Optional[str] = None


class FolderChildConfig(BaseModel):
    name: str = Field(..., min_length=1)
    description: str | None = None
    children: List["FolderChildConfig"] = Field(default_factory=list)
    tag_guidelines: List["TagGuidelineConfig"] = Field(default_factory=list)


class TagGuidelineConfig(BaseModel):
    name: str = Field(..., min_length=1)
    description: str | None = None


class FolderTemplateConfig(BaseModel):
    name: str = Field(..., min_length=1)
    description: str | None = None
    children: List[FolderChildConfig] = Field(default_factory=list)
    tag_guidelines: List[TagGuidelineConfig] = Field(default_factory=list)


class TagSlotConfig(BaseModel):
    name: str = Field(..., min_length=1)
    description: str | None = None
    options: List[str] = Field(default_factory=list)
    aliases: List[str] = Field(default_factory=list)


class ContextTagConfig(BaseModel):
    name: str
    description: str | None = None
    folder: str


ConfigResponse.model_rebuild()


class CatalogResponse(BaseModel):
    folder_templates: List[FolderTemplateConfig] = Field(default_factory=list)
    tag_slots: List[TagSlotConfig] = Field(default_factory=list)


class CatalogUpdateRequest(CatalogResponse):
    pass


class CatalogSyncResponse(CatalogResponse):
    imported_folders: List[str] = Field(default_factory=list)
    created_folders: List[str] = Field(default_factory=list)


FolderChildConfig.model_rebuild()
FolderTemplateConfig.model_rebuild()
CatalogResponse.model_rebuild()
CatalogSyncResponse.model_rebuild()


def _child_to_config(child: Any) -> FolderChildConfig:
    return FolderChildConfig(
        name=str(getattr(child, "name", "")).strip(),
        description=(getattr(child, "description", None) or None),
        children=[_child_to_config(grand) for grand in getattr(child, "children", []) or []],
        tag_guidelines=[
            TagGuidelineConfig(
                name=str(getattr(guideline, "name", "")).strip(),
                description=(getattr(guideline, "description", None) or None),
            )
            for guideline in getattr(child, "tag_guidelines", []) or []
        ],
    )


def _template_to_config(template: Any) -> FolderTemplateConfig:
    return FolderTemplateConfig(
        name=str(getattr(template, "name", "")).strip(),
        description=(getattr(template, "description", None) or None),
        children=[_child_to_config(child) for child in getattr(template, "children", []) or []],
        tag_guidelines=[
            TagGuidelineConfig(
                name=str(getattr(guideline, "name", "")).strip(),
                description=(getattr(guideline, "description", None) or None),
            )
            for guideline in getattr(template, "tag_guidelines", []) or []
        ],
    )


def _serialise_child(child: FolderChildConfig) -> Dict[str, Any]:
    description = (child.description or "").strip()
    return {
        "name": child.name.strip(),
        "description": description,
        "children": [_serialise_child(grand) for grand in child.children],
        "tag_guidelines": [
            {
                "name": guideline.name.strip(),
                "description": (guideline.description or "").strip(),
            }
            for guideline in child.tag_guidelines
        ],
    }


def _serialise_template(template: FolderTemplateConfig) -> Dict[str, Any]:
    return {
        "name": template.name.strip(),
        "description": (template.description or "").strip(),
        "children": [_serialise_child(child) for child in template.children],
        "tag_guidelines": [
            {
                "name": guideline.name.strip(),
                "description": (guideline.description or "").strip(),
            }
            for guideline in template.tag_guidelines
        ],
    }


def _serialise_tag_slot(slot: TagSlotConfig) -> Dict[str, Any]:
    options = [option.strip() for option in slot.options if option.strip()]
    aliases = [alias.strip() for alias in slot.aliases if alias.strip()]
    return {
        "name": slot.name.strip(),
        "description": (slot.description or "").strip(),
        "options": options,
        "aliases": aliases,
    }


def _paths_to_template_payloads(paths: Sequence[str]) -> List[Dict[str, Any]]:
    tree: Dict[str, Dict[str, Any]] = {}
    for raw in paths:
        if not isinstance(raw, str):
            continue
        normalized = raw.strip().strip("/")
        if not normalized:
            continue
        segments = [segment.strip() for segment in normalized.split("/") if segment.strip()]
        if not segments:
            continue
        node = tree
        for segment in segments:
            node = node.setdefault(segment, {})

    def _build(name: str, children: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "name": name,
            "description": "",
            "children": [_build(child_name, child_children) for child_name, child_children in sorted(children.items())],
            "tag_guidelines": [],
        }

    return [_build(name, children) for name, children in sorted(tree.items())]


def _collect_template_paths(templates: Sequence[FolderTemplateConfig]) -> List[str]:
    seen: Dict[str, None] = {}
    paths: List[str] = []

    def _walk(node: FolderChildConfig | FolderTemplateConfig, prefix: str) -> None:
        name = node.name.strip()
        if not name:
            return
        current = f"{prefix}/{name}" if prefix else name
        if current not in seen:
            seen[current] = None
            paths.append(current)
        for child in getattr(node, "children", []) or []:
            _walk(child, current)

    for template in templates:
        _walk(template, "")
    return paths


def _catalog_response() -> CatalogResponse:
    templates = [_template_to_config(template) for template in get_folder_templates()]
    slots = [
        TagSlotConfig(
            name=slot.name,
            description=slot.description or None,
            options=list(slot.options),
            aliases=list(slot.aliases),
        )
        for slot in get_tag_slots()
    ]
    return CatalogResponse(folder_templates=templates, tag_slots=slots)


class TagExampleResponse(BaseModel):
    message_uid: str
    subject: str
    from_addr: str | None = None
    folder: str | None = None
    date: str | None = None


class TagSuggestionResponse(BaseModel):
    tag: str
    occurrences: int
    last_seen: datetime | None = None
    examples: List[TagExampleResponse] = Field(default_factory=list)

    @classmethod
    def from_domain(cls, suggestion: TagSuggestion) -> "TagSuggestionResponse":
        return cls(
            tag=suggestion.tag,
            occurrences=suggestion.occurrences,
            last_seen=suggestion.last_seen,
            examples=[TagExampleResponse(**example) for example in suggestion.serialisable_examples()],
        )


class PendingMailResponse(BaseModel):
    message_uid: str
    folder: str
    subject: str
    from_addr: str | None = None
    date: str | None = None

    @classmethod
    def from_domain(cls, item: PendingMail) -> "PendingMailResponse":
        return cls(
            message_uid=item.message_uid,
            folder=item.folder,
            subject=item.subject,
            from_addr=item.from_addr,
            date=item.date,
        )


class PendingOverviewResponse(BaseModel):
    total_messages: int
    processed_count: int
    pending_count: int
    pending_ratio: float
    pending: List[PendingMailResponse]
    displayed_pending: int
    list_limit: int
    limit_active: bool

    @classmethod
    def from_domain(cls, overview: PendingOverview) -> "PendingOverviewResponse":
        return cls(
            total_messages=overview.total_messages,
            processed_count=overview.processed_count,
            pending_count=overview.pending_count,
            pending_ratio=overview.pending_ratio,
            pending=[PendingMailResponse.from_domain(item) for item in overview.pending],
            displayed_pending=overview.displayed_pending,
            list_limit=overview.list_limit,
            limit_active=overview.limit_active,
        )


app = FastAPI(title="IMAP Smart Sorter")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

logger = logging.getLogger(__name__)


@app.on_event("startup")
async def _startup() -> None:
    init_db()
    if analysis_module_uses_llm():
        await ensure_ollama_ready()


@app.get("/healthz")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


def _resolve_mode() -> MoveMode:
    stored = resolve_move_mode()
    try:
        return MoveMode(stored)
    except ValueError as exc:  # pragma: no cover - defensive guard
        raise HTTPException(500, f"invalid persisted mode: {stored}") from exc


@app.get("/api/mode", response_model=ModeResponse)
def api_get_mode() -> ModeResponse:
    return ModeResponse(mode=_resolve_mode())


@app.post("/api/mode", response_model=ModeResponse)
def api_set_mode(payload: ModeUpdate) -> ModeResponse:
    set_mode(payload.mode.value)
    return ModeResponse(mode=payload.mode)


@app.get("/api/folders", response_model=FolderSelectionResponse)
def api_folders() -> FolderSelectionResponse:
    available = list_folders()
    selected = get_monitored_folders()
    if not selected and S.IMAP_INBOX in available:
        selected = [S.IMAP_INBOX]
    return FolderSelectionResponse(available=available, selected=selected)


@app.post("/api/folders/selection", response_model=FolderSelectionResponse)
def api_update_folders(payload: FolderSelectionUpdate) -> FolderSelectionResponse:
    set_monitored_folders(payload.folders)
    available = list_folders()
    selected = get_monitored_folders()
    return FolderSelectionResponse(available=available, selected=selected)


@app.post("/api/folders/create", response_model=FolderCreateResponse)
async def api_create_folder(payload: FolderCreateRequest) -> FolderCreateResponse:
    path = (payload.path or "").strip().strip("/")
    if not path:
        raise HTTPException(400, "folder path must not be empty")
    if folder_exists(path):
        return FolderCreateResponse(created=path, existed=True)
    try:
        created = ensure_folder_path(path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # pragma: no cover - network interaction
        logger.error("Failed to create folder %s: %s", path, exc)
        raise HTTPException(500, f"could not create folder: {exc}") from exc
    return FolderCreateResponse(created=created, existed=False)


async def _config_response() -> ConfigResponse:
    module_value = resolve_analysis_module()
    if analysis_module_uses_llm(module_value):
        status = await get_status(force_refresh=False)
    else:
        status = OllamaStatus(host=S.OLLAMA_HOST, reachable=False, models=[], message="LLM deaktiviert (Statisches Modul)")
    catalog = _catalog_response()
    protected_tag, processed_tag, ai_tag_prefix = resolve_mailbox_tags()
    context_tags = [
        ContextTagConfig(name=guideline.name, description=guideline.description or None, folder=guideline.folder)
        for guideline in get_context_tag_guidelines()
    ]
    return ConfigResponse(
        dev_mode=bool(S.DEV_MODE),
        pending_list_limit=max(int(getattr(S, "PENDING_LIST_LIMIT", 0)), 0),
        mode=_resolve_mode(),
        analysis_module=AnalysisModule(module_value),
        classifier_model=resolve_classifier_model(),
        protected_tag=protected_tag,
        processed_tag=processed_tag,
        ai_tag_prefix=ai_tag_prefix,
        ollama=OllamaStatusResponse.model_validate(status_as_dict(status)),
        folder_templates=catalog.folder_templates,
        tag_slots=catalog.tag_slots,
        context_tags=context_tags,
    )


@app.get("/api/config", response_model=ConfigResponse)
async def api_config() -> ConfigResponse:
    return await _config_response()


@app.put("/api/config", response_model=ConfigResponse)
async def api_update_config(payload: ConfigUpdateRequest) -> ConfigResponse:
    updates = payload.model_dump(exclude_unset=True)
    if "mode" in updates:
        if payload.mode is None:
            raise HTTPException(400, "mode must not be null")
        set_mode(payload.mode.value)
    if "analysis_module" in updates:
        if payload.analysis_module is None:
            raise HTTPException(400, "analysis_module must not be null")
        set_analysis_module(payload.analysis_module.value)
    if "classifier_model" in updates:
        model = (payload.classifier_model or "").strip()
        if not model:
            raise HTTPException(400, "classifier_model must not be empty")
        set_classifier_model(model)
    if {"protected_tag", "processed_tag", "ai_tag_prefix"} & updates.keys():
        set_mailbox_tags(
            updates.get("protected_tag"),
            updates.get("processed_tag"),
            updates.get("ai_tag_prefix"),
        )
    return await _config_response()


@app.get("/api/catalog", response_model=CatalogResponse)
def api_catalog_definition() -> CatalogResponse:
    return _catalog_response()


@app.put("/api/catalog", response_model=CatalogResponse)
def api_update_catalog_definition(payload: CatalogUpdateRequest) -> CatalogResponse:
    templates = [_serialise_template(template) for template in payload.folder_templates]
    slots = [_serialise_tag_slot(slot) for slot in payload.tag_slots]
    update_catalog(templates, slots)
    return _catalog_response()


def _segments_for_path(path: str) -> list[str]:
    if "/" in path:
        delimiter = "/"
    elif "." in path:
        delimiter = "."
    else:
        return [path]
    return [segment for segment in path.split(delimiter) if segment.strip()]


def _filter_default_folders(folders: list[str], exclude_defaults: Sequence[str]) -> list[str]:
    if not exclude_defaults:
        return folders
    excluded = {value.strip().casefold() for value in exclude_defaults if value and str(value).strip()}
    if not excluded:
        return folders
    filtered: list[str] = []
    for folder in folders:
        tail_candidates = _segments_for_path(folder)
        tail = tail_candidates[-1].casefold() if tail_candidates else folder.casefold()
        if tail in excluded:
            continue
        filtered.append(folder)
    return filtered


@app.post("/api/catalog/import-mailbox", response_model=CatalogSyncResponse)
def api_catalog_import_mailbox(payload: CatalogImportRequest = Body(default_factory=CatalogImportRequest)) -> CatalogSyncResponse:
    folders = [str(folder).strip() for folder in list_folders() if str(folder).strip()]
    if not folders:
        raise HTTPException(404, "Es wurden keine IMAP-Ordner gefunden.")
    folders = _filter_default_folders(folders, payload.exclude_defaults)
    if not folders:
        raise HTTPException(400, "Keine Ordner zum Import nach Anwendung der Ausschlussliste gefunden.")
    templates_payload = _paths_to_template_payloads(folders)
    current = get_catalog_data()
    tag_slots = current.get("tag_slots", []) if isinstance(current, dict) else []
    if not isinstance(tag_slots, list):
        tag_slots = []
    update_catalog(templates_payload, tag_slots)
    catalog = _catalog_response()
    imported = list(dict.fromkeys(folders))
    return CatalogSyncResponse(
        folder_templates=catalog.folder_templates,
        tag_slots=catalog.tag_slots,
        imported_folders=imported,
        created_folders=[],
    )


@app.post("/api/catalog/export-mailbox", response_model=CatalogSyncResponse)
def api_catalog_export_mailbox() -> CatalogSyncResponse:
    catalog = _catalog_response()
    paths = _collect_template_paths(catalog.folder_templates)
    created: List[str] = []
    for path in paths:
        try:
            created_path = ensure_folder_path(path)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # pragma: no cover - network interaction
            logger.error("Failed to mirror catalog folder %s: %s", path, exc)
            raise HTTPException(500, f"could not create folder: {exc}") from exc
        created.append(created_path)
    unique_created = list(dict.fromkeys(created))
    return CatalogSyncResponse(
        folder_templates=catalog.folder_templates,
        tag_slots=catalog.tag_slots,
        imported_folders=[],
        created_folders=unique_created,
    )


@app.get("/api/filters", response_model=KeywordFilterConfigResponse)
def api_keyword_filters() -> KeywordFilterConfigResponse:
    return _keyword_config_response()


@app.put("/api/filters", response_model=KeywordFilterConfigResponse)
def api_update_keyword_filters(payload: KeywordFilterConfigResponse) -> KeywordFilterConfigResponse:
    rules = [_serialise_filter_rule(rule) for rule in payload.rules]
    store_keyword_filters(rules)
    return _keyword_config_response()


@app.get("/api/filters/activity", response_model=KeywordFilterActivityResponse)
def api_keyword_filter_activity() -> KeywordFilterActivityResponse:
    return _keyword_activity_response()


@app.get("/api/suggestions", response_model=SuggestionsResponse)
def api_suggestions(include: str = Query("open", pattern=r"^(open|all)$")) -> SuggestionsResponse:
    include_all = include == "all"
    counts = suggestion_status_counts()
    suggestions = list_suggestions(include_all)
    return SuggestionsResponse(
        suggestions=suggestions,
        open_count=counts.get("open", 0),
        decided_count=counts.get("decided", 0),
        error_count=counts.get("error", 0),
        total_count=counts.get("total", 0),
    )


@app.get("/api/ollama", response_model=OllamaStatusResponse)
async def api_ollama_status() -> OllamaStatusResponse:
    module_value = resolve_analysis_module()
    if analysis_module_uses_llm(module_value):
        status = await get_status(force_refresh=True)
    else:
        status = OllamaStatus(host=S.OLLAMA_HOST, reachable=False, models=[], message="LLM deaktiviert (Statisches Modul)")
    return OllamaStatusResponse.model_validate(status_as_dict(status))


async def _pending_overview() -> PendingOverviewResponse:
    overview = await load_pending_overview(get_monitored_folders())
    return PendingOverviewResponse.from_domain(overview)


@app.get("/api/pending", response_model=PendingOverviewResponse)
async def api_pending() -> PendingOverviewResponse:
    return await _pending_overview()


@app.get("/api/tags", response_model=List[TagSuggestionResponse])
def api_tags() -> List[TagSuggestionResponse]:
    suggestions = load_tag_suggestions()
    return [TagSuggestionResponse.from_domain(item) for item in suggestions]


def _ensure_suggestion(uid: str) -> Suggestion:
    suggestion = find_suggestion_by_uid(uid)
    if not suggestion:
        raise HTTPException(404, "suggestion not found")
    return suggestion


@app.post("/api/decide")
def api_decide(payload: DecisionRequest) -> Dict[str, Any]:
    suggestion = _ensure_suggestion(payload.message_uid)
    updated = record_decision(payload.message_uid, payload.decision)

    current_mode = _resolve_mode()
    if payload.decision == "accept" and current_mode == MoveMode.CONFIRM:
        move_payload = MoveRequest(
            message_uid=payload.message_uid,
            target_folder=payload.target_folder,
            dry_run=payload.dry_run,
        )
        return api_move(move_payload)
    payload_suggestion = updated.dict() if isinstance(updated, Suggestion) else suggestion.dict()
    return {"ok": True, "suggestion": payload_suggestion}


def _perform_move(uid: str, target: str, src_folder: str | None) -> None:
    try:
        move_message(uid, target, src_folder=src_folder)
    except Exception as exc:
        mark_failed(uid, str(exc))
        raise HTTPException(500, f"move failed: {exc}") from exc
    mark_moved(uid)


@app.post("/api/move")
def api_move(payload: MoveRequest) -> Dict[str, Any]:
    suggestion = _ensure_suggestion(payload.message_uid)

    dry_run = payload.dry_run or _resolve_mode() == MoveMode.DRY_RUN
    if dry_run:
        exists = folder_exists(payload.target_folder)
        record_dry_run(payload.message_uid, {"folder_exists": exists})
        return {"ok": exists, "dry_run": True, "checks": {"folder_exists": exists}}

    _perform_move(payload.message_uid, payload.target_folder, suggestion.src_folder)
    return {"ok": True, "dry_run": False}


@app.post("/api/proposal")
def api_proposal(payload: ProposalDecisionRequest) -> Dict[str, Any]:
    suggestion = _ensure_suggestion(payload.message_uid)
    if not suggestion.proposal:
        raise HTTPException(400, "no proposal available")

    proposal = dict(suggestion.proposal)
    proposal["status"] = "accepted" if payload.accept else "rejected"

    if payload.accept:
        full_path = proposal.get("full_path")
        if not full_path and proposal.get("parent") and proposal.get("name"):
            full_path = f"{proposal['parent']}/{proposal['name']}"
        if not full_path:
            raise HTTPException(400, "invalid proposal data")
        try:
            created = ensure_folder_path(full_path)
            proposal["full_path"] = created
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # pragma: no cover - network interaction
            logger.error("Failed to create folder for proposal %s: %s", full_path, exc)
            raise HTTPException(500, f"could not create folder: {exc}") from exc

    updated = update_proposal(payload.message_uid, proposal)
    result = updated.proposal if updated else proposal
    return {"ok": True, "proposal": result}


@app.post("/api/move/bulk")
def api_move_bulk(payload: BulkMoveRequest) -> Dict[str, List[Dict[str, Any]]]:
    results = [api_move(item) for item in payload.items]
    return {"results": results}


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_json({"type": "hello", "msg": "connected"})

    try:
        while True:
            try:
                snapshot = await _pending_overview()
                await ws.send_json({"type": "pending_overview", "payload": snapshot.dict()})
            except (WebSocketDisconnect, ClientDisconnected):
                logger.debug("WebSocket client disconnected during stream")
                break
            except Exception as exc:  # pragma: no cover - network/IMAP interaction
                logger.warning("Failed to stream pending overview: %s", exc)
                try:
                    await ws.send_json({"type": "pending_error", "error": str(exc)})
                except (WebSocketDisconnect, ClientDisconnected):
                    logger.debug("WebSocket client disconnected while reporting error")
                    break
            await asyncio.sleep(5)
    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected")


@app.post("/api/rescan")
async def api_rescan(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    folders = payload.get("folders")
    if folders is not None and not isinstance(folders, list):
        raise HTTPException(400, "folders must be a list of folder names")
    target_folders = folders if folders is not None else get_monitored_folders()
    try:
        count = await rescan_controller.run(target_folders)
    except RescanBusyError as exc:
        raise HTTPException(409, str(exc)) from exc
    except RescanCancelledError:
        return {"ok": False, "cancelled": True, "new_suggestions": 0}
    return {"ok": True, "new_suggestions": count}


@app.get("/api/scan/status", response_model=ScanStatusResponse)
async def api_scan_status() -> ScanStatusResponse:
    return ScanStatusResponse.from_status(scan_controller.status, rescan_status=rescan_controller.status)


@app.post("/api/scan/start", response_model=ScanStartResponse)
async def api_scan_start(payload: ScanStartRequest | None = Body(default=None)) -> ScanStartResponse:
    folders = payload.folders if payload else None
    started = await scan_controller.start(folders)
    return ScanStartResponse(
        started=started,
        status=ScanStatusResponse.from_status(
            scan_controller.status,
            rescan_status=rescan_controller.status,
        ),
    )


@app.post("/api/scan/stop", response_model=ScanStopResponse)
async def api_scan_stop() -> ScanStopResponse:
    auto_stopped = await scan_controller.stop()
    one_shot_stopped = await rescan_controller.stop()
    stopped = auto_stopped or one_shot_stopped
    return ScanStopResponse(
        stopped=stopped,
        status=ScanStatusResponse.from_status(
            scan_controller.status,
            rescan_status=rescan_controller.status,
        ),
    )
