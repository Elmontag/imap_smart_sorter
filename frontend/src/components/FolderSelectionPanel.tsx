import React, { useEffect, useMemo, useState } from 'react'

interface Props {
  available: string[]
  draft: string[]
  onDraftChange: (folders: string[]) => void
  onSave: () => Promise<void> | void
  onReload: () => Promise<void> | void
  loading: boolean
  saving: boolean
}

const normalize = (folders: string[]): string[] => Array.from(new Set(folders))

export default function FolderSelectionPanel({
  available,
  draft,
  onDraftChange,
  onSave,
  onReload,
  loading,
  saving,
}: Props): JSX.Element {
  const [filter, setFilter] = useState('')

  useEffect(() => {
    setFilter('')
  }, [available.join('|')])

  const filtered = useMemo(() => {
    const trimmed = filter.trim().toLowerCase()
    if (!trimmed) {
      return available
    }
    return available.filter(folder => folder.toLowerCase().includes(trimmed))
  }, [available, filter])

  const toggleFolder = (folder: string) => {
    const exists = draft.includes(folder)
    const next = exists ? draft.filter(item => item !== folder) : [...draft, folder]
    onDraftChange(normalize(next))
  }

  const selectAll = () => onDraftChange(normalize(available))
  const selectNone = () => onDraftChange([])

  return (
    <section className="folder-panel">
      <div className="panel-header">
        <h2>Überwachte Ordner</h2>
        <div className="panel-actions">
          <button type="button" className="link" onClick={onReload} disabled={loading || saving}>
            Neu laden
          </button>
        </div>
      </div>
      <p className="panel-description">
        Wähle die IMAP-Ordner aus, die beim Scan berücksichtigt werden sollen. Die Auswahl wird gespeichert.
      </p>
      <div className="folder-toolbar">
        <input
          type="search"
          placeholder="Ordner filtern"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          aria-label="Ordner filtern"
          disabled={loading}
        />
        <div className="toolbar-buttons">
          <button type="button" onClick={selectAll} disabled={loading || !available.length}>
            Alle
          </button>
          <button type="button" onClick={selectNone} disabled={loading}>
            Keine
          </button>
        </div>
      </div>
      {loading && <div className="placeholder">Ordner werden geladen…</div>}
      {!loading && !available.length && <div className="placeholder">Keine Ordner verfügbar.</div>}
      {!loading && available.length > 0 && (
        <ul className="folder-list">
          {filtered.map(folder => {
            const checked = draft.includes(folder)
            return (
              <li key={folder}>
                <label className={checked ? 'checked' : undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleFolder(folder)}
                    disabled={saving}
                  />
                  <span>{folder}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <div className="folder-footer">
        <div className="selection-count">Ausgewählt: {draft.length}</div>
        <button type="button" className="primary" onClick={onSave} disabled={saving}>
          {saving ? 'Speichere…' : 'Auswahl speichern'}
        </button>
      </div>
    </section>
  )
}
