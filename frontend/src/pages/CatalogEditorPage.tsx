import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import {
  CatalogDefinition,
  FolderChildConfig,
  FolderTemplateConfig,
  TagSlotConfig,
  getCatalogDefinition,
  updateCatalogDefinition,
} from '../api'
import DevtoolsPanel from '../components/DevtoolsPanel'

const createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

interface FolderNodeDraft {
  id: string
  name: string
  description: string
  children: FolderNodeDraft[]
  tag_guidelines: TagGuidelineDraft[]
}

interface TagGuidelineDraft {
  id: string
  name: string
  description: string
}

interface TemplateDraft {
  id: string
  name: string
  description: string
  children: FolderNodeDraft[]
  tag_guidelines: TagGuidelineDraft[]
}

interface TagSlotDraft {
  id: string
  name: string
  description: string
  options: string[]
  aliases: string[]
}

interface CatalogDraft {
  folder_templates: TemplateDraft[]
  tag_slots: TagSlotDraft[]
}

type SelectedFolder =
  | { kind: 'template'; templateId: string }
  | { kind: 'node'; templateId: string; nodeId: string }

type NodeField = 'name' | 'description'
type GuidelineField = 'name' | 'description'
type TemplateField = 'name' | 'description'
type TagSlotField = 'name' | 'description'

type GuidelineChange = (guidelineId: string, field: GuidelineField, value: string) => void
type NodeChange = (nodeId: string, field: NodeField, value: string) => void

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

const createFolderNode = (name = 'Neuer Ordner'): FolderNodeDraft => ({
  id: createId(),
  name,
  description: '',
  children: [],
  tag_guidelines: [],
})

const createTemplateDraft = (): TemplateDraft => ({
  id: createId(),
  name: 'Neuer Bereich',
  description: '',
  children: [],
  tag_guidelines: [],
})

const createGuidelineDraft = (): TagGuidelineDraft => ({
  id: createId(),
  name: '',
  description: '',
})

const createTagSlotDraft = (): TagSlotDraft => ({
  id: createId(),
  name: 'Neuer Slot',
  description: '',
  options: [],
  aliases: [],
})

const toNodeDraft = (node: FolderChildConfig): FolderNodeDraft => ({
  id: createId(),
  name: node.name,
  description: node.description ?? '',
  children: (node.children ?? []).map(toNodeDraft),
  tag_guidelines: (node.tag_guidelines ?? []).map(guideline => ({
    id: createId(),
    name: guideline.name,
    description: guideline.description ?? '',
  })),
})

const toTemplateDraft = (template: FolderTemplateConfig): TemplateDraft => ({
  id: createId(),
  name: template.name,
  description: template.description ?? '',
  children: template.children.map(toNodeDraft),
  tag_guidelines: template.tag_guidelines.map(guideline => ({
    id: createId(),
    name: guideline.name,
    description: guideline.description ?? '',
  })),
})

const toTagSlotDraft = (slot: TagSlotConfig): TagSlotDraft => ({
  id: createId(),
  name: slot.name,
  description: slot.description ?? '',
  options: [...slot.options],
  aliases: [...slot.aliases],
})

const toDraft = (definition: CatalogDefinition): CatalogDraft => ({
  folder_templates: definition.folder_templates.map(toTemplateDraft),
  tag_slots: definition.tag_slots.map(toTagSlotDraft),
})

const normalizeNodeConfig = (node: FolderChildConfig): FolderChildConfig => ({
  name: node.name.trim(),
  description: (node.description ?? '').trim(),
  tag_guidelines: (node.tag_guidelines ?? [])
    .map(guideline => ({
      name: guideline.name.trim(),
      description: (guideline.description ?? '').trim(),
    }))
    .filter(guideline => guideline.name.length > 0),
  children: (node.children ?? []).map(normalizeNodeConfig),
})

const normalizeCatalog = (definition: CatalogDefinition): CatalogDefinition => ({
  folder_templates: definition.folder_templates.map(template => ({
    name: template.name.trim(),
    description: (template.description ?? '').trim(),
    children: template.children.map(normalizeNodeConfig),
    tag_guidelines: template.tag_guidelines
      .map(guideline => ({
        name: guideline.name.trim(),
        description: (guideline.description ?? '').trim(),
      }))
      .filter(guideline => guideline.name.length > 0),
  })),
  tag_slots: definition.tag_slots.map(slot => ({
    name: slot.name.trim(),
    description: (slot.description ?? '').trim(),
    options: slot.options.map(option => option.trim()).filter(option => option.length > 0),
    aliases: (slot.aliases ?? []).map(alias => alias.trim()).filter(alias => alias.length > 0),
  })),
})

