import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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

type NodeField = 'name' | 'description'
type GuidelineField = 'name' | 'description'
type TemplateField = 'name' | 'description'
type TagSlotField = 'name' | 'description'

type GuidelineChange = (templateId: string, guidelineId: string, field: GuidelineField, value: string) => void
type NodeChange = (nodeId: string, field: NodeField, value: string) => void

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

const createFolderNode = (name = 'Neuer Ordner'): FolderNodeDraft => ({
  id: createId(),
  name,
  description: '',
  children: [],
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
interface FolderNodeEditorProps {
  node: FolderNodeDraft
  onChange: NodeChange
  onAddChild: (nodeId: string) => void
  onRemove: (nodeId: string) => void
}

const FolderNodeEditor: React.FC<FolderNodeEditorProps> = ({ node, onChange, onAddChild, onRemove }) => (
  <div className="catalog-node">
    <div className="catalog-node-header">
      <input
        className="catalog-input"
        value={node.name}
        onChange={event => onChange(node.id, 'name', event.target.value)}
        placeholder="Ordnername"
      />
      <div className="node-actions">
        <button type="button" className="ghost" onClick={() => onAddChild(node.id)}>
          Unterordner
        </button>
        <button type="button" className="link danger" onClick={() => onRemove(node.id)}>
          Entfernen
        </button>
      </div>
    </div>
    <textarea
      className="catalog-textarea"
      value={node.description}
      onChange={event => onChange(node.id, 'description', event.target.value)}
      placeholder="Beschreibung"
      rows={2}
    />
    {node.children.length > 0 && (
      <div className="catalog-node-children">
        {node.children.map(child => (
          <FolderNodeEditor key={child.id} node={child} onChange={onChange} onAddChild={onAddChild} onRemove={onRemove} />
        ))}
      </div>
    )}
  </div>
)

interface TemplateEditorProps {
  template: TemplateDraft
  onFieldChange: (templateId: string, field: TemplateField, value: string) => void
  onRemoveTemplate: (templateId: string) => void
  onAddRootChild: (templateId: string) => void
  onAddGuideline: (templateId: string) => void
  onGuidelineChange: GuidelineChange
  onGuidelineRemove: (templateId: string, guidelineId: string) => void
  onNodeChange: NodeChange
  onNodeAddChild: (nodeId: string) => void
  onNodeRemove: (nodeId: string) => void
}

const TemplateEditor: React.FC<TemplateEditorProps> = ({
  template,
  onFieldChange,
  onRemoveTemplate,
  onAddRootChild,
  onAddGuideline,
  onGuidelineChange,
  onGuidelineRemove,
  onNodeChange,
  onNodeAddChild,
  onNodeRemove,
}) => (
  <div className="catalog-card">
    <div className="catalog-card-header">
      <input
        className="catalog-input title"
        value={template.name}
        onChange={event => onFieldChange(template.id, 'name', event.target.value)}
        placeholder="Bereich"
      />
      <div className="catalog-card-actions">
        <button type="button" className="ghost" onClick={() => onAddRootChild(template.id)}>
          Unterordner hinzufügen
        </button>
        <button type="button" className="link danger" onClick={() => onRemoveTemplate(template.id)}>
          Bereich entfernen
        </button>
      </div>
    </div>
    <textarea
      className="catalog-textarea"
      value={template.description}
      onChange={event => onFieldChange(template.id, 'description', event.target.value)}
      placeholder="Beschreibung"
      rows={3}
    />
    <div className="catalog-guidelines">
      <div className="catalog-guidelines-header">
        <h4>Kontext-Tags</h4>
        <button type="button" className="link" onClick={() => onAddGuideline(template.id)}>
          Kontext-Tag hinzufügen
        </button>
      </div>
      {template.tag_guidelines.length === 0 && <div className="muted">Noch keine Kontext-Tags definiert.</div>}
      {template.tag_guidelines.map(guideline => (
        <div key={guideline.id} className="catalog-guideline">
          <input
            className="catalog-input"
            value={guideline.name}
            onChange={event => onGuidelineChange(template.id, guideline.id, 'name', event.target.value)}
            placeholder="Tag-Schlüssel"
          />
          <input
            className="catalog-input"
            value={guideline.description}
            onChange={event => onGuidelineChange(template.id, guideline.id, 'description', event.target.value)}
            placeholder="Beschreibung"
          />
          <button type="button" className="link danger" onClick={() => onGuidelineRemove(template.id, guideline.id)}>
            Entfernen
          </button>
        </div>
      ))}
    </div>
    {template.children.length > 0 && (
      <div className="catalog-node-children">
        {template.children.map(child => (
          <FolderNodeEditor
            key={child.id}
            node={child}
            onChange={onNodeChange}
            onAddChild={onNodeAddChild}
            onRemove={onNodeRemove}
          />
        ))}
      </div>
    )}
  </div>
)

interface TagSlotEditorProps {
  slot: TagSlotDraft
  onFieldChange: (slotId: string, field: TagSlotField, value: string) => void
  onRemove: (slotId: string) => void
  onAddOption: (slotId: string) => void
  onOptionChange: (slotId: string, index: number, value: string) => void
  onOptionRemove: (slotId: string, index: number) => void
  onAddAlias: (slotId: string) => void
  onAliasChange: (slotId: string, index: number, value: string) => void
  onAliasRemove: (slotId: string, index: number) => void
}

const TagSlotEditor: React.FC<TagSlotEditorProps> = ({
  slot,
  onFieldChange,
  onRemove,
  onAddOption,
  onOptionChange,
  onOptionRemove,
  onAddAlias,
  onAliasChange,
  onAliasRemove,
}) => (
  <div className="catalog-card">
    <div className="catalog-card-header">
      <input
        className="catalog-input title"
        value={slot.name}
        onChange={event => onFieldChange(slot.id, 'name', event.target.value)}
        placeholder="Slot-Name"
      />
      <div className="catalog-card-actions">
        <button type="button" className="link danger" onClick={() => onRemove(slot.id)}>
          Slot entfernen
        </button>
      </div>
    </div>
    <textarea
      className="catalog-textarea"
      value={slot.description}
      onChange={event => onFieldChange(slot.id, 'description', event.target.value)}
      placeholder="Beschreibung"
      rows={3}
    />
    <div className="catalog-tag-options">
      <div className="catalog-guidelines-header">
        <h4>Optionen</h4>
        <button type="button" className="link" onClick={() => onAddOption(slot.id)}>
          Option hinzufügen
        </button>
      </div>
      {slot.options.length === 0 && <div className="muted">Keine Optionen definiert.</div>}
      {slot.options.map((option, index) => (
        <div key={`${slot.id}-option-${index}`} className="catalog-option-row">
          <input
            className="catalog-input"
            value={option}
            onChange={event => onOptionChange(slot.id, index, event.target.value)}
            placeholder="Option"
          />
          <button type="button" className="link danger" onClick={() => onOptionRemove(slot.id, index)}>
            Entfernen
          </button>
        </div>
      ))}
    </div>
    <div className="catalog-tag-options">
      <div className="catalog-guidelines-header">
        <h4>Aliase</h4>
        <button type="button" className="link" onClick={() => onAddAlias(slot.id)}>
          Alias hinzufügen
        </button>
      </div>
      {slot.aliases.length === 0 && <div className="muted">Keine alternativen Bezeichner.</div>}
      {slot.aliases.map((alias, index) => (
        <div key={`${slot.id}-alias-${index}`} className="catalog-option-row">
          <input
            className="catalog-input"
            value={alias}
            onChange={event => onAliasChange(slot.id, index, event.target.value)}
            placeholder="Alias"
          />
          <button type="button" className="link danger" onClick={() => onAliasRemove(slot.id, index)}>
            Entfernen
          </button>
        </div>
      ))}
    </div>
  </div>
)
export default function CatalogEditorPage(): JSX.Element {
  const [draft, setDraft] = useState<CatalogDraft | null>(null)
  const [original, setOriginal] = useState<CatalogDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage | null>(null)

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
    setDraft(current => {
      if (!current) {
        return { folder_templates: [createTemplateDraft()], tag_slots: [] }
      }
      return {
        ...current,
        folder_templates: [...current.folder_templates, createTemplateDraft()],
      }
    })
  }, [])

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

  const handleAddRootChild = useCallback((templateId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        folder_templates: current.folder_templates.map(template =>
          template.id === templateId
            ? { ...template, children: [...template.children, createFolderNode('Neuer Ordner')] }
            : template,
        ),
      }
    })
  }, [])

  const handleAddGuideline = useCallback((templateId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        folder_templates: current.folder_templates.map(template =>
          template.id === templateId
            ? { ...template, tag_guidelines: [...template.tag_guidelines, createGuidelineDraft()] }
            : template,
        ),
      }
    })
  }, [])

  const handleGuidelineChange = useCallback<GuidelineChange>((templateId, guidelineId, field, value) => {
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
          return {
            ...template,
            tag_guidelines: template.tag_guidelines.map(guideline =>
              guideline.id === guidelineId ? { ...guideline, [field]: value } : guideline,
            ),
          }
        }),
      }
    })
  }, [])

  const handleGuidelineRemove = useCallback((templateId: string, guidelineId: string) => {
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
          return {
            ...template,
            tag_guidelines: template.tag_guidelines.filter(guideline => guideline.id !== guidelineId),
          }
        }),
      }
    })
  }, [])

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

  const handleNodeAddChild = useCallback((nodeId: string) => {
    setDraft(current => {
      if (!current) {
        return current
      }
      return {
        ...current,
        folder_templates: current.folder_templates.map(template => {
          const updatedChildren = addChildToNode(template.children, nodeId, () => createFolderNode('Neuer Unterordner'))
          return updatedChildren === template.children ? template : { ...template, children: updatedChildren }
        }),
      }
    })
  }, [])

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
    setDraft(current => {
      if (!current) {
        return { folder_templates: [], tag_slots: [createTagSlotDraft()] }
      }
      return {
        ...current,
        tag_slots: [...current.tag_slots, createTagSlotDraft()],
      }
    })
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

      <main className="catalog-main">
        <section className="catalog-section">
          <div className="catalog-section-header">
            <h2>Ordnerkatalog</h2>
            <button type="button" className="ghost" onClick={handleAddTemplate} disabled={saving || loading}>
              Bereich hinzufügen
            </button>
          </div>
          {loading && <div className="placeholder">Katalog wird geladen…</div>}
          {!loading && draft && draft.folder_templates.length === 0 && (
            <div className="placeholder">Noch keine Bereiche definiert.</div>
          )}
          {!loading &&
            draft &&
            draft.folder_templates.map(template => (
              <TemplateEditor
                key={template.id}
                template={template}
                onFieldChange={handleTemplateFieldChange}
                onRemoveTemplate={handleRemoveTemplate}
                onAddRootChild={handleAddRootChild}
                onAddGuideline={handleAddGuideline}
                onGuidelineChange={handleGuidelineChange}
                onGuidelineRemove={handleGuidelineRemove}
                onNodeChange={handleNodeChange}
                onNodeAddChild={handleNodeAddChild}
                onNodeRemove={handleNodeRemove}
              />
            ))}
        </section>

        <section className="catalog-section">
          <div className="catalog-section-header">
            <h2>Tag-Slots</h2>
            <button type="button" className="ghost" onClick={handleAddSlot} disabled={saving || loading}>
              Slot hinzufügen
            </button>
          </div>
          {loading && <div className="placeholder">Lade Tag-Konfiguration…</div>}
          {!loading && draft && draft.tag_slots.length === 0 && (
            <div className="placeholder">Noch keine Tag-Slots definiert.</div>
          )}
          {!loading &&
            draft &&
            draft.tag_slots.map(slot => (
              <TagSlotEditor
                key={slot.id}
                slot={slot}
                onFieldChange={handleSlotFieldChange}
                onRemove={handleRemoveSlot}
                onAddOption={handleAddSlotOption}
                onOptionChange={handleSlotOptionChange}
                onOptionRemove={handleRemoveSlotOption}
                onAddAlias={handleAddSlotAlias}
                onAliasChange={handleSlotAliasChange}
                onAliasRemove={handleRemoveSlotAlias}
              />
            ))}
        </section>
      </main>

      <DevtoolsPanel />
    </div>
  )
}
