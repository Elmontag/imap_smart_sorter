import asyncio


def test_ollama_status_lists_detected_models_without_requirements(backend_env, monkeypatch):
    ollama_service = backend_env["ollama_service"]
    settings_module = backend_env["settings"]

    monkeypatch.setattr(ollama_service, "resolve_classifier_model", lambda: "")

    monkeypatch.setattr(settings_module.S, "CLASSIFIER_MODEL", "", raising=False)
    monkeypatch.setattr(settings_module.S, "EMBED_MODEL", "", raising=False)
    monkeypatch.setattr(ollama_service.S, "EMBED_MODEL", "", raising=False)

    async def fake_fetch_tags(client):
        return [
            {"model": "llama3:8b", "digest": "sha-llama", "size": 123_456},
            {"name": "nomic-embed-text", "sha256": "sha-embed", "size": 78_910},
        ]

    monkeypatch.setattr(ollama_service, "_fetch_tags", fake_fetch_tags)

    status = asyncio.run(ollama_service.refresh_status(pull_missing=False))

    assert status.reachable is True
    assert status.message == "Alle Ollama-Modelle sind einsatzbereit"

    assert len(status.models) == 2
    normalized = {model.normalized_name for model in status.models}
    assert "llama3:8b" in normalized
    assert "nomic-embed-text:latest" in normalized

    for model in status.models:
        assert model.available is True
        assert model.purpose == "custom"
        assert model.pulled is True
        assert model.message == "bereit"
