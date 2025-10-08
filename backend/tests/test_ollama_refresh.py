from fastapi.testclient import TestClient


def test_config_update_triggers_ollama_refresh(backend_env, monkeypatch):
    app_module = backend_env["app_module"]
    ollama_service = backend_env["ollama_service"]

    calls = []
    async def fake_load(force_refresh: bool):
        calls.append(force_refresh)
        return ollama_service.OllamaStatus(host="http://ollama", reachable=True, models=[])

    refresh_calls = []
    async def fake_ensure():
        refresh_calls.append(True)
        return ollama_service.OllamaStatus(host="http://ollama", reachable=True, models=[])

    monkeypatch.setattr(app_module, "_load_ollama_status", fake_load)
    monkeypatch.setattr(app_module, "ensure_ollama_ready", fake_ensure)

    with TestClient(app_module.app) as client:
        response = client.put(
            "/api/config",
            json={"analysis_module": "HYBRID", "classifier_model": "llama3"},
        )
        assert response.status_code == 200

    assert refresh_calls == [True]
    assert calls and calls[-1] is True
