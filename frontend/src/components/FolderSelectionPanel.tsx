import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

interface RenderFolderNode extends FolderTreeNode {
  matchesFilter?: boolean
  children: RenderFolderNode[]
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

const cloneTree = (nodes: FolderTreeNode[]): RenderFolderNode[] =>
  nodes.map(node => ({ ...node, children: cloneTree(node.children) }))

const filterTree = (
  nodes: FolderTreeNode[],
  query: string,
): { nodes: RenderFolderNode[]; autoExpand: Set<string> } => {
  if (!query) {
    return { nodes: cloneTree(nodes), autoExpand: new Set() }
  }
  const lower = query.toLowerCase()
  const autoExpand = new Set<string>()

  const visit = (node: FolderTreeNode): { node: RenderFolderNode; expand: boolean } | null => {
    const childResults = node.children
      .map(child => visit(child))
      .filter((child): child is { node: RenderFolderNode; expand: boolean } => Boolean(child))

    const children = childResults.map(child => child.node)
    const matches = node.fullPath.toLowerCase().includes(lower)
    if (!matches && children.length === 0) {
      return null
    }
    const resultNode: RenderFolderNode = { ...node, matchesFilter: matches, children }
    const childRequiresExpansion = childResults.some(child => child.expand)
    const shouldExpand = matches || childRequiresExpansion || children.length > 0
    if (children.length > 0 && shouldExpand) {
      autoExpand.add(node.fullPath)
    }
    return { node: resultNode, expand: shouldExpand }
  }

  const filtered = nodes
    .map(node => visit(node))
    .filter((entry): entry is { node: RenderFolderNode; expand: boolean } => Boolean(entry))
    .map(entry => entry.node)

  return { nodes: filtered, autoExpand }
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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const initialExpansion = useRef(false)

  useEffect(() => {
    setFilter('')
  }, [available.join('|')])

  const normalizedAvailable = useMemo(() => normalize(available), [available])
  const trimmedFilter = filter.trim().toLowerCase()
  const tree = useMemo(() => buildFolderTree(normalizedAvailable), [normalizedAvailable])
  const { nodes: visibleTree, autoExpand } = useMemo(
    () => filterTree(tree, trimmedFilter),
    [tree, trimmedFilter],
  )
  const selectionSet = useMemo(() => new Set(draft), [draft])

  useEffect(() => {
    if (trimmedFilter || initialExpansion.current || !tree.length) {
      return
    }
    initialExpansion.current = true
    setExpandedNodes(current => {
      if (current.size > 0) {
        return current
      }
      const next = new Set<string>()
      tree.forEach(node => next.add(node.fullPath))
      return next
    })
  }, [tree, trimmedFilter])

  useEffect(() => {
    if (trimmedFilter || !draft.length) {
      return
    }
    setExpandedNodes(current => {
      const next = new Set(current)
      draft.forEach(folder => {
        const parts = folder.split('/').filter(Boolean)
        if (parts.length <= 1) {
          return
        }
        let path = ''
        for (let index = 0; index < parts.length - 1; index += 1) {
          path = path ? `${path}/${parts[index]}` : parts[index]
          next.add(path)
        }
      })
      return next
    })
  }, [draft, trimmedFilter])

  useEffect(() => {
    if (!trimmedFilter) {
      return
    }
    setExpandedNodes(current => {
      const next = new Set(current)
      autoExpand.forEach(path => next.add(path))
      return next
    })
  }, [trimmedFilter, autoExpand])

  const toggleExpand = useCallback((path: string) => {
    setExpandedNodes(current => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    const next = new Set<string>()
    const collect = (nodes: FolderTreeNode[]) => {
      nodes.forEach(node => {
        next.add(node.fullPath)
        if (node.children.length > 0) {
          collect(node.children)
        }
      })
    }
    collect(tree)
    setExpandedNodes(next)
  }, [tree])

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set())
  }, [])

  const toggleFolder = (folder: string) => {
    const exists = draft.includes(folder)
    const next = exists ? draft.filter(item => item !== folder) : [...draft, folder]
    onDraftChange(normalize(next))
  }

  const hasSelectionInSubtree = (node: RenderFolderNode): boolean => {
    if (!node.children.length) {
      return false
    }
    return node.children.some(child => selectionSet.has(child.fullPath) || hasSelectionInSubtree(child))
  }

  const renderNode = (node: RenderFolderNode): JSX.Element => {
    const checked = selectionSet.has(node.fullPath)
    const partial = !checked && hasSelectionInSubtree(node)
    const hasChildren = node.children.length > 0
    const expanded = expandedNodes.has(node.fullPath)
    const matched = Boolean(node.matchesFilter)
    const rowClass = `folder-tree-row${checked ? ' checked' : ''}${partial ? ' partial' : ''}${matched ? ' match' : ''}`
    return (
      <li key={node.fullPath}>
        <div className={rowClass}>
          {hasChildren ? (
            <button
              type="button"
              className={`tree-toggle ${expanded ? 'open' : 'closed'}`}
              onClick={() => toggleExpand(node.fullPath)}
              aria-label={expanded ? 'Unterordner einklappen' : 'Unterordner aufklappen'}
              aria-expanded={expanded}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tree-toggle spacer" aria-hidden="true" />
          )}
          <label>
            <input type="checkbox" checked={checked} onChange={() => toggleFolder(node.fullPath)} disabled={saving} />
            <span>{node.name}</span>
          </label>
        </div>
        {hasChildren && expanded && <ul>{node.children.map(renderNode)}</ul>}
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
          {!trimmedFilter && (
            <>
              <button type="button" onClick={expandAll} disabled={loading || !available.length}>
                Aufklappen
              </button>
              <button
                type="button"
                onClick={collapseAll}
                disabled={loading || expandedNodes.size === 0}
              >
                Zuklappen
              </button>
            </>
          )}
        </div>
      </div>
      {loading && <div className="placeholder">Ordner werden geladen…</div>}
      {!loading && !available.length && <div className="placeholder">Keine Ordner verfügbar.</div>}
      {!loading && available.length > 0 && (
        trimmedFilter && visibleTree.length === 0 ? (
          <div className="placeholder">Keine Ordner passen zum Filter.</div>
        ) : (
          <ul className="folder-tree">{visibleTree.map(renderNode)}</ul>
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
