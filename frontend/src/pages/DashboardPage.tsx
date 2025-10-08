import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AnalysisModule,
  OllamaModelStatus,
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
import CalendarDashboard from '../components/CalendarDashboard'
import { useSuggestions } from '../store/useSuggestions'
import { usePendingOverview } from '../store/usePendingOverview'
import { useAppConfig } from '../store/useAppConfig'
import { useFilterActivity } from '../store/useFilterActivity'
import { useOllamaStatus } from '../store/useOllamaStatus'

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

type DashboardView = 'mail' | 'calendar'

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

const formatBytes = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let remaining = value
  let unitIndex = 0
  while (remaining >= 1024 && unitIndex < units.length - 1) {
    remaining /= 1024
    unitIndex += 1
  }
  return `${remaining.toFixed(remaining >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

const modelLabel = (model: OllamaModelStatus) => {
  if (model.purpose === 'classifier') {
    return 'Klassifikator'
  }
  if (model.purpose === 'embedding') {
    return 'Embeddings'
  }
  return 'Modell'
}

const modelProgressLabel = (model: OllamaModelStatus) => {
  const percent = typeof model.progress === 'number' ? Math.round(model.progress * 100) : null
  const completed = formatBytes(model.download_completed)
  const total = formatBytes(model.download_total)
  if (percent === null && !completed) {
    return model.status ?? 'lädt…'
  }
  const parts: string[] = []
  if (percent !== null) {
    parts.push(`${percent}%`)
  }
  if (completed && total) {
    parts.push(`${completed} / ${total}`)
  }
  if (parts.length === 0 && completed) {
    parts.push(completed)
  }
  return parts.join(' · ')
}

export default function DashboardPage(): JSX.Element {
  const [suggestionScope, setSuggestionScope] = useState<'open' | 'all'>('open')
  const { data: appConfig, error: configError } = useAppConfig()
  const analysisModule: AnalysisModule = appConfig?.analysis_module ?? 'STATIC'
  const configLoaded = Boolean(appConfig)
  const showAutomationCard = configLoaded ? analysisModule !== 'LLM_PURE' : false
  const showLlMSuggestions = configLoaded ? analysisModule !== 'STATIC' : false
  const showPendingPanel = showLlMSuggestions
  const showOllamaCard = showLlMSuggestions
  const { data: suggestions, stats: suggestionStats, loading, error, refresh } = useSuggestions(
    suggestionScope,
    showLlMSuggestions,
  )
  const {
    data: pendingOverview,
    loading: pendingLoading,
    error: pendingError,
    refresh: refreshPendingOverview,
  } = usePendingOverview(showPendingPanel)
  const {
    data: filterActivity,
    loading: filterActivityLoading,
    error: filterActivityError,
    refresh: refreshFilterActivity,
  } = useFilterActivity(showAutomationCard)
  const {
    status: ollamaStatus,
    loading: ollamaLoading,
    error: ollamaError,
    refresh: refreshOllama,
  } = useOllamaStatus(showOllamaCard)
  const [availableFolders, setAvailableFolders] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [folderDraft, setFolderDraft] = useState<string[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [savingFolders, setSavingFolders] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [dashboardView, setDashboardView] = useState<DashboardView>('mail')
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [rescanBusy, setRescanBusy] = useState(false)
  const lastFinishedRef = useRef<string | null>(null)
  const manualFinishedRef = useRef<string | null>(null)
  const scanStateRef = useRef({ auto: false, manual: false })
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

  useEffect(() => {
    const autoActive = Boolean(scanStatus?.active)
    const manualActive = Boolean(scanStatus?.rescan_active || rescanBusy)
    const previous = scanStateRef.current

    if ((autoActive && !previous.auto) || (manualActive && !previous.manual)) {
      void refreshPendingOverview().catch(() => undefined)
    }

    scanStateRef.current = { auto: autoActive, manual: manualActive }
  }, [scanStatus?.active, scanStatus?.rescan_active, rescanBusy, refreshPendingOverview])

  const refreshDashboardIndicators = useCallback(async () => {
    const tasks: Promise<unknown>[] = []
    if (showLlMSuggestions) {
      tasks.push(refresh())
    }
    if (showPendingPanel) {
      tasks.push(refreshPendingOverview())
    }
    if (showAutomationCard) {
      tasks.push(refreshFilterActivity())
    }
    if (tasks.length > 0) {
      await Promise.allSettled(tasks)
    }
  }, [
    refresh,
    refreshFilterActivity,
    refreshPendingOverview,
    showAutomationCard,
    showLlMSuggestions,
    showPendingPanel,
  ])

  const handleStartScan = async () => {
    setScanBusy(true)
    try {
      const normalizedSelection = normalizeFolders(selectedFolders)
      const response = await startScan(normalizedSelection.length ? normalizedSelection : undefined)
      setScanStatus(response.status)
      setStatus({
        kind: response.started ? 'success' : 'info',
        message: response.started ? 'Daueranalyse gestartet.' : 'Daueranalyse läuft bereits.',
      })
      await loadScanStatus()
    } catch (err) {
      setStatus({ kind: 'error', message: `Analyse konnte nicht gestartet werden: ${toMessage(err)}` })
    } finally {
      setScanBusy(false)
      await refreshDashboardIndicators()
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
          ? 'Einzelanalyse gestoppt, Daueranalyse läuft weiter.'
          : 'Einzelanalyse gestoppt.'
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
      await refreshDashboardIndicators()
    }
  }

  const handleRescan = useCallback(async () => {
    setRescanBusy(true)
    try {
      const normalizedSelection = normalizeFolders(selectedFolders)
      const response = await rescan(normalizedSelection.length ? normalizedSelection : undefined)
      if (!response.ok && response.cancelled) {
        setStatus({ kind: 'info', message: 'Einzelanalyse abgebrochen.' })
      } else if (!response.ok) {
        setStatus({ kind: 'error', message: 'Einzelanalyse konnte nicht abgeschlossen werden.' })
      } else {
        const noun = response.new_suggestions === 1 ? 'Vorschlag' : 'Vorschläge'
        setStatus({
          kind: 'success',
          message: `Einzelanalyse abgeschlossen (${response.new_suggestions} ${noun}).`,
        })
      }
      void refresh()
    } catch (err) {
      setStatus({ kind: 'error', message: `Einzelanalyse fehlgeschlagen: ${toMessage(err)}` })
    } finally {
      setRescanBusy(false)
      await loadScanStatus()
      await refreshDashboardIndicators()
    }
  }, [loadScanStatus, refresh, refreshDashboardIndicators, selectedFolders])

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
      await refreshDashboardIndicators()
    } catch (err) {
      setStatus({ kind: 'error', message: `Ordnerauswahl konnte nicht gespeichert werden: ${toMessage(err)}` })
    } finally {
      setSavingFolders(false)
    }
  }, [folderDraft, refreshDashboardIndicators])

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

  const hasSuggestions = suggestions.length > 0
  const showSuggestionLoadingPlaceholder = loading && !hasSuggestions && !suggestionStats
  const showSuggestionEmptyState = !loading && !hasSuggestions
  const isRefreshingSuggestions = loading && hasSuggestions

  const refreshIndicators = useCallback(async () => {
    const tasks: Promise<unknown>[] = []
    if (showLlMSuggestions) {
      tasks.push(refresh())
    }
    if (showPendingPanel) {
      tasks.push(refreshPendingOverview())
    }
    if (showAutomationCard) {
      tasks.push(refreshFilterActivity())
    }
    if (tasks.length > 0) {
      await Promise.allSettled(tasks)
    }
  }, [refresh, refreshFilterActivity, refreshPendingOverview, showAutomationCard, showLlMSuggestions, showPendingPanel])

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
      statusLabel = 'Daueranalyse aktiv'
      statusVariant = 'running'
    } else if (manualActive) {
      statusLabel = 'Einzelanalyse aktiv'
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
        Einzelanalyse: {manualInfo.started}
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
        Einzelanalyse-Fehler: {manualInfo.error}
      </span>,
    )
  }

  useEffect(() => {
    if (dashboardView !== 'mail') {
      return
    }
    if (!scanSummary.autoActive && !scanSummary.manualActive) {
      return
    }
    if (!showAutomationCard && !showPendingPanel && !showLlMSuggestions) {
      return
    }
    void refreshDashboardIndicators()
    const interval = window.setInterval(() => {
      void refreshDashboardIndicators()
    }, 5000)
    return () => {
      window.clearInterval(interval)
    }
  }, [
    dashboardView,
    refreshDashboardIndicators,
    scanSummary.autoActive,
    scanSummary.manualActive,
    showAutomationCard,
    showLlMSuggestions,
    showPendingPanel,
  ])

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
        <div className="analysis-bar">
          <div className="analysis-bar-main">
            <div className="analysis-status">
              <span className={`status-indicator ${scanSummary.statusVariant}`} aria-hidden="true" />
              <div className="analysis-status-text">
                <span className="label">Analyse</span>
                <strong>{scanSummary.statusLabel}</strong>
              </div>
            </div>
            <dl className="analysis-bar-meta">
              <div>
                <dt>Ordner</dt>
                <dd>{scanSummary.folderLabel}</dd>
              </div>
              <div>
                <dt>Intervall</dt>
                <dd>{scanSummary.pollInterval ? `alle ${Math.round(scanSummary.pollInterval)} s` : '–'}</dd>
              </div>
              <div>
                <dt>Einzelanalyse</dt>
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
            {analysisFootEntries.length > 0 && (
              <div className="analysis-bar-foot">{analysisFootEntries}</div>
            )}
          </div>
          <div className="analysis-bar-actions">
            <button
              type="button"
              className="primary"
              onClick={handleRescan}
              disabled={manualActive || autoActive || scanBusy}
            >
              {rescanBusy ? 'Einzelanalyse läuft…' : 'Einzelanalyse starten'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={handleStartScan}
              disabled={scanBusy || autoActive || manualActive}
            >
              {scanBusy && !autoActive ? 'Starte Daueranalyse…' : 'Daueranalyse starten'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={handleStopScan}
              disabled={scanBusy || (!autoActive && !manualActive)}
            >
              {scanBusy && (autoActive || manualActive) ? 'Stoppe Analyse…' : 'Analyse stoppen'}
            </button>
          </div>
        </div>
      </header>
      {dashboardView === 'mail' ? (
        <>
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
          {configLoaded && analysisModule === 'STATIC' && (
            <div className="status-banner info" role="status">
              <span>
                Modul „Statisch“ aktiv: Es werden ausschließlich Keyword-Regeln ausgeführt, KI-Vorschläge und Pending-Listen
                bleiben deaktiviert.
              </span>
            </div>
          )}
          {showOllamaCard && ollamaError && (
            <div className="status-banner error">Ollama-Status konnte nicht geladen werden: {ollamaError}</div>
          )}

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
              {showOllamaCard && (
                <div className={`ollama-status-card ${ollamaStatus?.reachable ? 'ok' : 'error'}`}>
                  <div className="ollama-status-header">
                    <span className="label">Ollama</span>
                    <span className={`indicator ${ollamaStatus?.reachable ? 'online' : 'offline'}`}>
                      {ollamaStatus?.reachable ? 'verbunden' : 'nicht verbunden'}
                    </span>
                  </div>
                  <div className="ollama-status-body">
                    {ollamaLoading && <div className="placeholder">Lade Status…</div>}
                    {!ollamaLoading && ollamaStatus && (
                      <>
                        <div className="host">{ollamaStatus.host}</div>
                        <div className="models">
                          {ollamaStatus.models.length === 0 && <span>Keine Modelle bekannt.</span>}
                          {ollamaStatus.models.map(model => {
                            const progressValue = Math.max(0, Math.min(100, Math.round((model.progress ?? 0) * 100)))
                            return (
                              <div key={model.normalized_name} className="ollama-model">
                                <div className="ollama-model-header">
                                  <span className="model-name">
                                    {modelLabel(model)}: {model.name}
                                  </span>
                                  <span className={`model-state ${model.available ? 'available' : 'missing'}`}>
                                    {model.available ? 'bereit' : model.pulling ? 'lädt…' : 'fehlt'}
                                  </span>
                                </div>
                                {model.pulling && (
                                  <div
                                    className="ollama-progress-bar"
                                    role="progressbar"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={progressValue}
                                  >
                                    <div className="ollama-progress-indicator" style={{ width: `${progressValue}%` }} />
                                  </div>
                                )}
                                <div className="ollama-model-meta">
                                  {model.pulling && <span>{modelProgressLabel(model)}</span>}
                                  {!model.pulling && model.message && <span>{model.message}</span>}
                                  {model.error && <span className="error">{model.error}</span>}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        {ollamaStatus.message && <div className="ollama-note">{ollamaStatus.message}</div>}
                      </>
                    )}
                    {!ollamaLoading && !ollamaStatus && (
                      <div className="placeholder">Keine Ollama-Informationen verfügbar.</div>
                    )}
                  </div>
                  <div className="ollama-status-actions">
                    <button type="button" className="link" onClick={() => refreshOllama()} disabled={ollamaLoading}>
                      Status aktualisieren
                    </button>
                  </div>
                </div>
              )}
            </aside>
            <main className="app-main">
              {showAutomationCard && (
                <AutomationSummaryCard
                  activity={filterActivity}
                  loading={filterActivityLoading}
                  error={filterActivityError}
                  onReload={refreshFilterActivity}
                />
              )}

              {showPendingPanel && (
                <PendingOverviewPanel overview={pendingOverview} loading={pendingLoading} error={pendingError} />
              )}

              {showLlMSuggestions ? (
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
                  {showSuggestionLoadingPlaceholder && (
                    <div className="placeholder">Bitte warten…</div>
                  )}
                  {showSuggestionEmptyState && (
                    <div className="placeholder">
                      {suggestionScope === 'open'
                        ? 'Super! Alles abgearbeitet.'
                        : 'Es liegen noch keine analysierten Vorschläge vor.'}
                    </div>
                  )}
                  {hasSuggestions && (
                    <>
                      {isRefreshingSuggestions && (
                        <div className="refresh-indicator">Aktualisiere…</div>
                      )}
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
                    </>
                  )}
                </section>
              ) : (
                <section className="suggestions">
                  <div className="suggestions-header">
                    <h2>Keine KI-Vorschläge im Statischen Modul</h2>
                  </div>
                  <div className="placeholder">
                    Im Modul „Statisch“ werden neue Nachrichten ausschließlich über Keyword-Regeln verarbeitet. Für manuelle
                    Entscheidungen gibt es daher keine Vorschlagsliste.
                  </div>
                </section>
              )}
            </main>
          </div>
        </>
      ) : (
        <CalendarDashboard />
      )}

      <DevtoolsPanel />
    </div>
  )
}
