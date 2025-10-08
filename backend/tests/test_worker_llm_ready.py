import importlib


def _get_helper_modules():
    ollama_service = importlib.import_module("ollama_service")
    imap_worker = importlib.import_module("imap_worker")
    return ollama_service, imap_worker


def test_ollama_requirements_fail_when_unreachable(backend_env):
    ollama_service, imap_worker = _get_helper_modules()
    status = ollama_service.OllamaStatus(host="http://ollama", reachable=False, models=[])
    assert imap_worker._ollama_requirements_met(status) is False


def test_ollama_requirements_fail_when_models_missing(backend_env):
    ollama_service, imap_worker = _get_helper_modules()

    status = ollama_service.OllamaStatus(
        host="http://ollama",
        reachable=True,
        models=[
            ollama_service.OllamaModelStatus(
                name="llama3",
                normalized_name="llama3:latest",
                purpose="classifier",
                available=False,
            ),
            ollama_service.OllamaModelStatus(
                name="nomic-embed-text",
                normalized_name="nomic-embed-text:latest",
                purpose="embedding",
                available=True,
            ),
        ],
    )

    assert imap_worker._ollama_requirements_met(status) is False

    status.models[0].available = True
    assert imap_worker._ollama_requirements_met(status) is True


def test_ollama_requirements_allow_custom_models_only(backend_env):
    ollama_service, imap_worker = _get_helper_modules()

    status = ollama_service.OllamaStatus(
        host="http://ollama",
        reachable=True,
        models=[
            ollama_service.OllamaModelStatus(
                name="custom-model",
                normalized_name="custom-model:latest",
                purpose="custom",
                available=True,
            )
        ],
    )

    assert imap_worker._ollama_requirements_met(status) is True
