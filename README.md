# IMAP Smart Sorter

Der IMAP Smart Sorter analysiert eingehende E-Mails, schlägt passende Zielordner vor und unterstützt beim automatisierten Verschieben. Das Projekt besteht aus drei Komponenten:

- **Backend** – FastAPI-Anwendung mit SQLite/SQLModel-Datenbank für Vorschläge, Status und API-Endpunkte.
- **Worker** – Asynchroner Scanner, der per IMAP neue Nachrichten verarbeitet, LLM-basierte Embeddings erzeugt und Vorschläge in der Datenbank ablegt.
- **Frontend** – Vite/React-Anwendung zur komfortablen Bewertung der Vorschläge, Anzeige des Betriebsmodus und manuellen Aktionen.
  Die Ordnerauswahl präsentiert sich als einklappbare Baumstruktur, neu gefundene Ordner lassen sich direkt aus den Vorschlagskarten anlegen.
  Im Dashboard kontrollierst du den Scan über Start/Stop-Buttons, siehst eine Automatisierungs-Kachel für Keyword-Regeln und behältst Statuskarten für Ollama sowie laufende Analysen im Blick.
  Eine Einstellungsseite (`#/settings`) bündelt Automatisierung, KI-Parameter und Betriebsmodus in separaten Tabs – inklusive Editor für Keyword-Regeln.
  Der Automatisierungs-Tab bietet eine zweigeteilte Ansicht mit Regel-Sidebar, Detailformular und Vorlagen für Newsletter-, Bestell-, Event- und Kalendereinladungs-Filter.
  Über die zusätzliche Unterseite `#/catalog` verwaltest du Ordner- und Tag-Katalog in einer dreispaltigen Ansicht mit hierarchischen Sidebars.

Während der Analyse werden pro Nachricht ein thematischer Überbegriff sowie passende Tags bestimmt. Die KI orientiert sich an bestehenden Ordnerhierarchien und schlägt neue Ordner nur dann vor, wenn keine Hierarchieebene überzeugt.

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
INIT_RUN=false
MOVE_MODE=CONFIRM
SINCE_DAYS=14
LOG_LEVEL=INFO
EMBED_PROMPT_HINT=E-Mails zu Rechnungen bitte besonders präzise clustern
EMBED_PROMPT_MAX_CHARS=6000
IMAP_PROTECTED_TAG=SmartSorter/Protected
IMAP_PROCESSED_TAG=SmartSorter/Done
IMAP_AI_TAG_PREFIX=SmartSorter
PENDING_LIST_LIMIT=25
DEV_MODE=false
MIN_MATCH_SCORE=60
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
- Standardmäßig nutzt der JSON-Klassifikator eine niedrige Temperatur (`CLASSIFIER_TEMPERATURE=0.1`), ein begrenztes Sampling
  (`CLASSIFIER_TOP_P=0.4`) sowie die von Ollama gemeldete Kontextgrenze (`CLASSIFIER_NUM_CTX_MATCH_MODEL=true`).
  `CLASSIFIER_NUM_CTX` dient als optionaler Cap und reduziert bei Bedarf das vom Modell angebotene Fenster.
  Mit `CLASSIFIER_CONTEXT_RESERVE_TOKENS` steuerst du, wie viele Tokens für System- und Kataloginformationen reserviert werden,
  während `CLASSIFIER_NUM_PREDICT=512` weiterhin die Antwortlänge begrenzt.
  So entstehen reproduzierbare, konsistente Ordnerpfade ohne die vorherige Trunkierungswarnung – über Umgebungsvariablen kannst
  du die Werte weiterhin feinjustieren.
- Verbindungsfehler (`httpx.ConnectError` oder Logeintrag `Ollama Embedding fehlgeschlagen`) deuten
  auf einen nicht erreichbaren Ollama-Host hin. Stelle sicher, dass `OLLAMA_HOST` auf `http://ollama:11434`
  zeigt, wenn alle Dienste via Docker Compose laufen. Bei lokal gestarteten Komponenten außerhalb
  von Docker muss der Wert auf `http://localhost:11434` oder die entsprechende IP des Hosts gesetzt werden.

