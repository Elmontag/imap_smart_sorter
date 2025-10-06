import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  KeywordFilterConfig,
  KeywordFilterField,
  KeywordFilterRuleConfig,
  MoveMode,
  getKeywordFilters,
  updateKeywordFilters,
  updateAppConfig,
} from '../api'
import AutomationSummaryCard from '../components/AutomationSummaryCard'
import CatalogEditor from '../components/CatalogEditor'
import DevtoolsPanel from '../components/DevtoolsPanel'
import { useAppConfig } from '../store/useAppConfig'
import { useFilterActivity } from '../store/useFilterActivity'

const modeOptions: MoveMode[] = ['DRY_RUN', 'CONFIRM', 'AUTO']
const fieldOrder: KeywordFilterField[] = ['subject', 'sender', 'body']

const createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const defaultRule = (): KeywordFilterRuleConfig => ({
  name: '',
  description: '',
  enabled: true,
  target_folder: '',
  tags: [],
  match: { mode: 'all', fields: [...fieldOrder], terms: [] },
  date: { after: null, before: null },
})

const normalizeList = (values: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  values.forEach(value => {
    const trimmed = value.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      result.push(trimmed)
    }
  })
  return result
}

const parseList = (value: string): string[] => normalizeList(value.split(/[\n,]+/))

type SettingsTab = 'automation' | 'catalog' | 'analysis' | 'general'

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

interface RuleDraft extends KeywordFilterRuleConfig {
  id: string
}

interface RuleTemplateDefinition {
  id: string
  label: string
  description: string
  create: () => KeywordFilterRuleConfig
}

interface ConfigDraft {
  mode: MoveMode
  classifierModel: string
  protectedTag: string
  processedTag: string
  aiTagPrefix: string
}

const ruleTemplates: RuleTemplateDefinition[] = [
  {
    id: 'newsletter-tech',
    label: 'Newsletter – Technik',
    description: 'Fängt Technik-Newsletter und sortiert sie in einen dedizierten Ordner.',
    create: () => {
      const base = defaultRule()
      return {
        ...base,
        name: 'Newsletter Technik',
        description: 'Automatische Ablage von Technik-Updates und Produktnews.',
        target_folder: 'Newsletter/Technik',
        tags: ['newsletter', 'technik'],
        match: {
          mode: 'any',
          fields: ['subject', 'sender'],
          terms: ['newsletter', 'technik', 'update', 'abo'],
        },
      }
    },
  },
  {
    id: 'newsletter-fashion',
    label: 'Newsletter – Mode',
    description: 'Bündelt Mode- und Lifestyle-Newsletter.',
    create: () => {
      const base = defaultRule()
      return {
        ...base,
        name: 'Newsletter Mode',
        description: 'Sortiert Mode-Newsletter automatisch in einen Sammelordner.',
        target_folder: 'Newsletter/Mode',
        tags: ['newsletter', 'mode'],
        match: {
          mode: 'any',
          fields: ['subject', 'sender'],
          terms: ['newsletter', 'mode', 'fashion', 'lookbook', 'trend'],
        },
      }
    },
  },
  {
    id: 'newsletter-food',
    label: 'Newsletter – Lebensmittel',
    description: 'Sammelt Rezepte, Wochenangebote und Food-Newsletter.',
    create: () => {
      const base = defaultRule()
      return {
        ...base,
        name: 'Newsletter Lebensmittel',
        description: 'Lebensmittel-Newsletter landen zuverlässig im passenden Ordner.',
        target_folder: 'Newsletter/Lebensmittel',
        tags: ['newsletter', 'lebensmittel'],
        match: {
          mode: 'any',
          fields: ['subject', 'sender'],
          terms: ['newsletter', 'rezept', 'angebot', 'lebensmittel', 'wochenangebot'],
        },
      }
    },
  },
  {
    id: 'orders',
    label: 'Bestellungen & Rechnungen',
    description: 'Erkennt Bestellbestätigungen, Rechnungen und Versandbenachrichtigungen.',
    create: () => {
      const base = defaultRule()
      return {
        ...base,
        name: 'Bestellungen & Rechnungen',
        description: 'Sortiert Bestell- und Rechnungs-Mails nach Händler in einen Sammelordner.',
        target_folder: 'Finanzen/Bestellungen',
        tags: ['bestellung', 'rechnung'],
        match: {
          mode: 'any',
          fields: ['subject', 'sender', 'body'],
          terms: [
            'rechnung',
            'bestellung',
            'versandbestätigung',
            'amazon',
            'otto',
            'mediamarkt',
            'saturn',
            'lieferung',
          ],
        },
      }
    },
  },
  {
    id: 'events',
    label: 'Konzerte & Veranstaltungen',
    description: 'Fängt Ticketbestätigungen und Event-Hinweise für kommende Termine ab.',
    create: () => {
      const base = defaultRule()
      return {
        ...base,
        name: 'Konzerte & Veranstaltungen',
        description: 'Ticketbestätigungen werden gesammelt und bleiben bis zum Event verfügbar.',
        target_folder: 'Events/Konzerte',
        tags: ['event', 'konzert'],
        match: {
          mode: 'any',
          fields: ['subject', 'body'],
          terms: ['eventim', 'ticketmaster', 'konzert', 'veranstaltung', 'tickets', 'tour'],
        },
      }
    },
  },
  {
    id: 'calendar',
    label: 'Kalendereinladungen',
    description: 'Behandelt Termineinladungen und ICS-Dateien als priorisierte Aufgaben.',
    create: () => {
      const base = defaultRule()
      return {
        ...base,
        name: 'Kalendereinladungen',
        description: 'Sammelt Einladungen mit Kalendereinträgen an einem Ort.',
        target_folder: 'Termine/Eingehend',
        tags: ['kalender', 'termin'],
        match: {
          mode: 'any',
          fields: ['subject', 'body'],
          terms: ['kalender', 'termin', 'einladung', '.ics', 'calendar', 'invite'],
        },
      }
    },
  },
]

