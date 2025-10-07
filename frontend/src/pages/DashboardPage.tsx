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

const normalizeFolders = (folders: string[]): string[] =>
  Array.from(new Set(folders.map(folder => folder.trim()).filter(folder => folder.length > 0)))

export default function DashboardPage(): JSX.Element {
  const [suggestionScope, setSuggestionScope] = useState<'open' | 'all'>('open')
  const { data: suggestions, stats: suggestionStats, loading, error, refresh } = useSuggestions(suggestionScope)
  const {
    data: pendingOverview,
    loading: pendingLoading,
    error: pendingError,
    refresh: refreshPendingOverview,
  } = usePendingOverview()
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
  const manualFinishedRef = useRef<string | null>(null)
  const analysisModule: AnalysisModule = appConfig?.analysis_module ?? 'HYBRID'
  const moduleLabel = moduleLabels[analysisModule]

  const loadFolders = useCallback(async () => {
    setFoldersLoading(true)
    try {
      const result = await getFolders()
      const normalizedSelected = normalizeFolders(result.selected)
      setAvailableFolders([...result.available])
      setSelectedFolders([...normalizedSelected])
      setFolderDraft([...normalizedSelected])
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

  useEffect(() => {
    const manualFinishedAt = scanStatus?.rescan_finished_at ?? null
    if (!manualFinishedAt) {
      return
    }
    if (manualFinishedRef.current && manualFinishedRef.current !== manualFinishedAt) {
      void refresh()
    }
    manualFinishedRef.current = manualFinishedAt
  }, [scanStatus?.rescan_finished_at, refresh])

  useEffect(() => {
    if (!scanStatus?.rescan_active && rescanBusy) {
      setRescanBusy(false)
    }
  }, [scanStatus?.rescan_active, rescanBusy])

  const handleStartScan = async () => {
    setScanBusy(true)
    try {
      const normalizedSelection = normalizeFolders(selectedFolders)
      const response = await startScan(normalizedSelection.length ? normalizedSelection : undefined)
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
      void refreshPendingOverview().catch(() => undefined)
    }
  }

  const handleStopScan = async () => {
    setScanBusy(true)
    try {
      const response = await stopScan()
      setScanStatus(response.status)
      const nextStatus = response.status
      let message = 'Analyse gestoppt.'
      let kind: StatusKind = response.stopped ? 'success' : 'info'
      if (!response.stopped) {
        message = 'Es war keine Analyse aktiv.'
      } else if (nextStatus.rescan_cancelled && !nextStatus.rescan_active) {
        message = nextStatus.active
          ? 'Einmalanalyse gestoppt, Automatik läuft weiter.'
          : 'Einmalanalyse gestoppt.'
      } else if (!nextStatus.active) {
        message = 'Analyse gestoppt.'
      }
      setStatus({ kind, message })
      await loadScanStatus()
    } catch (err) {
      setStatus({ kind: 'error', message: `Analyse konnte nicht gestoppt werden: ${toMessage(err)}` })
    } finally {
      setRescanBusy(false)
      setScanBusy(false)
      void refreshPendingOverview().catch(() => undefined)
    }
  }

  const handleRescan = useCallback(async () => {
    setRescanBusy(true)
    try {
      const normalizedSelection = normalizeFolders(selectedFolders)
      const response = await rescan(normalizedSelection.length ? normalizedSelection : undefined)
      if (!response.ok && response.cancelled) {
        setStatus({ kind: 'info', message: 'Einmalanalyse abgebrochen.' })
      } else if (!response.ok) {
        setStatus({ kind: 'error', message: 'Einmalanalyse konnte nicht abgeschlossen werden.' })
      } else {
        const noun = response.new_suggestions === 1 ? 'Vorschlag' : 'Vorschläge'
        setStatus({
          kind: 'success',
          message: `Einmalanalyse abgeschlossen (${response.new_suggestions} ${noun}).`,
        })
      }
      void refresh()
    } catch (err) {
      setStatus({ kind: 'error', message: `Einmalanalyse fehlgeschlagen: ${toMessage(err)}` })
    } finally {
      setRescanBusy(false)
      await loadScanStatus()
      void refreshPendingOverview().catch(() => undefined)
    }
  }, [loadScanStatus, refresh, refreshPendingOverview, selectedFolders])

  const dismissStatus = useCallback(() => setStatus(null), [])

  const handleFolderSave = useCallback(async () => {
    setSavingFolders(true)
    try {
      const normalizedDraft = normalizeFolders(folderDraft)
      const response = await updateFolderSelection(normalizedDraft)
      const normalizedSelected = normalizeFolders(response.selected)
      setAvailableFolders([...response.available])
      setSelectedFolders([...normalizedSelected])
      setFolderDraft([...normalizedSelected])
      setStatus({ kind: 'success', message: 'Ordnerauswahl gespeichert.' })
      void refreshPendingOverview().catch(() => undefined)
    } catch (err) {
      setStatus({ kind: 'error', message: `Ordnerauswahl konnte nicht gespeichert werden: ${toMessage(err)}` })
    } finally {
      setSavingFolders(false)
    }
  }, [folderDraft, refreshPendingOverview])

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
    const autoActive = Boolean(scanStatus?.active)
    const manualRemoteActive = Boolean(scanStatus?.rescan_active)
    const manualActive = manualRemoteActive || rescanBusy
    const hasHistory = Boolean(scanStatus?.last_started_at || scanStatus?.rescan_started_at)

    const autoResultCount =
      typeof scanStatus?.last_result_count === 'number' ? Math.max(0, scanStatus.last_result_count) : null
    const manualResultCount =
      typeof scanStatus?.rescan_result_count === 'number'
        ? Math.max(0, scanStatus.rescan_result_count)
        : null

    const autoResultLabel =
      autoResultCount !== null
        ? `${autoResultCount} ${autoResultCount === 1 ? 'neuer Vorschlag' : 'neue Vorschläge'}`
        : null
    const manualResultLabel =
      manualResultCount !== null
        ? `${manualResultCount} ${manualResultCount === 1 ? 'Vorschlag' : 'Vorschläge'}`
        : null

    let statusLabel = 'Gestoppt'
    let statusVariant: 'running' | 'paused' | 'stopped' = 'stopped'
    if (autoActive) {
      statusLabel = 'Automatik aktiv'
      statusVariant = 'running'
    } else if (manualActive) {
      statusLabel = 'Einmalanalyse aktiv'
      statusVariant = 'running'
    } else if (hasHistory) {
      statusLabel = 'Pausiert'
      statusVariant = 'paused'
    }

    const manualFolders =
      scanStatus?.rescan_folders && scanStatus.rescan_folders.length > 0
        ? scanStatus.rescan_folders.join(', ')
        : null

    return {
      autoActive,
      manualActive,
      folderLabel:
        scanStatus && scanStatus.folders.length > 0
          ? scanStatus.folders.join(', ')
          : 'Alle überwachten Ordner',
      pollInterval: scanStatus?.poll_interval ?? null,
      lastStarted: formatTimestamp(scanStatus?.last_started_at),
      lastFinished: formatTimestamp(scanStatus?.last_finished_at),
      lastResultCount: autoResultCount,
      resultLabel: manualResultLabel ?? autoResultLabel,
      error: scanStatus?.last_error ?? null,
      statusLabel,
      statusVariant,
      manual: {
        active: manualRemoteActive,
        folders: manualFolders,
        started: formatTimestamp(scanStatus?.rescan_started_at),
        finished: formatTimestamp(scanStatus?.rescan_finished_at),
        resultLabel: manualResultLabel,
        error: scanStatus?.rescan_error ?? null,
        cancelled: Boolean(scanStatus?.rescan_cancelled),
      },
    }
  }, [rescanBusy, scanStatus])

  const manualInfo = scanSummary.manual
  const manualActive = scanSummary.manualActive
  const autoActive = scanSummary.autoActive

  const manualStatusParts: string[] = []
  if (manualActive) {
    manualStatusParts.push('läuft…')
  } else if (manualInfo.finished) {
    manualStatusParts.push(manualInfo.finished)
  } else {
    manualStatusParts.push('–')
  }
  if (!manualActive && manualInfo.resultLabel) {
    manualStatusParts.push(`· ${manualInfo.resultLabel}`)
  }
  if (manualActive && manualInfo.folders) {
    manualStatusParts.push(`· ${manualInfo.folders}`)
  } else if (!manualActive && manualInfo.cancelled) {
    manualStatusParts.push('· abgebrochen')
  }
  const manualMetaLabel = manualStatusParts.filter(Boolean).join(' ').trim() || '–'

  const analysisFootEntries: React.ReactNode[] = []
  if (scanSummary.lastStarted) {
    analysisFootEntries.push(<span key="auto-start">Zuletzt gestartet: {scanSummary.lastStarted}</span>)
  }
  if (manualInfo.started) {
    const folderSuffix = manualInfo.folders ? ` · ${manualInfo.folders}` : ''
    const cancelSuffix = !manualInfo.active && manualInfo.cancelled ? ' (abgebrochen)' : ''
    analysisFootEntries.push(
      <span key="manual-start">
        Einmalanalyse: {manualInfo.started}
        {folderSuffix}
        {cancelSuffix}
      </span>,
    )
  }
  if (scanSummary.error) {
    analysisFootEntries.push(
      <span key="auto-error" className="analysis-error">
        Letzter Fehler: {scanSummary.error}
      </span>,
    )
  }
  if (manualInfo.error) {
    analysisFootEntries.push(
      <span key="manual-error" className="analysis-error">
        Einmalanalyse-Fehler: {manualInfo.error}
      </span>,
    )
  }

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
                <dt>Einmalanalyse</dt>
                <dd>{manualMetaLabel}</dd>
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
            {analysisFootEntries.length > 0 && <div className="analysis-foot">{analysisFootEntries}</div>}
          </div>
          <div className="analysis-actions">
            <button
              type="button"
              className="ghost"
              onClick={handleRescan}
              disabled={manualActive || autoActive || scanBusy}
            >
              {rescanBusy ? 'Analysiere…' : 'Einmalige Analyse'}
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleStartScan}
              disabled={scanBusy || autoActive || manualActive}
            >
              {scanBusy && !autoActive ? 'Starte Analyse…' : 'Analyse starten'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handleStopScan}
              disabled={scanBusy || (!autoActive && !manualActive)}
            >
              {scanBusy && (autoActive || manualActive) ? 'Stoppe Analyse…' : 'Analyse stoppen'}
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
                  <span className="muted">offene Nachrichten</span>
                </div>
                <div className="suggestion-metric processed">
                  <span className="label">Bereits bearbeitet</span>
                  <strong>{suggestionStats.decidedCount}</strong>
                  <span className="muted">von {suggestionStats.totalCount} analysierten Mails</span>
                </div>
                <div className={`suggestion-metric error ${suggestionStats.errorCount === 0 ? 'empty' : ''}`}>
                  <span className="label">Fehler</span>
                  <strong>{suggestionStats.errorCount}</strong>
                  <span className="muted">Mails mit Fehlern</span>
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
              <ul className="suggestion-list">
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
              </ul>
            )}
          </section>
        </main>
      </div>

      <DevtoolsPanel />
    </div>
  )
}