### Automatische Kategorien, Tags & Kataloge

- Jede E-Mail wird strikt gegen einen festen Katalog aus [`backend/llm_config.json`](backend/llm_config.json) gematcht.
  Der Katalog enthält eine mehrstufige Ordnerhierarchie („Events“, „Bestellungen“, „Reisen“, „Projekte“) inklusive
  Unter- und Subunterordnern. Das LLM darf ausschließlich diese Pfade nutzen, alle Vorschläge werden nachträglich
  auf den nächstpassenden Katalogpfad normalisiert – freie Vorschläge wie „INBOX/…“ tauchen daher nicht mehr auf,
  weil der Normalisierer IMAP-Präfixe entfernt und nur Treffer ≥ `MIN_MATCH_SCORE` akzeptiert.
- Für jede mögliche Zuordnung vergibt das LLM einen Score zwischen 0 und 100 Punkten. 100 bedeutet perfekte Übereinstimmung,
  0 keinerlei Bezug. Der höchste Score bestimmt den Ordner-Vorschlag. Liegt kein Treffer über dem konfigurierten
  Schwellwert `MIN_MATCH_SCORE`, wird die Mail als `unmatched` markiert und es erfolgen weder Ordner- noch Tag-Vorschläge.
- Bis zu drei Tag-Slots decken **Komplexität**, **Priorität** und **Handlungsauftrag** ab. Für jeden Slot existiert ein
  Optionskatalog; das LLM muss eine Option auswählen und den Score ≥ `MIN_MATCH_SCORE` halten, andernfalls bleibt der Slot
  leer. Kontext-Tags wie `datum-YYYY-MM-TT` oder `reiseort-ORT` werden nur bei eindeutiger Zuordnung ergänzt.
- Tagging und Ordnerentscheidungen bleiben getrennt: Tags landen als `IMAP_AI_TAG_PREFIX/slot-option`-Kombination
  am jeweiligen IMAP-Objekt, während Ordner-Vorschläge weiter bestätigt oder abgelehnt werden können.

### Konfigurierbare Hierarchie & Tag-Slots

- `backend/llm_config.json` bündelt sowohl den Ordnerkatalog als auch die Tag-Slots. Die verschachtelte Struktur
  erlaubt beliebige Unterebenen (z. B. `Bestellungen/Onlinehandel/Versand`).
- Über `tag_slots` legst du benannte Slots samt erlaubter Optionen und Aliase fest. Die Reihenfolge der Einträge
  entspricht der Darstellung im Frontend. Zusätzliche Kontext-Tags werden pro Ordner (Bereich wie Unterordner)
  über `tag_guidelines` beschrieben (z. B. `veranstalter-NAME`, `ticketstatus-zugestellt`).
- Der `/api/config`-Endpunkt liefert die komplette Katalogkonfiguration (`folder_templates`, `tag_slots`, `context_tags`),
  sodass auch externe Tools auf die Vorgaben zugreifen können. Änderungen an `llm_config.json` werden beim nächsten Request
  automatisch berücksichtigt.
- Für interaktive Anpassungen stellt das Frontend eine Editor-Seite unter `#/catalog` bereit. Dort lassen sich Bereiche,
  Unterordner, Kontext-Tags sowie Tag-Slots (inklusive Aliase) grafisch pflegen und direkt speichern.
- Das Backend stellt die Rohdaten zusätzlich über `GET /api/catalog` bereit und akzeptiert Aktualisierungen per `PUT /api/catalog`.
- Über zusätzliche Buttons lassen sich IMAP-Ordnerstrukturen direkt in den Katalog übernehmen (`POST /api/catalog/import-mailbox`) oder der gepflegte Katalog spiegelbildlich im Postfach anlegen (`POST /api/catalog/export-mailbox`). Beide Aktionen sind in der Katalogansicht und im Einstellungs-Tab „Katalog“ verfügbar.