const modeDescriptions = {
  DRY_RUN: 'Verschiebe nichts automatisch, protokolliere nur die Vorschläge.',
  CONFIRM: 'Automatische Moves benötigen eine manuelle Bestätigung im Dashboard.',
  AUTO: 'Filter und KI dürfen Nachrichten eigenständig verschieben.',
} as const

export default function SettingsPage(): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('automation')
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>([])
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null)
  const [filtersLoading, setFiltersLoading] = useState(true)
  const [filtersSaving, setFiltersSaving] = useState(false)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({
    mode: 'DRY_RUN',
    classifierModel: '',
    protectedTag: '',
    processedTag: '',
    aiTagPrefix: '',
  })
  const [configSaving, setConfigSaving] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const {
    data: appConfig,
    loading: appConfigLoading,
    error: appConfigError,
    refresh: refreshAppConfig,
  } = useAppConfig()
  const {
    data: filterActivity,
    loading: activityLoading,
    error: activityError,
    refresh: refreshActivity,
  } = useFilterActivity()

  const loadFilters = useCallback(async () => {
    setFiltersLoading(true)
    try {
      const config = await getKeywordFilters()
      const drafts = config.rules.map(rule => ({ ...rule, id: createId() }))
      setRuleDrafts(drafts)
      setSelectedRuleId(drafts.length > 0 ? drafts[0].id : null)
      setFilterError(null)
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : 'Filter konnten nicht geladen werden.')
    } finally {
      setFiltersLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFilters()
  }, [loadFilters])

  useEffect(() => {
    if (!appConfig) {
      return
    }
    setConfigDraft({
      mode: appConfig.mode,
      classifierModel: appConfig.classifier_model ?? '',
      protectedTag: appConfig.protected_tag ?? '',
      processedTag: appConfig.processed_tag ?? '',
      aiTagPrefix: appConfig.ai_tag_prefix ?? '',
    })
  }, [appConfig])

  const selectedRule = useMemo(
    () => (selectedRuleId ? ruleDrafts.find(rule => rule.id === selectedRuleId) ?? null : null),
    [ruleDrafts, selectedRuleId],
  )

  const classifierOptions = useMemo(
    () =>
      (appConfig?.ollama?.models || [])
        .filter(model => model.purpose === 'classifier' && model.name)
        .map(model => model.name),
    [appConfig?.ollama?.models],
  )

  const configDirty = useMemo(() => {
    if (!appConfig) {
      return false
    }
    return (
      configDraft.mode !== appConfig.mode ||
      configDraft.classifierModel.trim() !== (appConfig.classifier_model ?? '').trim() ||
      configDraft.protectedTag.trim() !== (appConfig.protected_tag ?? '').trim() ||
      configDraft.processedTag.trim() !== (appConfig.processed_tag ?? '').trim() ||
      configDraft.aiTagPrefix.trim() !== (appConfig.ai_tag_prefix ?? '').trim()
    )
  }, [appConfig, configDraft])

  const dismissStatus = useCallback(() => setStatus(null), [])

  const updateRule = useCallback((id: string, mutator: (rule: RuleDraft) => RuleDraft) => {
    setRuleDrafts(current => current.map(rule => (rule.id === id ? mutator(rule) : rule)))
  }, [])

  const handleRuleRemoval = useCallback(
    (id: string) => {
      setRuleDrafts(current => {
        const filtered = current.filter(rule => rule.id !== id)
        if (selectedRuleId === id) {
          if (filtered.length === 0) {
            setSelectedRuleId(null)
          } else {
            const removedIndex = current.findIndex(rule => rule.id === id)
            const fallbackIndex = Math.min(Math.max(removedIndex - 1, 0), filtered.length - 1)
            setSelectedRuleId(filtered[fallbackIndex].id)
          }
        }
        return filtered
      })
    },
    [selectedRuleId],
  )

  const handleAddRule = useCallback(() => {
    const draft: RuleDraft = { ...defaultRule(), id: createId() }
    setRuleDrafts(current => [...current, draft])
    setSelectedRuleId(draft.id)
  }, [])

  const handleAddTemplate = useCallback((template: RuleTemplateDefinition) => {
    const draft: RuleDraft = { ...template.create(), id: createId() }
    setRuleDrafts(current => [...current, draft])
    setSelectedRuleId(draft.id)
    setStatus({ kind: 'info', message: `Template „${template.label}“ hinzugefügt. Passe Name und Zielordner an.` })
  }, [])

  const handleFilterSave = useCallback(async () => {
    if (ruleDrafts.length === 0) {
      setStatus({ kind: 'info', message: 'Keine Regeln zu speichern.' })
      return
    }
    const payload: KeywordFilterConfig = {
      rules: ruleDrafts.map(rule => {
        const trimmedName = rule.name.trim()
        const trimmedFolder = rule.target_folder.trim()
        return {
          name: trimmedName,
          description: rule.description?.trim() || undefined,
          enabled: rule.enabled,
          target_folder: trimmedFolder,
          tags: normalizeList(rule.tags),
          match: {
            ...rule.match,
            mode: rule.match.mode,
            fields: rule.match.fields.length ? rule.match.fields : [...fieldOrder],
            terms: normalizeList(rule.match.terms),
          },
          date:
            rule.date && (rule.date.after || rule.date.before)
              ? { after: rule.date.after || null, before: rule.date.before || null }
              : undefined,
        }
      }),
    }
    const invalid = payload.rules.filter(rule => !rule.name || !rule.target_folder)
    if (invalid.length > 0) {
      setStatus({ kind: 'error', message: 'Jede Regel benötigt einen Namen und einen Zielordner.' })
      return
    }
    const selectedIndex = selectedRuleId
      ? ruleDrafts.findIndex(rule => rule.id === selectedRuleId)
      : ruleDrafts.length - 1
    setFiltersSaving(true)
    try {
      const response = await updateKeywordFilters(payload)
      const drafts = response.rules.map(rule => ({ ...rule, id: createId() }))
      setRuleDrafts(drafts)
      if (drafts.length === 0) {
        setSelectedRuleId(null)
      } else {
        const safeIndex = Math.min(Math.max(selectedIndex, 0), drafts.length - 1)
        setSelectedRuleId(drafts[safeIndex].id)
      }
      setStatus({ kind: 'success', message: 'Filter gespeichert.' })
      setFilterError(null)
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Filter konnten nicht gespeichert werden.',
      })
    } finally {
      setFiltersSaving(false)
    }
  }, [ruleDrafts, selectedRuleId])

  const handleConfigChange = useCallback(
    (field: keyof ConfigDraft, value: string | MoveMode) => {
      setConfigDraft(current => ({ ...current, [field]: value }))
    },
    [],
  )

  const handleConfigSave = useCallback(async () => {
    if (!configDraft.classifierModel.trim()) {
      setStatus({ kind: 'error', message: 'Das Sprachmodell darf nicht leer sein.' })
      return
    }
    setConfigSaving(true)
    try {
      const response = await updateAppConfig({
        mode: configDraft.mode,
        classifier_model: configDraft.classifierModel.trim(),
        protected_tag: configDraft.protectedTag.trim() || null,
        processed_tag: configDraft.processedTag.trim() || null,
        ai_tag_prefix: configDraft.aiTagPrefix.trim() || null,
      })
      setConfigDraft({
        mode: response.mode,
        classifierModel: response.classifier_model,
        protectedTag: response.protected_tag ?? '',
        processedTag: response.processed_tag ?? '',
        aiTagPrefix: response.ai_tag_prefix ?? '',
      })
      setStatus({ kind: 'success', message: 'Konfiguration gespeichert.' })
      setConfigError(null)
      await refreshAppConfig()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Konfiguration konnte nicht gespeichert werden.'
      setStatus({ kind: 'error', message })
      setConfigError(message)
    } finally {
      setConfigSaving(false)
    }
  }, [configDraft, refreshAppConfig])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-top">
          <div>
            <h1>Einstellungen</h1>
            <p className="app-subline">Passe Automatisierung, KI-Verhalten und Betriebsmodus fein an.</p>
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
      {filterError && <div className="status-banner error">{filterError}</div>}
      {configError && <div className="status-banner error">{configError}</div>}
      {appConfigError && <div className="status-banner error">{appConfigError}</div>}

      <div className="settings-layout">
        <aside className="settings-sidebar">
          <button
            type="button"
            className={`settings-tab ${activeTab === 'automation' ? 'active' : ''}`}
            onClick={() => setActiveTab('automation')}
          >
            Automatisierung
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'catalog' ? 'active' : ''}`}
            onClick={() => setActiveTab('catalog')}
          >
            Katalog
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'analysis' ? 'active' : ''}`}
            onClick={() => setActiveTab('analysis')}
          >
            KI & Tags
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            Betrieb
          </button>
        </aside>
        <main className="settings-content">
          {activeTab === 'automation' && (
            <div className="settings-section">
              <AutomationSummaryCard
                activity={filterActivity}
                loading={activityLoading}
                error={activityError}
                onReload={refreshActivity}
              />

              <div className="settings-actions">
                <button type="button" className="ghost" onClick={() => void loadFilters()} disabled={filtersLoading}>
                  {filtersLoading ? 'Lade…' : 'Neu laden'}
                </button>
                <button type="button" className="ghost" onClick={handleAddRule} disabled={filtersSaving}>
                  Leere Regel
                </button>
                <button type="button" className="primary" onClick={handleFilterSave} disabled={filtersSaving}>
                  {filtersSaving ? 'Speichere…' : 'Filter speichern'}
                </button>
              </div>

              <div className="automation-editor">
                <aside className="rule-list">
                  <div className="rule-list-header">
                    <h2>Regeln</h2>
                  </div>
                  {filtersLoading && <div className="placeholder">Lade Filterdefinitionen…</div>}
                  {!filtersLoading && ruleDrafts.length === 0 && (
                    <div className="placeholder">
                      Noch keine Regeln vorhanden. Lege die erste Regel über „Leere Regel“ oder eine Vorlage an.
                    </div>
                  )}
                  {!filtersLoading && ruleDrafts.length > 0 && (
                    <ul>
                      {ruleDrafts.map(rule => (
                        <li key={rule.id}>
                          <button
                            type="button"
                            className={`rule-list-item${rule.id === selectedRuleId ? ' active' : ''}`}
                            onClick={() => setSelectedRuleId(rule.id)}
                          >
                            <span className="rule-name">{rule.name || 'Unbenannte Regel'}</span>
                            <span className="rule-folder">{rule.target_folder || 'Kein Zielordner'}</span>
                            {!rule.enabled && <span className="rule-status">Deaktiviert</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="rule-templates">
                    <h3>Vorlagen</h3>
                    <ul>
                      {ruleTemplates.map(template => (
                        <li key={template.id}>
                          <button
                            type="button"
                            className="template-button"
                            onClick={() => handleAddTemplate(template)}
                            disabled={filtersSaving}
                          >
                            <strong>{template.label}</strong>
                            <span>{template.description}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </aside>

                <section className="rule-detail">
                  {filtersLoading && <div className="placeholder">Wähle eine Regel aus, sobald die Definition geladen ist.</div>}
                  {!filtersLoading && !selectedRule && (
                    <div className="placeholder">Wähle links eine Regel aus oder lege eine neue an.</div>
                  )}
                  {!filtersLoading && selectedRule && (
                    <div className="filter-rule-card" key={selectedRule.id}>
                      <div className="filter-rule-header">
                        <div className="filter-rule-title">
                          <label>
                            <span>Name</span>
                            <input
                              type="text"
                              value={selectedRule.name}
                              onChange={event =>
                                updateRule(selectedRule.id, current => ({ ...current, name: event.target.value }))
                              }
                              placeholder="z. B. Rechnungen 2024"
                            />
                          </label>
                          <label className="inline">
                            <input
                              type="checkbox"
                              checked={selectedRule.enabled}
                              onChange={event =>
                                updateRule(selectedRule.id, current => ({ ...current, enabled: event.target.checked }))
                              }
                            />
                            Aktiv
                          </label>
                        </div>
                        <button
                          type="button"
                          className="link"
                          onClick={() => handleRuleRemoval(selectedRule.id)}
                          disabled={filtersSaving}
                        >
                          Entfernen
                        </button>
                      </div>
                      <div className="rule-card-body">
                        <label>
                          <span>Beschreibung</span>
                          <textarea
                            value={selectedRule.description ?? ''}
                            onChange={event =>
                              updateRule(selectedRule.id, current => ({ ...current, description: event.target.value }))
                            }
                            placeholder="Kurze Erläuterung der Regel"
                          />
                        </label>
                        <label>
                          <span>Zielordner</span>
                          <input
                            type="text"
                            value={selectedRule.target_folder}
                            onChange={event =>
                              updateRule(selectedRule.id, current => ({ ...current, target_folder: event.target.value }))
                            }
                            placeholder="Projekt/2024/Abrechnung"
                          />
                        </label>
                        <div className="filter-columns">
                          <label>
                            <span>Schlüsselwörter</span>
                            <textarea
                              value={selectedRule.match.terms.join('\n')}
                              onChange={event =>
                                updateRule(selectedRule.id, current => ({
                                  ...current,
                                  match: { ...current.match, terms: parseList(event.target.value) },
                                }))
                              }
                              placeholder="Ein Begriff pro Zeile"
                            />
                          </label>
                          <label>
                            <span>Tags</span>
                            <textarea
                              value={selectedRule.tags.join('\n')}
                              onChange={event =>
                                updateRule(selectedRule.id, current => ({
                                  ...current,
                                  tags: parseList(event.target.value),
                                }))
                              }
                              placeholder="Tag je Zeile, optional"
                            />
                          </label>
                        </div>
                        <div className="match-options">
                          <fieldset>
                            <legend>Match-Bedingung</legend>
                            <label>
                              <input
                                type="radio"
                                name={`mode-${selectedRule.id}`}
                                value="all"
                                checked={selectedRule.match.mode === 'all'}
                                onChange={() =>
                                  updateRule(selectedRule.id, current => ({
                                    ...current,
                                    match: { ...current.match, mode: 'all' },
                                  }))
                                }
                              />
                              Alle Begriffe erforderlich
                            </label>
                            <label>
                              <input
                                type="radio"
                                name={`mode-${selectedRule.id}`}
                                value="any"
                                checked={selectedRule.match.mode === 'any'}
                                onChange={() =>
                                  updateRule(selectedRule.id, current => ({
                                    ...current,
                                    match: { ...current.match, mode: 'any' },
                                  }))
                                }
                              />
                              Ein Begriff genügt
                            </label>
                          </fieldset>
                          <fieldset>
                            <legend>Beobachtete Felder</legend>
                            {fieldOrder.map(field => (
                              <label key={field}>
                                <input
                                  type="checkbox"
                                  checked={selectedRule.match.fields.includes(field)}
                                  onChange={() =>
                                    updateRule(selectedRule.id, current => {
                                      const set = new Set(current.match.fields)
                                      if (set.has(field)) {
                                        set.delete(field)
                                      } else {
                                        set.add(field)
                                      }
                                      if (set.size === 0) {
                                        set.add(field)
                                      }
                                      const nextFields = Array.from(set).sort(
                                        (a, b) => fieldOrder.indexOf(a) - fieldOrder.indexOf(b),
                                      )
                                      return {
                                        ...current,
                                        match: { ...current.match, fields: nextFields },
                                      }
                                    })
                                  }
                                />
                                {field === 'subject' && 'Betreff'}
                                {field === 'sender' && 'Absender'}
                                {field === 'body' && 'Inhalt'}
                              </label>
                            ))}
                          </fieldset>
                          <fieldset>
                            <legend>Datumsfenster</legend>
                            <label>
                              <span>ab</span>
                              <input
                                type="date"
                                value={selectedRule.date?.after ?? ''}
                                onChange={event =>
                                  updateRule(selectedRule.id, current => ({
                                    ...current,
                                    date: {
                                      after: event.target.value || null,
                                      before: current.date?.before ?? null,
                                    },
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>bis</span>
                              <input
                                type="date"
                                value={selectedRule.date?.before ?? ''}
                                onChange={event =>
                                  updateRule(selectedRule.id, current => ({
                                    ...current,
                                    date: {
                                      after: current.date?.after ?? null,
                                      before: event.target.value || null,
                                    },
                                  }))
                                }
                              />
                            </label>
                          </fieldset>
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {activeTab === 'catalog' && (
            <div className="settings-section">
              <CatalogEditor embedded showDevtools={false} />
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="settings-section">
              <section className="analysis-card">
                <h2>Ollama & Modelle</h2>
                {appConfig?.ollama ? (
                  <div className={`ollama-status-card ${appConfig.ollama.reachable ? 'ok' : 'error'}`}>
                    <div className="ollama-status-header">
                      <span className="label">Host</span>
                      <span className={`indicator ${appConfig.ollama.reachable ? 'online' : 'offline'}`}>
                        {appConfig.ollama.reachable ? 'verbunden' : 'offline'}
                      </span>
                    </div>
                    <div className="ollama-status-body">
                      <div className="host">{appConfig.ollama.host}</div>
                      <div className="models">
                        {appConfig.ollama.models.map(model => (
                          <span key={model.name}>
                            {model.purpose === 'classifier' ? 'Klassifikator' : 'Embeddings'}: {model.name}
                            {!model.available && ' (fehlt)'}
                          </span>
                        ))}
                      </div>
                      {appConfig.ollama.message && <div className="ollama-note">{appConfig.ollama.message}</div>}
                    </div>
                  </div>
                ) : (
                  <div className="placeholder">Keine Ollama-Informationen verfügbar.</div>
                )}
              </section>
              <section className="analysis-card">
                <h2>Tag-Slots & Kontext</h2>
                {appConfig ? (
                  <div className="tag-overview">
                    <div>
                      <h3>Tag-Slots</h3>
                      {appConfig.tag_slots.length === 0 && <div className="placeholder">Keine Tag-Slots definiert.</div>}
                      {appConfig.tag_slots.length > 0 && (
                        <ul>
                          {appConfig.tag_slots.map(slot => (
                            <li key={slot.name}>
                              <strong>{slot.name}</strong>
                              {slot.description && <span className="muted"> – {slot.description}</span>}
                              {slot.options.length > 0 && (
                                <span className="muted"> ({slot.options.length} Optionen)</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h3>Kontext-Tags</h3>
                      {appConfig.context_tags.length === 0 && (
                        <div className="placeholder">Keine kontextuellen Tags im Katalog.</div>
                      )}
                      {appConfig.context_tags.length > 0 && (
                        <ul>
                          {appConfig.context_tags.slice(0, 10).map(tag => (
                            <li key={`${tag.folder}-${tag.name}`}>
                              <strong>{tag.name}</strong>
                              <span className="muted"> – {tag.folder}</span>
                              {tag.description && <div className="muted">{tag.description}</div>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {appConfig.context_tags.length > 10 && (
                        <div className="muted">… und {appConfig.context_tags.length - 10} weitere.</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="placeholder">Konfiguration wird geladen…</div>
                )}
              </section>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="settings-section">
              <section className="general-card">
                <h2>Verarbeitungsmodus & Modell</h2>
                <div className="config-grid">
                  <label className="mode-select large">
                    <span>Verarbeitungsmodus</span>
                    <select
                      value={configDraft.mode}
                      onChange={event => handleConfigChange('mode', event.target.value as MoveMode)}
                      disabled={configSaving || appConfigLoading}
                    >
                      {modeOptions.map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mode-select large">
                    <span>Sprachmodell</span>
                    <input
                      type="text"
                      list="classifier-models"
                      value={configDraft.classifierModel}
                      onChange={event => handleConfigChange('classifierModel', event.target.value)}
                      placeholder="z. B. llama3"
                      disabled={configSaving}
                    />
                    <datalist id="classifier-models">
                      {classifierOptions.map(option => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                  </label>
                </div>
                <div className="config-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={handleConfigSave}
                    disabled={!configDirty || configSaving}
                  >
                    {configSaving ? 'Speichere…' : 'Konfiguration speichern'}
                  </button>
                </div>
                <ul className="mode-description-list">
                  {modeOptions.map(option => (
                    <li key={option} className={configDraft.mode === option ? 'active' : ''}>
                      <strong>{option}</strong>
                      <span>{modeDescriptions[option]}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="general-card">
                <h2>Postfach-Tags</h2>
                <div className="config-grid">
                  <label>
                    <span>Geschützte Nachrichten</span>
                    <input
                      type="text"
                      value={configDraft.protectedTag}
                      onChange={event => handleConfigChange('protectedTag', event.target.value)}
                      placeholder={'z. B. "Wichtig"'}
                      disabled={configSaving}
                    />
                  </label>
                  <label>
                    <span>Verarbeitete Nachrichten</span>
                    <input
                      type="text"
                      value={configDraft.processedTag}
                      onChange={event => handleConfigChange('processedTag', event.target.value)}
                      placeholder={'z. B. "Archiviert"'}
                      disabled={configSaving}
                    />
                  </label>
                  <label>
                    <span>AI-Tag-Präfix</span>
                    <input
                      type="text"
                      value={configDraft.aiTagPrefix}
                      onChange={event => handleConfigChange('aiTagPrefix', event.target.value)}
                      placeholder="z. B. SmartSorter"
                      disabled={configSaving}
                    />
                  </label>
                </div>
                {appConfig && (
                  <ul className="tag-summary">
                    <li>
                      <strong>Pending-Limit</strong>
                      <span>
                        {appConfig.pending_list_limit > 0
                          ? `${appConfig.pending_list_limit} Einträge`
                          : 'Kein Limit'}
                      </span>
                    </li>
                    <li>
                      <strong>Dev-Modus</strong>
                      <span>{appConfig.dev_mode ? 'aktiv' : 'deaktiviert'}</span>
                    </li>
                  </ul>
                )}
              </section>
            </div>
          )}
        </main>
      </div>

      <DevtoolsPanel />
    </div>
  )
}