const nodeDraftToConfig = (node: FolderNodeDraft): FolderChildConfig => ({
  name: node.name,
  description: node.description,
  tag_guidelines: node.tag_guidelines.map(guideline => ({
    name: guideline.name,
    description: guideline.description,
  })),
  children: node.children.map(nodeDraftToConfig),
})

const draftToPayload = (draft: CatalogDraft): CatalogDefinition =>
  normalizeCatalog({
    folder_templates: draft.folder_templates.map(template => ({
      name: template.name,
      description: template.description,
      children: template.children.map(nodeDraftToConfig),
      tag_guidelines: template.tag_guidelines.map(guideline => ({
        name: guideline.name,
        description: guideline.description,
      })),
    })),
    tag_slots: draft.tag_slots.map(slot => ({
      name: slot.name,
      description: slot.description,
      options: [...slot.options],
      aliases: [...slot.aliases],
    })),
  })

const updateNodeList = (
  nodes: FolderNodeDraft[],
  nodeId: string,
  updater: (node: FolderNodeDraft) => FolderNodeDraft,
): FolderNodeDraft[] => {
  let changed = false
  const updated = nodes.map(node => {
    if (node.id === nodeId) {
      changed = true
      return updater(node)
    }
    if (!node.children.length) {
      return node
    }
    const updatedChildren = updateNodeList(node.children, nodeId, updater)
    if (updatedChildren !== node.children) {
      changed = true
      return { ...node, children: updatedChildren }
    }
    return node
  })
  return changed ? updated : nodes
}

const addChildToNode = (
  nodes: FolderNodeDraft[],
  nodeId: string,
  factory: () => FolderNodeDraft,
): FolderNodeDraft[] =>
  updateNodeList(nodes, nodeId, node => ({ ...node, children: [...node.children, factory()] }))

const removeNodeById = (nodes: FolderNodeDraft[], nodeId: string): FolderNodeDraft[] => {
  let changed = false
  const filtered = nodes.filter(node => {
    if (node.id === nodeId) {
      changed = true
      return false
    }
    return true
  })
  const updated = filtered.map(node => {
    if (!node.children.length) {
      return node
    }
    const updatedChildren = removeNodeById(node.children, nodeId)
    if (updatedChildren !== node.children) {
      changed = true
      return { ...node, children: updatedChildren }
    }
    return node
  })
  return changed ? updated : nodes
}

const findNodeById = (nodes: FolderNodeDraft[], nodeId: string): FolderNodeDraft | null => {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node
    }
    const child = findNodeById(node.children, nodeId)
    if (child) {
      return child
    }
  }
  return null
}