### Schutz- und Monitoring-Einstellungen

- `IMAP_PROTECTED_TAG` kennzeichnet Nachrichten, die vom Worker übersprungen werden sollen (z. B. manuell markierte Threads).
- `IMAP_PROCESSED_TAG` wird nach erfolgreicher Verarbeitung automatisch gesetzt und verhindert erneute Scans.
- Der Tab „Betrieb“ in den Einstellungen erlaubt das Bearbeiten von Verarbeitungsmodus, Ollama-Modell und IMAP-Tags; das Dashboard zeigt den aktuellen Modus nur noch an.
- `INIT_RUN` setzt beim nächsten Start die Datenbank zurück (Tabellen werden geleert, SQLite-Dateien neu angelegt).
- `PENDING_LIST_LIMIT` bestimmt die maximale Anzahl angezeigter Einträge im Pending-Dashboard (0 deaktiviert die Begrenzung).
- `DEV_MODE` aktiviert zusätzliche Debug-Ausgaben im Backend sowie das Dev-Panel im Frontend.
  Optional kann das Frontend per `VITE_DEV_MODE=true` (in `frontend/.env`) unabhängig vom Backend gestartet werden.
- Über `/api/scan/start`, `/api/scan/stop` und `/api/scan/status` steuerst du den kontinuierlichen Analyse-Controller. Das Frontend bietet zusätzlich einen Button „Einmalige Analyse“ (via `/api/rescan`), sodass sich eine sofortige Auswertung ohne Daueranalyse starten lässt.
- Laufende Dauer-Analysen blockieren den Einmal-Modus, bis sie gestoppt sind; parallel bleiben „Analyse starten“ und „Analyse stoppen“ für die kontinuierliche Ausführung verfügbar.
- Die Ordnerauswahl im Dashboard stellt die überwachten IMAP-Ordner als aufklappbaren Baum dar. Der Filter hebt Treffer farblich hervor und öffnet automatisch die relevanten Äste, sodass komplexe Hierarchien schneller angepasst werden können.

### Keyword-Filter & Direktzuordnung

- `backend/keyword_filters.json` definiert Regeln, die E-Mails noch vor der KI-Analyse verschieben. Jede Regel besitzt `name`, `enabled`, `target_folder`, optionale `tags`, eine `match`-Sektion (`mode` = `all` oder `any`, `fields` = `subject`/`sender`/`body`, `terms`) sowie eine optionale `date`-Spanne (`after`/`before` im Format `YYYY-MM-DD`).
- Der Editor im Tab „Automatisierung“ stellt dafür Vorlagen für Technik-, Mode- und Lebensmittel-Newsletter, Bestellungen und Rechnungen, Konzert- & Eventtickets sowie Kalendereinladungen bereit. Die Vorlagen befüllen passende Tags und Keywords, Zielordner und Beschreibungen lassen sich anschließend anpassen.
- Trifft eine Regel zu, legt der Worker fehlende Ordner automatisch an, verschiebt die Nachricht sofort, setzt definierte Tags und protokolliert das Ergebnis als `FilterHit`.
- Über `GET /api/filters` und `PUT /api/filters` bearbeitest du die Regeln programmatisch. Das Frontend bündelt die Pflege im Tab „Automatisierung“ der Einstellungsseite (`#/settings`) und visualisiert Treffer in einer Automationskachel auf dem Dashboard.
- `GET /api/filters/activity` liefert aggregierte Kennzahlen (Gesamtanzahl, letzte 24 h, Top-Regeln, aktuelle Treffer) und bildet die Grundlage für das Automatisierungs-Dashboard.

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
┌──────────┐      ┌────────────┐      ┌───────────────┐      ┌────────────┐
│  IMAP    │ ───▶ │ Stichwort- │ ───▶ │  Worker      │ ───▶ │ Datenbank  │
│  Server  │      │ filter      │      │  (LLM)       │      │ (SQLModel) │
└──────────┘      └──────┬─────┘      └──────┬────────┘      └─────┬──────┘
                         │                   │                   │
                         ▼                   ▼                   ▼
                    Sofort-Moves        LLM Embeddings     FastAPI Backend
                         │                   │
                         └───────────────────┴────┐
                                                 ▼
                                           React Frontend
