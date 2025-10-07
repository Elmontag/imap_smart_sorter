import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  AnalysisModule,
  Suggestion,
  ScanStatus,
  getFolders,
  getScanStatus,
  rescan,
  startScan,
  stopScan,
  updateFolderSelection,
} from '../api'
import SuggestionCard from '../components/SuggestionCard'
import PendingOverviewPanel from '../components/PendingOverviewPanel'
import FolderSelectionPanel from '../components/FolderSelectionPanel'
import DevtoolsPanel from '../components/DevtoolsPanel'
import AutomationSummaryCard from '../components/AutomationSummaryCard'
import { useSuggestions } from '../store/useSuggestions'
import { usePendingOverview } from '../store/usePendingOverview'
import { useAppConfig } from '../store/useAppConfig'
import { useFilterActivity } from '../store/useFilterActivity'

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

const moduleLabels: Record<AnalysisModule, string> = {
  STATIC: 'Statisch',
  HYBRID: 'Hybrid',
  LLM_PURE: 'LLM Pure',
}

export default function DashboardPage(): JSX.Element {
  const [suggestionScope, setSuggestionScope] = useState<'open' | 'all'>('open')
  const { data: suggestions, stats: suggestionStats, loading, error, refresh } = useSuggestions(suggestionScope)
  const { data: pendingOverview, loading: pendingLoading, error: pendingError } = usePendingOverview()
  const { data: appConfig, error: configError } = useAppConfig()
  const {
    data: filterActivity,
    loading: filterActivityLoading,
    error: filterActivityError,
    refresh: refreshFilterActivity,
  } = useFilterActivity()
  const [availableFolders, setAvailableFolders] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [folderDraft, setFolderDraft] = useState<string[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [savingFolders, setSavingFolders] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [rescanBusy, setRescanBusy] = useState(false)
  const lastFinishedRef = useRef<string | null>(null)
  const analysisModule: AnalysisModule = appConfig?.analysis_module ?? 'HYBRID'
  const moduleLabel = moduleLabels[analysisModule]

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
      setStatus(prev => prev ?? { kind: 'error', message: `Analyse-Status konnte nicht geladen werden: ${toMessage(err)}` })
    }
  }, [])

  useEffect(() => {
    void loadFolders()
    void loadScanStatus()
  }, [loadFolders, loadScanStatus])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadScanStatus()
    }, 15000)
    return () => {
      window.clearInterval(interval)
    }
  }, [loadScanStatus])

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
        message: response.started ? 'Analyse gestartet.' : 'Analyse läuft bereits.',
      })
      await loadScanStatus()
    } catch (err) {
      setStatus({ kind: 'error', message: `Analyse konnte nicht gestartet werden: ${toMessage(err)}` })
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
        message: response.stopped ? 'Analyse gestoppt.' : 'Es war keine Analyse aktiv.',
      })
      await loadScanStatus()
    } catch (err) {
      setStatus({ kind: 'error', message: `Analyse konnte nicht gestoppt werden: ${toMessage(err)}` })
    } finally {
      setRescanBusy(false)
      setScanBusy(false)
    }
  }

  const handleRescan = useCallback(async () => {
    setRescanBusy(true)
    try {
      const folders = selectedFolders.length ? selectedFolders : undefined
      const response = await rescan(folders)
      const noun = response.new_suggestions === 1 ? 'Vorschlag' : 'Vorschläge'
      setStatus({
        kind: 'success',
        message: `Einmalanalyse abgeschlossen (${response.new_suggestions} ${noun}).`,
      })
      void refresh()
    } catch (err) {
      setStatus({ kind: 'error', message: `Einmalanalyse fehlgeschlagen: ${toMessage(err)}` })
    } finally {
      setRescanBusy(false)
    }
  }, [refresh, selectedFolders])

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
    const active = Boolean(scanStatus?.active)
    const hasHistory = Boolean(scanStatus?.last_started_at)
    let statusLabel = 'Gestoppt'
    let statusVariant: 'running' | 'paused' | 'stopped' = 'stopped'
    if (active) {
      statusLabel = 'Automatik aktiv'
      statusVariant = 'running'
    } else if (rescanBusy) {
      statusLabel = 'Einmalanalyse aktiv'
      statusVariant = 'running'
    } else if (hasHistory) {
      statusLabel = 'Pausiert'
      statusVariant = 'paused'
    }
    return {
      active,
      folderLabel:
        scanStatus && scanStatus.folders.length > 0
          ? scanStatus.folders.join(', ')
          : 'Alle überwachten Ordner',
      pollInterval: scanStatus?.poll_interval ?? null,
      lastStarted: formatTimestamp(scanStatus?.last_started_at),
      lastFinished: formatTimestamp(scanStatus?.last_finished_at),
      lastResultCount,
      resultLabel,
      error: scanStatus?.last_error ?? null,
      statusLabel,
      statusVariant,
    }
  }, [rescanBusy, scanStatus])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-top">
          <div>
            <h1>IMAP Smart Sorter</h1>
            <p className="app-subline">Intelligente Unterstützung für sauberes Postfach-Management.</p>
          </div>
          <div className="header-actions">
            {appConfig && <span className="mode-badge module">Modul: {moduleLabel}</span>}
            {appConfig?.mode && <span className="mode-badge subtle">Modus: {appConfig.mode}</span>}
          </div>
        </div>
        <nav className="primary-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Dashboard
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Einstellungen
          </NavLink>
        </nav>
        <div className="analysis-top">
          <div className="analysis-canvas">
            <div className="analysis-status">
              <span className={`status-indicator ${scanSummary.statusVariant}`} aria-hidden="true" />
              <div className="analysis-status-text">
                <span className="label">Analyse</span>
                <strong>{scanSummary.statusLabel}</strong>
              </div>
            </div>
            <dl className="analysis-meta">
              <div>
                <dt>Ordner</dt>
                <dd>{scanSummary.folderLabel}</dd>
              </div>
              <div>
                <dt>Intervall</dt>
                <dd>{scanSummary.pollInterval ? `alle ${Math.round(scanSummary.pollInterval)} s` : '–'}</dd>
              </div>
              <div>
                <dt>Letzter Abschluss</dt>
                <dd>{scanSummary.lastFinished ?? '–'}</dd>
              </div>
              <div>
                <dt>Ergebnis</dt>
                <dd>{scanSummary.resultLabel ?? '–'}</dd>
              </div>
            </dl>
            {(scanSummary.lastStarted || scanSummary.error) && (
              <div className="analysis-foot">
                {scanSummary.lastStarted && <span>Zuletzt gestartet: {scanSummary.lastStarted}</span>}
                {scanSummary.error && <span className="analysis-error">Letzter Fehler: {scanSummary.error}</span>}
              </div>
            )}
          </div>
          <div className="analysis-actions">
            <button
              type="button"
              className="ghost"
              onClick={handleRescan}
              disabled={rescanBusy || scanBusy || scanSummary.active}
            >
              {rescanBusy ? 'Analysiere…' : 'Einmalige Analyse'}
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleStartScan}
              disabled={scanBusy || scanSummary.active || rescanBusy}
            >
              {scanBusy && !scanSummary.active ? 'Starte Analyse…' : 'Analyse starten'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handleStopScan}
              disabled={scanBusy || (!scanSummary.active && !rescanBusy)}
            >
              {scanBusy && (scanSummary.active || rescanBusy) ? 'Stoppe Analyse…' : 'Analyse stoppen'}
            </button>
          </div>
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
          {analysisModule !== 'LLM_PURE' && (
            <AutomationSummaryCard
              activity={filterActivity}
              loading={filterActivityLoading}
              error={filterActivityError}
              onReload={refreshFilterActivity}
            />
          )}

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
                    analysisModule={analysisModule}
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