const findNodePath = (
  nodes: FolderNodeDraft[],
  nodeId: string,
  trail: FolderNodeDraft[] = [],
): FolderNodeDraft[] => {
  for (const node of nodes) {
    const nextTrail = [...trail, node]
    if (node.id === nodeId) {
      return nextTrail
    }
    const result = findNodePath(node.children, nodeId, nextTrail)
    if (result.length > 0) {
      return result
    }
  }
  return []
}
export default function CatalogEditorPage(): JSX.Element {
  const [draft, setDraft] = useState<CatalogDraft | null>(null)
  const [original, setOriginal] = useState<CatalogDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [selectedFolder, setSelectedFolder] = useState<SelectedFolder | null>(null)
  const [folderNavExpanded, setFolderNavExpanded] = useState<Set<string>>(new Set())
  const [selectedTagSlotId, setSelectedTagSlotId] = useState<string | null>(null)

  const loadCatalog = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getCatalogDefinition()
      const normalized = normalizeCatalog(response)
      setOriginal(normalized)
      setDraft(toDraft(normalized))
      setLoadError(null)
    } catch (err) {
      setLoadError(toMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const selectFolder = useCallback((selection: SelectedFolder) => {
    setSelectedFolder(selection)
    setFolderNavExpanded(current => {
      const next = new Set(current)
      next.add(selection.templateId)
      if (selection.kind === 'node') {
        next.add(selection.nodeId)
      }
      return next
    })
  }, [])

  const toggleNavExpand = useCallback((id: string) => {
    setFolderNavExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!draft) {
      setSelectedFolder(null)
      setSelectedTagSlotId(null)
      setFolderNavExpanded(new Set())
      return
    }

    setFolderNavExpanded(current => {
      const valid = new Set<string>()
      const collect = (nodes: FolderNodeDraft[]) => {
        nodes.forEach(node => {
          valid.add(node.id)
          if (node.children.length > 0) {
            collect(node.children)
          }
        })
      }
      draft.folder_templates.forEach(template => {
        valid.add(template.id)
        collect(template.children)
      })
      const next = new Set<string>()
      current.forEach(id => {
        if (valid.has(id)) {
          next.add(id)
        }
      })
      if (next.size === current.size) {
        let identical = true
        current.forEach(id => {
          if (!next.has(id)) {
            identical = false
          }
        })
        if (identical) {
          return current
        }
      }
      return next
    })

    if (!selectedFolder) {
      if (draft.folder_templates.length > 0) {
        selectFolder({ kind: 'template', templateId: draft.folder_templates[0].id })
      }
    } else {
      const template = draft.folder_templates.find(item => item.id === selectedFolder.templateId)
      if (!template) {
        if (draft.folder_templates.length > 0) {
          selectFolder({ kind: 'template', templateId: draft.folder_templates[0].id })
        } else {
          setSelectedFolder(null)
        }
      } else if (selectedFolder.kind === 'node') {
        const nodeExists = Boolean(findNodeById(template.children, selectedFolder.nodeId))
        if (!nodeExists) {
          selectFolder({ kind: 'template', templateId: template.id })
        }
      }
    }

    if (!selectedTagSlotId) {
      if (draft.tag_slots.length > 0) {
        setSelectedTagSlotId(draft.tag_slots[0].id)
      }
    } else if (!draft.tag_slots.some(slot => slot.id === selectedTagSlotId)) {
      if (draft.tag_slots.length > 0) {
        setSelectedTagSlotId(draft.tag_slots[0].id)
      } else {
        setSelectedTagSlotId(null)
      }
    }
  }, [draft, selectedFolder, selectedTagSlotId, selectFolder])

  const currentPayload = useMemo(() => (draft ? draftToPayload(draft) : null), [draft])

  const isDirty = useMemo(() => {
    if (!currentPayload || !original) {
      return false
    }
    return JSON.stringify(currentPayload) !== JSON.stringify(original)
  }, [currentPayload, original])

  const handleTemplateFieldChange = useCallback(
    (templateId: string, field: TemplateField, value: string) => {
      setDraft(current => {
        if (!current) {
          return current
        }
        return {
          ...current,
          folder_templates: current.folder_templates.map(template =>
            template.id === templateId ? { ...template, [field]: value } : template,
          ),
        }
      })
    },
    [],
  )

  const handleAddTemplate = useCallback(() => {
    const template = createTemplateDraft()
    setDraft(current => {
      if (!current) {
        return { folder_templates: [template], tag_slots: [] }
      }
      return {
        ...current,
        folder_templates: [...current.folder_templates, template],
      }
    })
    selectFolder({ kind: 'template', templateId: template.id })
  }, [selectFolder])

  const handleRemoveTemplate = useCallback((templateId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        folder_templates: current.folder_templates.filter(template => template.id !== templateId),
      }
    })
  }, [])

  const handleAddRootChild = useCallback(
    (templateId: string) => {
      const child = createFolderNode('Neuer Ordner')
      setDraft(current => {
        if (!current) {
          return current
        }
        return {
          ...current,
          folder_templates: current.folder_templates.map(template =>
            template.id === templateId
              ? { ...template, children: [...template.children, child] }
              : template,
          ),
        }
      })
      selectFolder({ kind: 'node', templateId, nodeId: child.id })
    },
    [selectFolder],
  )

  const updateSelectedGuidelines = useCallback(
    (mutator: (guidelines: TagGuidelineDraft[]) => TagGuidelineDraft[]) => {
      setDraft(current => {
        if (!current || !selectedFolder) {
          return current
        }
        return {
          ...current,
          folder_templates: current.folder_templates.map(template => {
            if (template.id !== selectedFolder.templateId) {
              return template
            }
            if (selectedFolder.kind === 'template') {
              return {
                ...template,
                tag_guidelines: mutator(template.tag_guidelines),
              }
            }
            return {
              ...template,
              children: updateNodeList(template.children, selectedFolder.nodeId, node => ({
                ...node,
                tag_guidelines: mutator(node.tag_guidelines),
              })),
            }
          }),
        }
      })
    },
    [selectedFolder],
  )

  const handleGuidelineAdd = useCallback(() => {
    updateSelectedGuidelines(guidelines => [...guidelines, createGuidelineDraft()])
  }, [updateSelectedGuidelines])

  const handleGuidelineChange = useCallback<GuidelineChange>((guidelineId, field, value) => {
    updateSelectedGuidelines(guidelines =>
      guidelines.map(guideline => (guideline.id === guidelineId ? { ...guideline, [field]: value } : guideline)),
    )
  }, [updateSelectedGuidelines])

  const handleGuidelineRemove = useCallback((guidelineId: string) => {
    updateSelectedGuidelines(guidelines => guidelines.filter(guideline => guideline.id !== guidelineId))
  }, [updateSelectedGuidelines])

  const handleNodeChange = useCallback<NodeChange>((nodeId, field, value) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        folder_templates: current.folder_templates.map(template => {
          const updatedChildren = updateNodeList(template.children, nodeId, node => ({
            ...node,
            [field]: value,
          }))
          return updatedChildren === template.children ? template : { ...template, children: updatedChildren }
        }),
      }
    })
  }, [])

  const handleNodeAddChild = useCallback(
    (templateId: string, nodeId: string) => {
      const child = createFolderNode('Neuer Unterordner')
      setDraft(current => {
        if (!current) {
          return current
        }
        return {
          ...current,
          folder_templates: current.folder_templates.map(template => {
            if (template.id !== templateId) {
              return template
            }
            const updatedChildren = addChildToNode(template.children, nodeId, () => child)
            return updatedChildren === template.children ? template : { ...template, children: updatedChildren }
          }),
        }
      })
      selectFolder({ kind: 'node', templateId, nodeId: child.id })
    },
    [selectFolder],
  )

  const handleNodeRemove = useCallback((nodeId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        folder_templates: current.folder_templates.map(template => {
          const updatedChildren = removeNodeById(template.children, nodeId)
          return updatedChildren === template.children ? template : { ...template, children: updatedChildren }
        }),
      }
    })
  }, [])

  const handleAddSlot = useCallback(() => {
    const slot = createTagSlotDraft()
    setDraft(current => {
      if (!current) {
        return { folder_templates: [], tag_slots: [slot] }
      }
      return {
        ...current,
        tag_slots: [...current.tag_slots, slot],
      }
    })
    setSelectedTagSlotId(slot.id)
  }, [])

  const handleSlotFieldChange = useCallback(
    (slotId: string, field: TagSlotField, value: string) => {
      setDraft(current => {
        if (!current) {
          return current
        }
        return {
          ...current,
          tag_slots: current.tag_slots.map(slot =>
            slot.id === slotId ? { ...slot, [field]: value } : slot,
          ),
        }
      })
    },
    [],
  )

  const handleRemoveSlot = useCallback((slotId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.filter(slot => slot.id !== slotId),
      }
    })
  }, [])

  const handleSlotOptionChange = useCallback((slotId: string, index: number, value: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.map(slot => {
          if (slot.id !== slotId) {
            return slot
          }
          if (index < 0 || index >= slot.options.length) {
            return slot
          }
          const nextOptions = [...slot.options]
          nextOptions[index] = value
          return { ...slot, options: nextOptions }
        }),
      }
    })
  }, [])

  const handleAddSlotOption = useCallback((slotId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.map(slot =>
          slot.id === slotId ? { ...slot, options: [...slot.options, ''] } : slot,
        ),
      }
    })
  }, [])

  const handleRemoveSlotOption = useCallback((slotId: string, index: number) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.map(slot => {
          if (slot.id !== slotId) {
            return slot
          }
          if (index < 0 || index >= slot.options.length) {
            return slot
          }
          return {
            ...slot,
            options: slot.options.filter((_, optionIndex) => optionIndex !== index),
          }
        }),
      }
    })
  }, [])

  const handleSlotAliasChange = useCallback((slotId: string, index: number, value: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.map(slot => {
          if (slot.id !== slotId) {
            return slot
          }
          if (index < 0 || index >= slot.aliases.length) {
            return slot
          }
          const nextAliases = [...slot.aliases]
          nextAliases[index] = value
          return { ...slot, aliases: nextAliases }
        }),
      }
    })
  }, [])

  const handleAddSlotAlias = useCallback((slotId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.map(slot =>
          slot.id === slotId ? { ...slot, aliases: [...slot.aliases, ''] } : slot,
        ),
      }
    })
  }, [])

  const handleRemoveSlotAlias = useCallback((slotId: string, index: number) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        tag_slots: current.tag_slots.map(slot => {
          if (slot.id !== slotId) {
            return slot
          }
          if (index < 0 || index >= slot.aliases.length) {
            return slot
          }
          return {
            ...slot,
            aliases: slot.aliases.filter((_, aliasIndex) => aliasIndex !== index),
          }
        }),
      }
    })
  }, [])

  const selectedTemplate = useMemo(() => {
    if (!draft || !selectedFolder) {
      return null
    }
    return draft.folder_templates.find(template => template.id === selectedFolder.templateId) ?? null
  }, [draft, selectedFolder])

  const selectedNode = useMemo(() => {
    if (!selectedTemplate || !selectedFolder || selectedFolder.kind !== 'node') {
      return null
    }
    return findNodeById(selectedTemplate.children, selectedFolder.nodeId)
  }, [selectedTemplate, selectedFolder])

  const selectedNodePath = useMemo(() => {
    if (!selectedTemplate || !selectedFolder || selectedFolder.kind !== 'node') {
      return []
    }
    return findNodePath(selectedTemplate.children, selectedFolder.nodeId)
  }, [selectedTemplate, selectedFolder])

  const selectedTagSlot = useMemo(() => {
    if (!draft || !selectedTagSlotId) {
      return null
    }
    return draft.tag_slots.find(slot => slot.id === selectedTagSlotId) ?? null
  }, [draft, selectedTagSlotId])

  const selectedGuidelines = useMemo(() => {
    if (!selectedTemplate || !selectedFolder) {
      return []
    }
    if (selectedFolder.kind === 'template') {
      return selectedTemplate.tag_guidelines
    }
    if (selectedNode) {
      return selectedNode.tag_guidelines
    }
    return []
  }, [selectedFolder, selectedNode, selectedTemplate])

  const selectedGuidelinePath = useMemo(() => {
    if (!selectedTemplate || !selectedFolder) {
      return null
    }
    if (selectedFolder.kind === 'template') {
      return selectedTemplate.name || 'Bereich'
    }
    if (!selectedNode) {
      return null
    }
    const segments = selectedNodePath.map(node => node.name || 'Ordner')
    const base = selectedTemplate.name || 'Bereich'
    return [base, ...segments].join(' / ')
  }, [selectedFolder, selectedNode, selectedNodePath, selectedTemplate])

  const canEditGuidelines = useMemo(
    () =>
      Boolean(
        selectedTemplate &&
          selectedFolder &&
          (selectedFolder.kind === 'template' || selectedNode),
      ),
    [selectedFolder, selectedNode, selectedTemplate],
  )

  const renderNavNode = (templateId: string, node: FolderNodeDraft, depth = 1): JSX.Element => {
    const isSelected = selectedFolder?.kind === 'node' && selectedFolder.nodeId === node.id
    const hasChildren = node.children.length > 0
    const expanded = folderNavExpanded.has(node.id)
    return (
      <li key={node.id}>
        <div className={`catalog-nav-item level-${depth}${isSelected ? ' active' : ''}`}>
          {hasChildren ? (
            <button
              type="button"
              className={`tree-toggle ${expanded ? 'open' : 'closed'}`}
              onClick={() => toggleNavExpand(node.id)}
              aria-label={expanded ? 'Unterordner einklappen' : 'Unterordner aufklappen'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tree-toggle spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="catalog-nav-label"
            onClick={() => selectFolder({ kind: 'node', templateId, nodeId: node.id })}
          >
            {node.name || 'Unbenannter Ordner'}
          </button>
        </div>
        {hasChildren && expanded && <ul>{node.children.map(child => renderNavNode(templateId, child, depth + 1))}</ul>}
      </li>
    )
  }

  const renderFolderNav = (template: TemplateDraft): JSX.Element => {
    const hasChildren = template.children.length > 0
    const expanded = folderNavExpanded.has(template.id)
    const isTemplateSelected = selectedFolder?.kind === 'template' && selectedFolder.templateId === template.id
    return (
      <li key={template.id}>
        <div className={`catalog-nav-item level-0${isTemplateSelected ? ' active' : ''}`}>
          {hasChildren ? (
            <button
              type="button"
              className={`tree-toggle ${expanded ? 'open' : 'closed'}`}
              onClick={() => toggleNavExpand(template.id)}
              aria-label={expanded ? 'Unterordner einklappen' : 'Unterordner aufklappen'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tree-toggle spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="catalog-nav-label"
            onClick={() => selectFolder({ kind: 'template', templateId: template.id })}
          >
            {template.name || 'Unbenannter Bereich'}
          </button>
        </div>
        {hasChildren && expanded && <ul>{template.children.map(child => renderNavNode(template.id, child, 1))}</ul>}
      </li>
    )
  }

  const handleReset = useCallback(() => {
    if (!original) {
      return
    }
    setDraft(toDraft(original))
    setStatus({ kind: 'info', message: 'Änderungen verworfen.' })
  }, [original])

  const handleSave = useCallback(async () => {
    if (!draft) {
      return
    }
    setSaving(true)
    try {
      const payload = draftToPayload(draft)
      const response = await updateCatalogDefinition(payload)
      const normalized = normalizeCatalog(response)
      setOriginal(normalized)
      setDraft(toDraft(normalized))
      setStatus({ kind: 'success', message: 'Katalog gespeichert.' })
      setLoadError(null)
    } catch (err) {
      setStatus({ kind: 'error', message: `Speichern fehlgeschlagen: ${toMessage(err)}` })
    } finally {
      setSaving(false)
    }
  }, [draft])

  const dismissStatus = useCallback(() => setStatus(null), [])

  return (
    <div className="app-shell catalog-shell">
      <header className="app-header">
        <div className="header-top">
          <div>
            <h1>Katalog verwalten</h1>
            <p className="app-subline">Passe Ordnerhierarchie und Tag-Slots direkt an.</p>
          </div>
          <div className="header-actions">
            <Link to="/" className="ghost nav-link">
              Zurück zur Übersicht
            </Link>
            <button type="button" className="ghost" onClick={handleReset} disabled={!isDirty || saving || loading}>
              Änderungen verwerfen
            </button>
            <button type="button" className="primary" onClick={handleSave} disabled={!draft || saving || !isDirty}>
              {saving ? 'Speichere…' : 'Änderungen speichern'}
            </button>
          </div>
        </div>
        <nav className="primary-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Dashboard
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Einstellungen
          </NavLink>
          <NavLink to="/catalog" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Katalog
          </NavLink>
        </nav>
      </header>

      {status && (
        <div className={`status-banner ${status.kind}`} role="status">
          <span>{status.message}</span>
          <button className="link" type="button" onClick={dismissStatus}>
            Schließen
          </button>
        </div>
      )}
      {loadError && <div className="status-banner error">{loadError}</div>}

      <div className="catalog-body">
        <section className="catalog-section folder-section">
          <aside className="catalog-sidebar folder-nav">
            <div className="catalog-sidebar-header">
              <h2>Ordnerkatalog</h2>
              <button type="button" className="ghost" onClick={handleAddTemplate} disabled={saving || loading}>
                Bereich hinzufügen
              </button>
            </div>
            {loading && <div className="placeholder">Katalog wird geladen…</div>}
            {!loading && draft && draft.folder_templates.length === 0 && (
              <div className="placeholder">Noch keine Bereiche definiert.</div>
            )}
            {!loading && draft && draft.folder_templates.length > 0 && (
              <ul className="catalog-tree">{draft.folder_templates.map(renderFolderNav)}</ul>
            )}
          </aside>

          <div className="catalog-content folder-content">
            <div className="catalog-panel folder-detail">
              <div className="catalog-panel-header">
                <h2>Ordnerdetails</h2>
                {selectedTemplate && selectedFolder?.kind === 'template' && (
                  <div className="catalog-panel-actions">
                    <button
                    type="button"
                    className="ghost"
                    onClick={() => handleAddRootChild(selectedTemplate.id)}
                    disabled={saving || loading}
                  >
                    Unterordner hinzufügen
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => handleRemoveTemplate(selectedTemplate.id)}
                    disabled={saving || loading}
                  >
                    Bereich entfernen
                  </button>
                </div>
              )}
              {selectedTemplate && selectedFolder?.kind === 'node' && selectedNode && (
                <div className="catalog-panel-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => handleNodeAddChild(selectedTemplate.id, selectedNode.id)}
                    disabled={saving}
                  >
                    Unterordner hinzufügen
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => handleNodeRemove(selectedNode.id)}
                    disabled={saving}
                  >
                    Ordner entfernen
                  </button>
                </div>
              )}
            </div>
            {loading && <div className="placeholder">Katalog wird geladen…</div>}
            {!loading && !selectedTemplate && (
              <div className="placeholder">Wähle einen Bereich oder Ordner aus der Sidebar.</div>
            )}
            {!loading && selectedTemplate && selectedFolder?.kind === 'template' && (
              <div className="catalog-form">
                <label className="catalog-field">
                  <span>Bereichsname</span>
                  <input
                    className="catalog-input"
                    value={selectedTemplate.name}
                    onChange={event => handleTemplateFieldChange(selectedTemplate.id, 'name', event.target.value)}
                  />
                </label>
                <label className="catalog-field">
                  <span>Beschreibung</span>
                  <textarea
                    className="catalog-textarea"
                    value={selectedTemplate.description}
                    onChange={event => handleTemplateFieldChange(selectedTemplate.id, 'description', event.target.value)}
                    rows={3}
                  />
                </label>
              </div>
            )}
            {!loading && selectedTemplate && selectedFolder?.kind === 'node' && selectedNode && (
              <div className="catalog-form">
                <div className="catalog-breadcrumb">
                  <span>{selectedTemplate.name || 'Bereich'}</span>
                  {selectedNodePath.map(node => (
                    <span key={node.id}>{node.name || 'Ordner'}</span>
                  ))}
                </div>
                <label className="catalog-field">
                  <span>Ordnername</span>
                  <input
                    className="catalog-input"
                    value={selectedNode.name}
                    onChange={event => handleNodeChange(selectedNode.id, 'name', event.target.value)}
                  />
                </label>
                <label className="catalog-field">
                  <span>Beschreibung</span>
                  <textarea
                    className="catalog-textarea"
                    value={selectedNode.description}
                    onChange={event => handleNodeChange(selectedNode.id, 'description', event.target.value)}
                    rows={3}
                  />
                </label>
              </div>
            )}
            {!loading && selectedTemplate && selectedFolder?.kind === 'node' && !selectedNode && (
              <div className="placeholder">Der ausgewählte Ordner konnte nicht gefunden werden.</div>
            )}
            </div>

            <div className="catalog-panel guideline-detail">
              <div className="catalog-panel-header">
                <h2>Kontext-Tags</h2>
                <button
                  type="button"
                  className="link"
                  onClick={handleGuidelineAdd}
                  disabled={saving || loading || !canEditGuidelines}
                >
                  Kontext-Tag hinzufügen
                </button>
              </div>
              {loading && <div className="placeholder">Katalog wird geladen…</div>}
              {!loading && !selectedTemplate && (
                <div className="placeholder">Wähle einen Bereich oder Ordner, um Kontext-Tags zu verwalten.</div>
              )}
              {!loading && selectedTemplate && selectedFolder?.kind === 'node' && !selectedNode && (
                <div className="placeholder">Der ausgewählte Ordner konnte nicht gefunden werden.</div>
              )}
              {!loading && canEditGuidelines && (
                <div className="catalog-guideline-section">
                  {selectedGuidelinePath && (
                    <div className="catalog-guideline-target">
                      <span>{selectedGuidelinePath}</span>
                    </div>
                  )}
                  <div className="catalog-guidelines">
                    {selectedGuidelines.length === 0 && (
                      <div className="muted">Noch keine Kontext-Tags definiert.</div>
                    )}
                    {selectedGuidelines.map(guideline => (
                      <div key={guideline.id} className="catalog-guideline">
                        <input
                          className="catalog-input"
                          value={guideline.name}
                          onChange={event => handleGuidelineChange(guideline.id, 'name', event.target.value)}
                          placeholder="Tag-Schlüssel"
                        />
                        <input
                          className="catalog-input"
                          value={guideline.description}
                          onChange={event =>
                            handleGuidelineChange(guideline.id, 'description', event.target.value)
                          }
                          placeholder="Beschreibung"
                        />
                        <button
                          type="button"
                          className="link danger"
                          onClick={() => handleGuidelineRemove(guideline.id)}
                          disabled={saving}
                        >
                          Entfernen
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="catalog-section tag-section">
          <aside className="catalog-sidebar tag-nav">
            <div className="catalog-sidebar-header">
              <h2>Tag-Slots</h2>
              <button type="button" className="ghost" onClick={handleAddSlot} disabled={saving || loading}>
                Slot hinzufügen
              </button>
            </div>
            {loading && <div className="placeholder">Lade Tag-Konfiguration…</div>}
            {!loading && draft && draft.tag_slots.length === 0 && (
              <div className="placeholder">Noch keine Tag-Slots definiert.</div>
            )}
            {!loading && draft && draft.tag_slots.length > 0 && (
              <ul className="tag-nav-list">
                {draft.tag_slots.map(slot => (
                  <li key={slot.id}>
                    <button
                      type="button"
                      className={`tag-nav-item${selectedTagSlotId === slot.id ? ' active' : ''}`}
                      onClick={() => setSelectedTagSlotId(slot.id)}
                    >
                      {slot.name || 'Unbenannter Slot'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <div className="catalog-content tag-content">
            <div className="catalog-panel tag-detail">
              <div className="catalog-panel-header">
                <h2>Tag-Slot</h2>
                {selectedTagSlot && (
                  <button
                    type="button"
                  className="link danger"
                  onClick={() => handleRemoveSlot(selectedTagSlot.id)}
                  disabled={saving || loading}
                >
                  Slot entfernen
                </button>
              )}
            </div>
            {loading && <div className="placeholder">Lade Tag-Konfiguration…</div>}
            {!loading && !selectedTagSlot && (
              <div className="placeholder">Wähle einen Tag-Slot in der Sidebar aus.</div>
            )}
            {!loading && selectedTagSlot && (
              <div className="catalog-form">
                <label className="catalog-field">
                  <span>Slot-Name</span>
                  <input
                    className="catalog-input"
                    value={selectedTagSlot.name}
                    onChange={event => handleSlotFieldChange(selectedTagSlot.id, 'name', event.target.value)}
                  />
                </label>
                <label className="catalog-field">
                  <span>Beschreibung</span>
                  <textarea
                    className="catalog-textarea"
                    value={selectedTagSlot.description}
                    onChange={event => handleSlotFieldChange(selectedTagSlot.id, 'description', event.target.value)}
                    rows={3}
                  />
                </label>
                <div className="catalog-tag-options">
                  <div className="catalog-guidelines-header">
                    <h3>Optionen</h3>
                    <button
                      type="button"
                      className="link"
                      onClick={() => handleAddSlotOption(selectedTagSlot.id)}
                      disabled={saving}
                    >
                      Option hinzufügen
                    </button>
                  </div>
                  {selectedTagSlot.options.length === 0 && <div className="muted">Keine Optionen definiert.</div>}
                  {selectedTagSlot.options.map((option, index) => (
                    <div key={`${selectedTagSlot.id}-option-${index}`} className="catalog-option-row">
                      <input
                        className="catalog-input"
                        value={option}
                        onChange={event => handleSlotOptionChange(selectedTagSlot.id, index, event.target.value)}
                      />
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => handleRemoveSlotOption(selectedTagSlot.id, index)}
                        disabled={saving}
                      >
                        Entfernen
                      </button>
                    </div>
                  ))}
                </div>
                <div className="catalog-tag-options">
                  <div className="catalog-guidelines-header">
                    <h3>Aliase</h3>
                    <button
                      type="button"
                      className="link"
                      onClick={() => handleAddSlotAlias(selectedTagSlot.id)}
                      disabled={saving}
                    >
                      Alias hinzufügen
                    </button>
                  </div>
                  {selectedTagSlot.aliases.length === 0 && <div className="muted">Keine alternativen Bezeichner.</div>}
                  {selectedTagSlot.aliases.map((alias, index) => (
                    <div key={`${selectedTagSlot.id}-alias-${index}`} className="catalog-option-row">
                      <input
                        className="catalog-input"
                        value={alias}
                        onChange={event => handleSlotAliasChange(selectedTagSlot.id, index, event.target.value)}
                      />
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => handleRemoveSlotAlias(selectedTagSlot.id, index)}
                        disabled={saving}
                      >
                        Entfernen
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              )}
            </div>
          </div>
        </section>
      </div>

      <DevtoolsPanel />
    </div>
  )
}
