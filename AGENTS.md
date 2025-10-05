# Agent Guidelines for `imap_smart_sorter`

Diese Hinweise gelten rekursiv für das gesamte Repository.

## Allgemeine Prinzipien
- Bevorzugt typsichere Implementationen: Python-Code erhält vollständige Typannotationen, React-Komponenten nutzen TypeScript-Interfaces.
- Logik gehört in klar getrennte Module (`database`, `mailbox`, `imap_worker`). Teile keine Zuständigkeiten quer über Dateien.
- Halte die README und diese Datei synchron mit funktionalen Änderungen.
- Ergänze neue API-Endpunkte stets mit kurzen Erläuterungen in der README.
- Die Katalogdatei [`backend/llm_config.json`](backend/llm_config.json) definiert Ordner- und Tag-Hierarchien. Halte sie bei Funktionsänderungen synchron mit README und achte darauf, dass alle Begriffe katalogisiert sind.
- Die Kategorisierung nutzt `MIN_MATCH_SCORE` (Default 60). Prüfe bei Änderungen an der Klassifikation, dass Scores in diesem Rahmen korrekt verarbeitet werden.
- Ordnerzuordnungen dürfen ausschließlich katalogisierte Pfade liefern; `_match_catalog_path` entfernt IMAP-Präfixe wie `INBOX/` und verwirft Kandidaten unterhalb des Schwellwerts. Passe den README-Hinweis an, falls du das Verhalten erweiterst.
- Der Endpunkt `/api/catalog` liefert und speichert den kompletten Katalog. Stelle sicher, dass Frontend und Backend beim Schreiben dieselbe Struktur (inkl. Aliase) verwenden.

## Python (Backend & Worker)
- Verwende das Hilfs-Context-Manager `get_session()` für alle Datenbankzugriffe.
- Fehlerbehandlung: nutze präzise Ausnahmen (z. B. `HTTPException`) und logge unvorhergesehene Fehler mit dem globalen Logger.
- Keine `print`-Statements im Produktionscode – stattdessen `logging`.
- Neue Module müssen import-sicher sein (`python -m compileall backend`).

## Frontend
- Styling erfolgt über `frontend/src/styles.css`. Ergänze neue Klassen dort und verzichte auf Inline-Styling, sofern nicht zwingend erforderlich.
- API-Aufrufe laufen über die Wrapper in `frontend/src/api.ts`. Erweitere diese bei neuen Endpunkten.
- Komponenten bleiben funktionsbasiert; Hooks kommen in `frontend/src/store`.
- Der Katalog-Editor (`#/catalog`) muss `getCatalogDefinition`/`updateCatalogDefinition` aus `api.ts` verwenden und Änderungen lokal validieren, bevor sie gespeichert werden.

## Tests & Validierung
- Bei relevanten Änderungen mindestens `python -m compileall backend` sowie `npm run build` ausführen und im PR erwähnen.
- Prüfe Docker-Deployments via `docker compose build`, wenn Container tangiert werden.
