
"""Application settings loaded from environment variables."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    IMAP_HOST: str = "localhost"
    IMAP_PORT: int = 993
    IMAP_USERNAME: str = "user@example.org"
    IMAP_PASSWORD: str = ""
    IMAP_USE_SSL: bool = True
    IMAP_INBOX: str = "INBOX"
    PROCESS_ONLY_SEEN: bool = False
    SINCE_DAYS: int = 30

    OLLAMA_HOST: str = "http://ollama:11434"
    CLASSIFIER_MODEL: str = "llama3"
    EMBED_MODEL: str = "nomic-embed-text"
    EMBED_PROMPT_HINT: str = ""
    EMBED_PROMPT_MAX_CHARS: int = 8000

    DATABASE_URL: str = "sqlite:///data/app.db"
    INIT_RUN: bool = False
    POLL_INTERVAL_SECONDS: int = 30
    IDLE_FALLBACK: bool = True
    MIN_NEW_FOLDER_SCORE: float = 0.78
    MAX_SUGGESTIONS: int = 3
    MOVE_MODE: str = "CONFIRM"
    AUTO_THRESHOLD: float = 0.92
    LOG_LEVEL: str = "INFO"

    IMAP_PROTECTED_TAG: str = ""
    IMAP_PROCESSED_TAG: str = ""
    IMAP_AI_TAG_PREFIX: str = "SmartSorter"

    PENDING_LIST_LIMIT: int = 25

    DEV_MODE: bool = False

    class Config:
        env_file = ".env"


S = Settings()
