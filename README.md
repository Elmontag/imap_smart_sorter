# IMAP Smart Sorter

Der IMAP Smart Sorter analysiert eingehende E-Mails, schlägt passende Zielordner vor und unterstützt beim automatisierten Verschieben. Das Projekt besteht aus drei Komponenten:

- **Backend** – FastAPI-Anwendung mit SQLite/SQLModel-Datenbank für Vorschläge, Status und API-Endpunkte.
- **Worker** – Asynchroner Scanner, der per IMAP neue Nachrichten verarbeitet, LLM-basierte Embeddings erzeugt und Vorschläge in der Datenbank ablegt.
- **Frontend** – Vite/React-Anwendung zur komfortablen Bewertung der Vorschläge, Steuerung des Betriebsmodus und manuellen Aktionen.
  Sie erlaubt jetzt auch das Speichern individueller Ordnerauswahlen sowie das direkte Bestätigen oder Ablehnen von KI-Ordner-Vorschlägen.
  Der Kopfbereich zeigt den verbundenen Ollama-Host samt der verwendeten Modelle an.

## Schnellstart mit Docker Compose

1. Erstelle eine `.env` im Projektwurzelverzeichnis (Beispiel unten).
2. Starte alle Services: `docker compose up --build`
3. Frontend: <http://localhost:5173> – Backend: <http://localhost:8000>
4. Beende mit `docker compose down`

> **Hinweis:** Der `ollama`-Dienst lädt Modelle beim ersten Start nach. Plane zusätzliche Zeit/Netzwerk ein oder passe `CLASSIFIER_MODEL`/`EMBED_MODEL` an lokal verfügbare Modelle an.

### Beispiel-`.env`

```dotenv
IMAP_HOST=imap.example.org
IMAP_USERNAME=demo@example.org
IMAP_PASSWORD=super-secret
IMAP_INBOX=INBOX
PROCESS_ONLY_SEEN=false
OLLAMA_HOST=http://ollama:11434
DATABASE_URL=sqlite:///data/app.db
MOVE_MODE=CONFIRM
SINCE_DAYS=14
LOG_LEVEL=INFO
EMBED_PROMPT_HINT=E-Mails zu Rechnungen bitte besonders präzise clustern
EMBED_PROMPT_MAX_CHARS=6000
IMAP_PROTECTED_TAG=SmartSorter/Protected
IMAP_PROCESSED_TAG=SmartSorter/Done
PENDING_LIST_LIMIT=25
DEV_MODE=false
```

### Hinweise zur IMAP-Suche

- Wenn Ordner aufgelistet werden, aber keine Nachrichten erscheinen, prüfe `PROCESS_ONLY_SEEN`.
  Der Wert `false` verarbeitet ungelesene Nachrichten (`UNSEEN`); `true` beschränkt die Suche
  auf bereits gelesene Mails (`SEEN`).
- Passe `SINCE_DAYS` an, falls dein IMAP-Server ältere Nachrichten nicht als „aktuell“ meldet.

### OLLAMA-Integration optimieren

- Der Worker nutzt Embeddings und einen nachgelagerten JSON-Chat mit dem Modell aus `CLASSIFIER_MODEL`,
  um begründete Ordner-Rankings und optionale Neuanlage-Vorschläge zu erzeugen.
- Beim Start prüfen Backend und Worker automatisch, ob die in `CLASSIFIER_MODEL` und `EMBED_MODEL`
  konfigurierten Modelle vorhanden sind. Fehlende Modelle werden über die Ollama-API nachgeladen und
  Probleme im Frontend angezeigt.
- Über `EMBED_PROMPT_HINT` kannst du zusätzliche Instruktionen (z. B. Projektnamen, Prioritäten)
  setzen, ohne den Code anzupassen. Sowohl Embedding- als auch Klassifikationsprompt greifen auf den Hinweis zu.
- `EMBED_PROMPT_MAX_CHARS` limitiert die Länge des Prompts, um Speicherbedarf und Antwortzeiten
  zu kontrollieren.
- Verbindungsfehler (`httpx.ConnectError` oder Logeintrag `Ollama Embedding fehlgeschlagen`) deuten
  auf einen nicht erreichbaren Ollama-Host hin. Stelle sicher, dass `OLLAMA_HOST` auf `http://ollama:11434`
  zeigt, wenn alle Dienste via Docker Compose laufen. Bei lokal gestarteten Komponenten außerhalb
  von Docker muss der Wert auf `http://localhost:11434` oder die entsprechende IP des Hosts gesetzt werden.

### Schutz- und Monitoring-Einstellungen

