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

interface FolderTreeNode {
  name: string
  fullPath: string
  children: FolderTreeNode[]
}

interface MutableFolderNode extends FolderTreeNode {
  map: Map<string, MutableFolderNode>
}

const ensureChild = (
  map: Map<string, MutableFolderNode>,
  segment: string,
  fullPath: string,
): MutableFolderNode => {
  const existing = map.get(segment)
  if (existing) {
    existing.fullPath = fullPath
    return existing
  }
  const node: MutableFolderNode = {
    name: segment,
    fullPath,
    children: [],
    map: new Map(),
  }
  map.set(segment, node)
  return node
}

const buildFolderTree = (folders: string[]): FolderTreeNode[] => {
  const root: Map<string, MutableFolderNode> = new Map()
  const cleaned = folders
    .map(folder => folder.trim())
    .filter(folder => folder.length > 0)
  cleaned.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

  for (const path of cleaned) {
    const segments = path.split('/').filter(segment => segment.trim().length > 0)
    if (!segments.length) {
      continue
    }
    let current = root
    let currentPath = ''
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const node = ensureChild(current, segment, currentPath)
      current = node.map
    }
  }

  const toTree = (map: Map<string, MutableFolderNode>): FolderTreeNode[] =>
    Array.from(map.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(node => ({
        name: node.name,
        fullPath: node.fullPath,
        children: toTree(node.map),
      }))

  return toTree(root)
}

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

  const normalizedAvailable = useMemo(() => normalize(available), [available])
  const trimmedFilter = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!trimmedFilter) {
      return normalizedAvailable
    }
    return normalizedAvailable.filter(folder => folder.toLowerCase().includes(trimmedFilter))
  }, [normalizedAvailable, trimmedFilter])
  const tree = useMemo(() => buildFolderTree(normalizedAvailable), [normalizedAvailable])
  const selectionSet = useMemo(() => new Set(draft), [draft])

  const toggleFolder = (folder: string) => {
    const exists = draft.includes(folder)
    const next = exists ? draft.filter(item => item !== folder) : [...draft, folder]
    onDraftChange(normalize(next))
  }

  const hasSelectionInSubtree = (node: FolderTreeNode): boolean => {
    if (!node.children.length) {
      return false
    }
    return node.children.some(child => selectionSet.has(child.fullPath) || hasSelectionInSubtree(child))
  }

  const renderNode = (node: FolderTreeNode): JSX.Element => {
    const checked = selectionSet.has(node.fullPath)
    const partial = !checked && hasSelectionInSubtree(node)
    return (
      <li key={node.fullPath}>
        <label className={`${checked ? 'checked' : ''}${partial ? ' partial' : ''}`}>
          <input type="checkbox" checked={checked} onChange={() => toggleFolder(node.fullPath)} disabled={saving} />
          <span>{node.name}</span>
        </label>
        {node.children.length > 0 && <ul>{node.children.map(renderNode)}</ul>}
      </li>
    )
  }

  const selectAll = () => onDraftChange(normalize(normalizedAvailable))
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
        trimmedFilter ? (
          <ul className="folder-list">
            {filtered.map(folder => {
              const checked = selectionSet.has(folder)
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
        ) : (
          <ul className="folder-tree">{tree.map(renderNode)}</ul>
        )
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
