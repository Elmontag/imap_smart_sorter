import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MoveMode,
  Suggestion,
  getFolders,
  getMode,
  rescan,
  setMode,
  updateFolderSelection,
} from './api'
import SuggestionCard from './components/SuggestionCard'
import PendingOverviewPanel from './components/PendingOverviewPanel'
import FolderSelectionPanel from './components/FolderSelectionPanel'
import DevtoolsPanel from './components/DevtoolsPanel'
import { useSuggestions } from './store/useSuggestions'
import { usePendingOverview } from './store/usePendingOverview'
import { useAppConfig } from './store/useAppConfig'
import TagCanvas from './components/TagCanvas'
import { useTagSuggestions } from './store/useTagSuggestions'

const modeOptions: MoveMode[] = ['DRY_RUN', 'CONFIRM', 'AUTO']

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

export default function App(): JSX.Element {
  const [suggestionScope, setSuggestionScope] = useState<'open' | 'all'>('open')
  const { data: suggestions, stats: suggestionStats, loading, error, refresh } = useSuggestions(suggestionScope)
  const { data: pendingOverview, loading: pendingLoading, error: pendingError } = usePendingOverview()
  const { data: appConfig, error: configError } = useAppConfig()
  const { data: tagSuggestions, loading: tagsLoading, error: tagsError, refresh: refreshTags } = useTagSuggestions()
  const [mode, setModeState] = useState<MoveMode>('DRY_RUN')
  const [availableFolders, setAvailableFolders] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [folderDraft, setFolderDraft] = useState<string[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [savingFolders, setSavingFolders] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [rescanning, setRescanning] = useState(false)

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

  useEffect(() => {
    void loadMode()
    void loadFolders()
  }, [loadMode, loadFolders])

  const handleModeChange = async (value: MoveMode) => {
    try {
      const response = await setMode(value)
      setModeState(response.mode)
      setStatus({ kind: 'success', message: `Modus auf ${response.mode} gesetzt.` })
    } catch (err) {
      setStatus({ kind: 'error', message: `Moduswechsel fehlgeschlagen: ${toMessage(err)}` })
    }
  }

  const handleRescan = async () => {
    setRescanning(true)
    try {
      const scanFolders = selectedFolders.length ? selectedFolders : undefined
      const result = await rescan(scanFolders)
      setStatus({
        kind: 'info',
        message: `Scan abgeschlossen: ${result.new_suggestions} neue Vorschläge.`,
      })
      await refresh()
      await refreshTags()
    } catch (err) {
      setStatus({ kind: 'error', message: `Scan fehlgeschlagen: ${toMessage(err)}` })
    } finally {
      setRescanning(false)
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
    await Promise.all([refresh(), refreshTags()])
  }, [refresh, refreshTags])

  const ollamaInfo = useMemo(() => {
    const status = appConfig?.ollama
    if (!status) {
      return null
    }
    const classifier = status.models.find(model => model.purpose === 'classifier')
    const embedding = status.models.find(model => model.purpose === 'embedding')
    const classifierLabel = classifier
      ? `${classifier.name}${classifier.available ? '' : ' (fehlt)'}`
      : '–'
    const embeddingLabel = embedding
      ? `${embedding.name}${embedding.available ? '' : ' (fehlt)'}`
      : '–'
    return {
      reachable: status.reachable,
      host: status.host,
      message: status.message ?? undefined,
      classifier: classifierLabel,
      embedding: embeddingLabel,
    }
  }, [appConfig])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>IMAP Smart Sorter</h1>
          <p className="app-subline">Intelligente Unterstützung für sauberes Postfach-Management.</p>
        </div>
        <div className="header-actions">
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
          <button className="primary" onClick={handleRescan} disabled={rescanning}>
            {rescanning ? 'Scan läuft…' : 'Neu scannen'}
          </button>
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
            <div
              className={`ollama-status-card ${ollamaInfo.reachable ? 'ok' : 'error'}`}
              title={ollamaInfo.message}
            >
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
          <PendingOverviewPanel overview={pendingOverview} loading={pendingLoading} error={pendingError} />
          <TagCanvas tags={tagSuggestions} loading={tagsLoading} error={tagsError} onReload={refreshTags} />

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
                <div
                  className={`suggestion-metric error ${suggestionStats.errorCount === 0 ? 'empty' : ''}`}
                >
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