- `IMAP_PROTECTED_TAG` kennzeichnet Nachrichten, die vom Worker übersprungen werden sollen (z. B. manuell markierte Threads).
- `IMAP_PROCESSED_TAG` wird nach erfolgreicher Verarbeitung automatisch gesetzt und verhindert erneute Scans.
- `PENDING_LIST_LIMIT` bestimmt die maximale Anzahl angezeigter Einträge im Pending-Dashboard (0 blendet die Tabelle aus).
- `DEV_MODE` aktiviert zusätzliche Debug-Ausgaben im Backend sowie das Dev-Panel im Frontend.
  Optional kann das Frontend per `VITE_DEV_MODE=true` (in `frontend/.env`) unabhängig vom Backend gestartet werden.

## Lokale Entwicklung

### Backend & Worker

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app:app --host 0.0.0.0 --port 8000
# In zweitem Terminal für den Worker
python backend/imap_worker.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Die Vite-Entwicklungsumgebung proxied standardmäßig auf `localhost:5173`. Passe `VITE_API_BASE` in einer `.env` innerhalb von `frontend/` an, falls das Backend unter einer anderen Adresse erreichbar ist.

## Architekturüberblick

```
┌──────────┐      ┌───────────────┐      ┌────────────┐
│  IMAP    │ ───▶ │  Worker      │ ───▶ │ Datenbank  │
│  Server  │      │  (async)      │      │ (SQLModel) │
└──────────┘      └──────┬────────┘      └─────┬──────┘
                          │                   │
                          ▼                   ▼
                     LLM Embeddings     FastAPI Backend
                          │                   │
                          └──────────────┬────┘
                                         ▼
                                   React Frontend
```

- **Mailbox**: `backend/mailbox.py` kapselt IMAP-Verbindungen, liefert aktuelle Nachrichten und führt Move-Operationen aus (Fallback Copy+Delete).
- **Worker**: `backend/imap_worker.py` ruft `fetch_recent_messages`, erstellt pro Mail ein `Suggestion`-Objekt und aktualisiert Profile bei automatischen Moves.
- **Classifier**: `backend/classifier.py` erzeugt Embeddings via Ollama und berechnet Kosinusähnlichkeiten zu bekannten Ordner-Profilen.
- **Persistenz**: `backend/database.py` verwaltet SQLModel-Sessions, Vorschlagsstatus und Konfigurationswerte wie den aktuellen Move-Modus.
- **Frontend**: `frontend/src` nutzt TypeScript und bündelt sämtliche Styles in `styles.css`. Komponenten verwenden die API-Wrapper aus `frontend/src/api.ts`.

## API-Referenz (Auszug)

| Methode | Pfad                | Beschreibung |
|--------:|---------------------|--------------|
| `GET`   | `/healthz`          | Healthcheck für Monitoring |
| `GET`   | `/api/mode`         | Liefert den aktuellen Move-Modus (`DRY_RUN`, `CONFIRM`, `AUTO`) |
| `POST`  | `/api/mode`         | Setzt den Move-Modus – Body `{ "mode": "CONFIRM" }` |
| `GET`   | `/api/folders`      | Liefert verfügbare Ordner sowie die gespeicherte Auswahl |
| `POST`  | `/api/folders/selection` | Speichert die zu überwachenden IMAP-Ordner |
| `GET`   | `/api/suggestions`  | Liefert offene Vorschläge inkl. Ranking |
| `GET`   | `/api/pending`      | Übersicht offener, noch nicht verarbeiteter Nachrichten |
| `GET`   | `/api/ollama`       | Aktuelle Erreichbarkeit des Ollama-Hosts und Modellstatus |
| `GET`   | `/api/config`       | Liefert Laufzeitkonfiguration (Dev-Modus, Tag-Namen, Listenlimit) |
| `POST`  | `/api/decide`       | Nimmt Entscheidung für einen Vorschlag entgegen |
| `POST`  | `/api/move`         | Verschiebt oder simuliert eine einzelne Nachricht |
| `POST`  | `/api/move/bulk`    | Führt mehrere Move-Requests nacheinander aus |
| `POST`  | `/api/proposal`     | Bestätigt oder verwirft einen KI-Ordner-Vorschlag |
| `POST`  | `/api/rescan`       | Erzwingt einen einmaligen Scan (optional mit `folders`-Liste) |

Alle Endpunkte liefern JSON und verwenden HTTP-Statuscodes für Fehlerzustände.

## Tests & Qualitätssicherung

- **Python**: `python -m compileall backend` stellt sicher, dass alle Module syntaktisch valide sind.
- **Frontend**: `npm run build` im Verzeichnis `frontend` prüft den TypeScript- und Bundling-Prozess.
- **Docker**: `docker compose build` validiert das Container-Setup.

## Entwicklungsrichtlinien

Weitere Stil- und Strukturhinweise befinden sich in [`AGENTS.md`](AGENTS.md). Bitte bei Änderungen am Code oder an Dokumentation stets auch diese Datei prüfen und die README aktuell halten.
