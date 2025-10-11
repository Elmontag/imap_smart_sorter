import asyncio
import importlib

import pytest


def _pending_module():
    return importlib.import_module("backend.pending")


def test_pending_overview_cache_respects_force(monkeypatch, backend_env):
    pending = _pending_module()
    pending.invalidate_pending_cache()

    calls = []

    def fake_fetch(
        folders,
        *,
        processed_lookup=None,
        skip_known_uids=None,
        uid_limit=None,
        content_attribute=None,
    ):
        calls.append((tuple(folders), uid_limit, content_attribute))
        return {folder: {} for folder in folders}

    def fake_processed(folders):
        return {folder: set() for folder in folders}

    def fake_suggestions():
        return {}

    async def fake_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(pending, "fetch_recent_messages", fake_fetch)
    monkeypatch.setattr(pending, "processed_uids_by_folder", fake_processed)
    monkeypatch.setattr(pending, "known_suggestion_uids_by_folder", fake_suggestions)
    monkeypatch.setattr(pending, "_resolve_cache_ttl", lambda: 60.0)
    monkeypatch.setattr(pending, "_resolve_fetch_window", lambda _limit, _active: 10)
    monkeypatch.setattr(pending.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(pending.S, "PENDING_LIST_LIMIT", 5)

    asyncio.run(pending.load_pending_overview(["INBOX"]))
    asyncio.run(pending.load_pending_overview(["INBOX"]))
    assert len(calls) == 1

    asyncio.run(pending.load_pending_overview(["INBOX"], force_refresh=True))
    assert len(calls) == 2


def test_pending_overview_requests_headers(monkeypatch, backend_env):
    pending = _pending_module()
    pending.invalidate_pending_cache()

    captured = {}

    def fake_fetch(
        folders,
        *,
        processed_lookup=None,
        skip_known_uids=None,
        uid_limit=None,
        content_attribute=None,
    ):
        captured["uid_limit"] = uid_limit
        captured["content_attribute"] = content_attribute
        captured["processed_lookup"] = processed_lookup
        captured["skip_known_uids"] = skip_known_uids
        return {folder: {} for folder in folders}

    def fake_processed(folders):
        return {folder: set() for folder in folders}

    def fake_suggestions():
        return {}

    async def fake_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(pending, "fetch_recent_messages", fake_fetch)
    monkeypatch.setattr(pending, "processed_uids_by_folder", fake_processed)
    monkeypatch.setattr(pending, "known_suggestion_uids_by_folder", fake_suggestions)
    monkeypatch.setattr(pending, "_resolve_cache_ttl", lambda: 0.0)
    monkeypatch.setattr(pending, "_resolve_fetch_window", lambda _limit, _active: 123)
    monkeypatch.setattr(pending.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(pending.S, "PENDING_LIST_LIMIT", 25)

    asyncio.run(pending.load_pending_overview(["INBOX"]))

    assert captured["uid_limit"] == 123
    assert captured["content_attribute"] == b"BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)]"
    assert captured["processed_lookup"] == {"INBOX": set()}
    assert captured["skip_known_uids"] == {}