```

Die Keyword-Analyse entscheidet zunächst, ob eine Nachricht anhand definierter Regeln direkt verschoben wird – erst danach greift die KI-Klassifikation.

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
| `GET`   | `/api/suggestions`  | Liefert Vorschläge inkl. Ranking; mit `?include=all` auch bereits entschiedene |
| `GET`   | `/api/pending`      | Übersicht offener, noch nicht verarbeiteter Nachrichten |
| `GET`   | `/api/tags`         | Aggregierte KI-Tags inkl. Beispiele für die weitere Verarbeitung |
| `GET`   | `/api/filters`      | Liefert aktuelle Keyword-Regeln für direkte Zuordnungen |
| `PUT`   | `/api/filters`      | Persistiert aktualisierte Keyword-Regeln |
| `GET`   | `/api/filters/activity` | Statistik zu Filtertreffern (Gesamt, letzte 24 h, letzte Aktionen) |
| `GET`   | `/api/ollama`       | Aktuelle Erreichbarkeit des Ollama-Hosts und Modellstatus |
| `GET`   | `/api/config`       | Liefert Laufzeitkonfiguration (Modus, Modell, Tag-Namen, Listenlimit) |
| `PUT`   | `/api/config`       | Aktualisiert Modus, Sprachmodell und IMAP-Tags (Teil-Update möglich) |
| `POST`  | `/api/decide`       | Nimmt Entscheidung für einen Vorschlag entgegen |
| `POST`  | `/api/move`         | Verschiebt oder simuliert eine einzelne Nachricht |
| `POST`  | `/api/move/bulk`    | Führt mehrere Move-Requests nacheinander aus |
| `POST`  | `/api/proposal`     | Bestätigt oder verwirft einen KI-Ordner-Vorschlag |
| `POST`  | `/api/folders/create` | Legt fehlende IMAP-Ordner (inklusive Zwischenebenen) an |
| `POST`  | `/api/rescan`       | Erzwingt einen einmaligen Scan (optional mit `folders`-Liste) |
| `GET`   | `/api/scan/status`  | Laufzeitstatus des Scan-Controllers (aktiv, Intervalle, letzte Ergebnisse) |
| `POST`  | `/api/scan/start`   | Startet den kontinuierlichen Scan für die übergebenen Ordner (oder die gespeicherte Auswahl) |
| `POST`  | `/api/scan/stop`    | Stoppt den laufenden Scan-Controller |
| `GET`   | `/api/catalog`      | Gibt den aktuellen Ordner- und Tag-Katalog (inkl. Hierarchie) zurück |
| `POST`  | `/api/catalog/import-mailbox` | Übernimmt die IMAP-Ordnerstruktur als neue Katalogdefinition |
| `POST`  | `/api/catalog/export-mailbox` | Erstellt alle Katalogordner im Postfach (inkl. Zwischenpfade) |
| `PUT`   | `/api/catalog`      | Persistiert einen aktualisierten Katalog (Ordner & Tag-Slots) |

Alle Endpunkte liefern JSON und verwenden HTTP-Statuscodes für Fehlerzustände.

## Tests & Qualitätssicherung

- **Python**: `python -m compileall backend` stellt sicher, dass alle Module syntaktisch valide sind.
- **Frontend**: `npm run build` im Verzeichnis `frontend` prüft den TypeScript- und Bundling-Prozess.
- **Docker**: `docker compose build` validiert das Container-Setup.

## Entwicklungsrichtlinien

Weitere Stil- und Strukturhinweise befinden sich in [`AGENTS.md`](AGENTS.md). Bitte bei Änderungen am Code oder an Dokumentation stets auch diese Datei prüfen und die README aktuell halten.
