import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  MoveMode,
  Suggestion,
  ScanStatus,
  getFolders,
  getMode,
  getScanStatus,
  setMode,
  startScan,
  stopScan,
  updateFolderSelection,
} from '../api'
import SuggestionCard from '../components/SuggestionCard'
import PendingOverviewPanel from '../components/PendingOverviewPanel'
import FolderSelectionPanel from '../components/FolderSelectionPanel'
import DevtoolsPanel from '../components/DevtoolsPanel'
import { useSuggestions } from '../store/useSuggestions'
import { usePendingOverview } from '../store/usePendingOverview'
import { useAppConfig } from '../store/useAppConfig'

const modeOptions: MoveMode[] = ['DRY_RUN', 'CONFIRM', 'AUTO']

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

const formatTimestamp = (value?: string | null) => {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed.toLocaleString('de-DE')
}

export default function DashboardPage(): JSX.Element {
  const [suggestionScope, setSuggestionScope] = useState<'open' | 'all'>('open')
  const { data: suggestions, stats: suggestionStats, loading, error, refresh } = useSuggestions(suggestionScope)
  const { data: pendingOverview, loading: pendingLoading, error: pendingError } = usePendingOverview()
  const { data: appConfig, error: configError } = useAppConfig()
  const [mode, setModeState] = useState<MoveMode>('DRY_RUN')
  const [availableFolders, setAvailableFolders] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [folderDraft, setFolderDraft] = useState<string[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [savingFolders, setSavingFolders] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const lastFinishedRef = useRef<string | null>(null)

  const loadMode = useCallback(async () => {
    try {
      const response = await getMode()
      setModeState(response.mode)
    } catch (err) {
      setStatus({ kind: 'error', message: `Modus konnte nicht geladen werden: ${toMessage(err)}` })
    }
  }, [])

  const loadFolders = useCallback(async () => {
    setFoldersLoading(true)
    try {
      const result = await getFolders()
      setAvailableFolders([...result.available])
      setSelectedFolders([...result.selected])
      setFolderDraft([...result.selected])
    } catch (err) {
      setStatus({ kind: 'error', message: `Ordnerliste konnte nicht geladen werden: ${toMessage(err)}` })
    } finally {
      setFoldersLoading(false)
    }
  }, [])

  const loadScanStatus = useCallback(async () => {
    try {
      const statusResponse = await getScanStatus()
      setScanStatus(statusResponse)
    } catch (err) {
      setStatus(prev => prev ?? { kind: 'error', message: `Scan-Status konnte nicht geladen werden: ${toMessage(err)}` })
    }
  }, [])

  useEffect(() => {
    void loadMode()
    void loadFolders()
    void loadScanStatus()
  }, [loadMode, loadFolders, loadScanStatus])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadScanStatus()
    }, 15000)
    return () => {
      window.clearInterval(interval)
    }
  }, [loadScanStatus])

  const handleModeChange = async (value: MoveMode) => {
    try {
      const response = await setMode(value)
      setModeState(response.mode)
      setStatus({ kind: 'success', message: `Modus auf ${response.mode} gesetzt.` })
    } catch (err) {
      setStatus({ kind: 'error', message: `Moduswechsel fehlgeschlagen: ${toMessage(err)}` })
    }
  }

  useEffect(() => {
    const finishedAt = scanStatus?.last_finished_at ?? null
    if (!finishedAt) {
      return
    }
    if (lastFinishedRef.current && lastFinishedRef.current !== finishedAt) {
      void refresh()
    }
    lastFinishedRef.current = finishedAt
  }, [scanStatus?.last_finished_at, refresh])

  const handleStartScan = async () => {
    setScanBusy(true)
    try {
      const folders = selectedFolders.length ? selectedFolders : undefined
      const response = await startScan(folders)
      setScanStatus(response.status)
      setStatus({
        kind: response.started ? 'success' : 'info',
        message: response.started ? 'Scan gestartet.' : 'Scan läuft bereits.',
      })
    } catch (err) {
      setStatus({ kind: 'error', message: `Scan konnte nicht gestartet werden: ${toMessage(err)}` })
    } finally {
      setScanBusy(false)
    }
  }

  const handleStopScan = async () => {
    setScanBusy(true)
    try {
      const response = await stopScan()
      setScanStatus(response.status)
      setStatus({
        kind: response.stopped ? 'success' : 'info',
        message: response.stopped ? 'Scan angehalten.' : 'Es war kein Scan aktiv.',
      })
    } catch (err) {
      setStatus({ kind: 'error', message: `Scan konnte nicht gestoppt werden: ${toMessage(err)}` })
    } finally {
      setScanBusy(false)
    }
  }

  const dismissStatus = useCallback(() => setStatus(null), [])

  const handleFolderSave = useCallback(async () => {
    setSavingFolders(true)
    try {
      const response = await updateFolderSelection(folderDraft)
      setAvailableFolders([...response.available])
      setSelectedFolders([...response.selected])
      setFolderDraft([...response.selected])
      setStatus({ kind: 'success', message: 'Ordnerauswahl gespeichert.' })
    } catch (err) {
      setStatus({ kind: 'error', message: `Ordnerauswahl konnte nicht gespeichert werden: ${toMessage(err)}` })
    } finally {
      setSavingFolders(false)
    }
  }, [folderDraft])

  const handleFolderCreated = useCallback(
    async (folder: string) => {
      await loadFolders()
      setStatus({ kind: 'success', message: `Ordner ${folder} wurde angelegt.` })
    },
    [loadFolders],
  )

  const headline = useMemo(() => {
    if (loading) return 'Lade Vorschläge…'
    if (suggestionScope === 'open') {
      if (!suggestions.length) return 'Keine offenen Vorschläge.'
      return `${suggestions.length} offene Vorschläge`
    }
    const total = suggestionStats?.totalCount ?? suggestions.length
    if (!total) {
      return 'Noch keine analysierten Vorschläge.'
    }
    return `${total} analysierte Vorschläge`
  }, [loading, suggestions, suggestionScope, suggestionStats?.totalCount])

  const toggleSuggestionScope = useCallback(() => {
    setSuggestionScope(scope => (scope === 'open' ? 'all' : 'open'))
  }, [])

  const handleSuggestionUpdate = useCallback(async () => {
    await refresh()
  }, [refresh])

  const ollamaInfo = useMemo(() => {
    const status = appConfig?.ollama
    if (!status) {
      return null
    }
    const classifier = status.models.find(model => model.purpose === 'classifier')
    const embedding = status.models.find(model => model.purpose === 'embedding')
    const classifierLabel = classifier ? `${classifier.name}${classifier.available ? '' : ' (fehlt)'}` : '–'
    const embeddingLabel = embedding ? `${embedding.name}${embedding.available ? '' : ' (fehlt)'}` : '–'
    return {
      reachable: status.reachable,
      host: status.host,
      message: status.message ?? undefined,
      classifier: classifierLabel,
      embedding: embeddingLabel,
    }
  }, [appConfig])

  const scanSummary = useMemo(() => {
    const lastResultCount =
      typeof scanStatus?.last_result_count === 'number' ? scanStatus.last_result_count : null
    let resultLabel: string | null = null
    if (lastResultCount !== null) {
      const absolute = Math.max(0, lastResultCount)
      const noun = absolute === 1 ? 'neuer Vorschlag' : 'neue Vorschläge'
      resultLabel = `${absolute} ${noun}`
    }
    return {
      active: Boolean(scanStatus?.active),
      folderLabel:
        scanStatus && scanStatus.folders.length > 0
          ? scanStatus.folders.join(', ')
          : 'Überwachte Ordner',
      pollInterval: scanStatus?.poll_interval ?? null,
      lastStarted: formatTimestamp(scanStatus?.last_started_at),
      lastFinished: formatTimestamp(scanStatus?.last_finished_at),
      lastResultCount,
      resultLabel,
      error: scanStatus?.last_error ?? null,
      statusLabel: scanStatus?.active ? 'Scan aktiv' : 'Scan pausiert',
    }
  }, [scanStatus])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>IMAP Smart Sorter</h1>
          <p className="app-subline">Intelligente Unterstützung für sauberes Postfach-Management.</p>
        </div>
        <div className="header-actions">
          <Link to="/catalog" className="ghost nav-link">
            Katalog bearbeiten
          </Link>
          <label className="mode-select">
            <span>Modus</span>
            <select value={mode} onChange={event => handleModeChange(event.target.value as MoveMode)}>
              {modeOptions.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {status && (
        <div className={`status-banner ${status.kind}`} role="status">
          <span>{status.message}</span>
          <button className="link" type="button" onClick={dismissStatus}>
            Schließen
          </button>
        </div>
      )}

      {configError && <div className="status-banner error">{configError}</div>}
      {error && <div className="status-banner error">{error}</div>}

      <div className="app-layout">
        <aside className="app-sidebar">
          <FolderSelectionPanel
            available={availableFolders}
            draft={folderDraft}
            onDraftChange={setFolderDraft}
            onSave={handleFolderSave}
            onReload={loadFolders}
            loading={foldersLoading}
            saving={savingFolders}
          />
          {ollamaInfo && (
            <div className={`ollama-status-card ${ollamaInfo.reachable ? 'ok' : 'error'}`} title={ollamaInfo.message}>
              <div className="ollama-status-header">
                <span className="label">Ollama</span>
                <span className={`indicator ${ollamaInfo.reachable ? 'online' : 'offline'}`}>
                  {ollamaInfo.reachable ? 'verbunden' : 'offline'}
                </span>
              </div>
              <div className="ollama-status-body">
                <div className="host">{ollamaInfo.host}</div>
                <div className="models">
                  <span>Klassifikator: {ollamaInfo.classifier}</span>
                  <span>Embeddings: {ollamaInfo.embedding}</span>
                </div>
              </div>
            </div>
          )}
        </aside>
        <main className="app-main">
          <section className={`scan-status-card ${scanSummary.active ? 'active' : 'idle'}`}>
            <div className="scan-status-header">
              <div>
                <h2>Scan-Status</h2>
                <p className="scan-status-subline">
                  {scanSummary.active
                    ? 'Der automatische Scan läuft kontinuierlich.'
                    : 'Scans können bei Bedarf gestartet werden.'}
                </p>
              </div>
              <div className="scan-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={handleStartScan}
                  disabled={scanBusy || scanSummary.active}
                >
                  {scanBusy && !scanSummary.active ? 'Starte…' : 'Scan starten'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={handleStopScan}
                  disabled={scanBusy || !scanSummary.active}
                >
                  {scanBusy && scanSummary.active ? 'Stoppe…' : 'Scan stoppen'}
                </button>
              </div>
            </div>
            <div className="scan-status-body">
              <div className="scan-stat">
                <span className="label">Status</span>
                <strong>{scanSummary.statusLabel}</strong>
              </div>
              <div className="scan-stat">
                <span className="label">Ordner</span>
                <strong>{scanSummary.folderLabel}</strong>
              </div>
              <div className="scan-stat">
                <span className="label">Intervall</span>
                <strong>
                  {scanSummary.pollInterval ? `alle ${Math.round(scanSummary.pollInterval)} s` : '–'}
                </strong>
              </div>
              <div className="scan-stat">
                <span className="label">Letzter Lauf</span>
                <strong>{scanSummary.lastFinished ?? '–'}</strong>
              </div>
              <div className="scan-stat">
                <span className="label">Ergebnis</span>
                <strong>{scanSummary.resultLabel ?? '–'}</strong>
              </div>
            </div>
            {scanSummary.lastStarted && (
              <div className="scan-status-meta">Zuletzt gestartet: {scanSummary.lastStarted}</div>
            )}
            {scanSummary.error && <div className="scan-status-error">Letzter Fehler: {scanSummary.error}</div>}
          </section>
          <PendingOverviewPanel overview={pendingOverview} loading={pendingLoading} error={pendingError} />

          <section className="suggestions">
            <div className="suggestions-header">
              <h2>{headline}</h2>
              <div className="suggestions-actions">
                <button className="link" type="button" onClick={() => refresh()} disabled={loading}>
                  Aktualisieren
                </button>
                <button type="button" className="ghost" onClick={toggleSuggestionScope} disabled={loading}>
                  {suggestionScope === 'open'
                    ? 'Alle analysierten Mails bearbeiten'
                    : 'Nur offene Vorschläge anzeigen'}
                </button>
              </div>
            </div>
            {suggestionStats && (
              <div className="suggestions-metrics">
                <div className="suggestion-metric open">
                  <span className="label">Zu bearbeiten</span>
                  <strong>{suggestionStats.openCount}</strong>
                  <span className="muted">offene Vorschläge</span>
                </div>
                <div className="suggestion-metric processed">
                  <span className="label">Bereits bearbeitet</span>
                  <strong>{suggestionStats.decidedCount}</strong>
                  <span className="muted">von {suggestionStats.totalCount}</span>
                </div>
                <div className={`suggestion-metric error ${suggestionStats.errorCount === 0 ? 'empty' : ''}`}>
                  <span className="label">Fehler</span>
                  <strong>{suggestionStats.errorCount}</strong>
                  <span className="muted">benötigen Prüfung</span>
                </div>
              </div>
            )}
            {loading && <div className="placeholder">Bitte warten…</div>}
            {!loading && !suggestions.length && (
              <div className="placeholder">
                {suggestionScope === 'open'
                  ? 'Super! Alles abgearbeitet.'
                  : 'Es liegen noch keine analysierten Vorschläge vor.'}
              </div>
            )}
            {!loading && suggestions.length > 0 && (
              <div className="suggestion-grid">
                {suggestions.map((item: Suggestion) => (
                  <SuggestionCard
                    key={item.message_uid}
                    suggestion={item}
                    onActionComplete={handleSuggestionUpdate}
                    tagSlots={appConfig?.tag_slots}
                    availableFolders={availableFolders}
                    onFolderCreated={handleFolderCreated}
                  />
                ))}
              </div>
            )}
          </section>
        </main>
      </div>

      <DevtoolsPanel />
    </div>
  )
}
