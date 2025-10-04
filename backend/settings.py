
from pydantic_settings import BaseSettings
class Settings(BaseSettings):
    IMAP_HOST: str = "localhost"
    IMAP_PORT: int = 993
    IMAP_USERNAME: str = "user@example.org"
    IMAP_PASSWORD: str = ""
    IMAP_USE_SSL: bool = True
    IMAP_INBOX: str = "INBOX"
    PROCESS_ONLY_SEEN: bool = True
    OLLAMA_HOST: str = "http://ollama:11434"
    CLASSIFIER_MODEL: str = "llama3"
    EMBED_MODEL: str = "nomic-embed-text"
    DATABASE_URL: str = "sqlite:///data/app.db"
    POLL_INTERVAL_SECONDS: int = 30
    IDLE_FALLBACK: bool = True
    MIN_NEW_FOLDER_SCORE: float = 0.78
    MAX_SUGGESTIONS: int = 3
    MOVE_MODE: str = "CONFIRM"
    AUTO_THRESHOLD: float = 0.92
    class Config: env_file = ".env"
S = Settings()
