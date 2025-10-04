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
import { useSuggestions } from './store/useSuggestions'
import { usePendingOverview } from './store/usePendingOverview'

const modeOptions: MoveMode[] = ['DRY_RUN', 'CONFIRM', 'AUTO']

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

export default function App(): JSX.Element {
  const { data: suggestions, loading, error, refresh } = useSuggestions()
  const { data: pendingOverview, loading: pendingLoading, error: pendingError } = usePendingOverview()
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
    if (!suggestions.length) return 'Keine offenen Vorschläge.'
    return `${suggestions.length} offene Vorschläge`
  }, [loading, suggestions])

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

      {error && <div className="status-banner error">{error}</div>}

      <PendingOverviewPanel overview={pendingOverview} loading={pendingLoading} error={pendingError} />

      <FolderSelectionPanel
        available={availableFolders}
        draft={folderDraft}
        onDraftChange={setFolderDraft}
        onSave={handleFolderSave}
        onReload={loadFolders}
        loading={foldersLoading}
        saving={savingFolders}
      />

      <section className="suggestions">
        <div className="suggestions-header">
          <h2>{headline}</h2>
          <button className="link" type="button" onClick={() => refresh()} disabled={loading}>
            Aktualisieren
          </button>
        </div>
        {loading && <div className="placeholder">Bitte warten…</div>}
        {!loading && !suggestions.length && <div className="placeholder">Super! Alles abgearbeitet.</div>}
        {!loading && suggestions.length > 0 && (
          <div className="suggestion-grid">
            {suggestions.map((item: Suggestion) => (
              <SuggestionCard key={item.message_uid} suggestion={item} onActionComplete={refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
