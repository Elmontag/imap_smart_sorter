import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  KeywordFilterConfig,
  KeywordFilterField,
  KeywordFilterRuleConfig,
  MoveMode,
  getKeywordFilters,
  getMode,
  setMode,
  updateKeywordFilters,
} from '../api'
import AutomationSummaryCard from '../components/AutomationSummaryCard'
import DevtoolsPanel from '../components/DevtoolsPanel'
import { useAppConfig } from '../store/useAppConfig'
import { useFilterActivity } from '../store/useFilterActivity'

const modeOptions: MoveMode[] = ['DRY_RUN', 'CONFIRM', 'AUTO']

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

type SettingsTab = 'automation' | 'analysis' | 'general'

const fieldOrder: KeywordFilterField[] = ['subject', 'sender', 'body']

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

const parseList = (value: string): string[] => normalizeList(value.split(/[,\n]+/))

export default function SettingsPage(): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('automation')
  const [filterConfig, setFilterConfig] = useState<KeywordFilterConfig | null>(null)
  const [filtersLoading, setFiltersLoading] = useState(true)
  const [filtersSaving, setFiltersSaving] = useState(false)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [mode, setModeState] = useState<MoveMode>('DRY_RUN')
  const [modeBusy, setModeBusy] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)

  const { data: appConfig } = useAppConfig()
  const {
    data: filterActivity,
    loading: activityLoading,
    error: activityError,
    refresh: refreshActivity,
  } = useFilterActivity()

  const loadMode = useCallback(async () => {
    try {
      const response = await getMode()
      setModeState(response.mode)
      setModeError(null)
    } catch (err) {
      setModeError(err instanceof Error ? err.message : 'Modus konnte nicht geladen werden.')
    }
  }, [])

  const loadFilters = useCallback(async () => {
    setFiltersLoading(true)
    try {
      const config = await getKeywordFilters()
      setFilterConfig(config)
      setFilterError(null)
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : 'Filter konnten nicht geladen werden.')
    } finally {
      setFiltersLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMode()
    void loadFilters()
  }, [loadMode, loadFilters])

  const dismissStatus = useCallback(() => setStatus(null), [])

  const updateRule = useCallback(
    (index: number, mutator: (rule: KeywordFilterRuleConfig) => KeywordFilterRuleConfig) => {
      setFilterConfig(current => {
        if (!current) {
          return current
        }
        const nextRules = current.rules.map((rule, idx) => (idx === index ? mutator(rule) : rule))
        return { ...current, rules: nextRules }
      })
    },
    [],
  )

  const handleRuleRemoval = useCallback((index: number) => {
    setFilterConfig(current => {
      if (!current) {
        return current
      }
      const nextRules = current.rules.filter((_, idx) => idx !== index)
      return { ...current, rules: nextRules }
    })
  }, [])

  const handleAddRule = useCallback(() => {
    setFilterConfig(current => {
      if (!current) {
        return { rules: [defaultRule()] }
      }
      return { ...current, rules: [...current.rules, defaultRule()] }
    })
  }, [])

  const handleModeChange = useCallback(
    async (value: MoveMode) => {
      setModeBusy(true)
      try {
        const response = await setMode(value)
        setModeState(response.mode)
        setStatus({ kind: 'success', message: `Modus auf ${response.mode} gesetzt.` })
        setModeError(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Moduswechsel fehlgeschlagen.'
        setStatus({ kind: 'error', message })
        setModeError(message)
      } finally {
        setModeBusy(false)
      }
    },
    [],
  )

  const handleFilterSave = useCallback(async () => {
    if (!filterConfig) {
      return
    }
    const invalid = filterConfig.rules.filter(rule => !rule.name.trim() || !rule.target_folder.trim())
    if (invalid.length > 0) {
      setStatus({ kind: 'error', message: 'Jede Regel benötigt einen Namen und einen Zielordner.' })
      return
    }

    const payload: KeywordFilterConfig = {
      rules: filterConfig.rules.map(rule => ({
        ...rule,
        name: rule.name.trim(),
        description: rule.description?.trim() || undefined,
        target_folder: rule.target_folder.trim(),
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
      })),
    }

    setFiltersSaving(true)
    try {
      const response = await updateKeywordFilters(payload)
      setFilterConfig(response)
      setStatus({ kind: 'success', message: 'Filter gespeichert.' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Filter konnten nicht gespeichert werden.' })
    } finally {
      setFiltersSaving(false)
    }
  }, [filterConfig])

  const modeDescriptions = useMemo<Record<MoveMode, string>>(
    () => ({
      DRY_RUN: 'Verschiebe nichts automatisch, protokolliere nur die Vorschläge.',
      CONFIRM: 'Automatische Moves benötigen eine manuelle Bestätigung im Dashboard.',
      AUTO: 'Filter und KI dürfen Nachrichten eigenständig verschieben.',
    }),
    [],
  )

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
      {modeError && <div className="status-banner error">{modeError}</div>}
      {filterError && <div className="status-banner error">{filterError}</div>}

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
                <button type="button" className="ghost" onClick={handleAddRule}>
                  Regel hinzufügen
                </button>
                <button type="button" className="primary" onClick={handleFilterSave} disabled={filtersSaving}>
                  {filtersSaving ? 'Speichere…' : 'Filter speichern'}
                </button>
              </div>

              {filtersLoading && <div className="placeholder">Lade Filterdefinitionen…</div>}
              {!filtersLoading && filterConfig && filterConfig.rules.length === 0 && (
                <div className="placeholder">
                  Noch keine Regeln vorhanden. Lege die erste Regel über „Regel hinzufügen“ an.
                </div>
              )}

              {!filtersLoading && filterConfig && filterConfig.rules.length > 0 && (
                <div className="filter-rule-list">
                  {filterConfig.rules.map((rule, index) => (
                    <div key={`${rule.name || 'rule'}-${index}`} className="filter-rule-card">
                      <div className="filter-rule-header">
                        <div className="filter-rule-title">
                          <label>
                            <span>Name</span>
                            <input
                              type="text"
                              value={rule.name}
                              onChange={event =>
                                updateRule(index, current => ({ ...current, name: event.target.value }))
                              }
                              placeholder="z. B. Rechnungen 2024"
                            />
                          </label>
                          <label className="inline">
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={event =>
                                updateRule(index, current => ({ ...current, enabled: event.target.checked }))
                              }
                            />
                            Aktiv
                          </label>
                        </div>
                        <button type="button" className="link" onClick={() => handleRuleRemoval(index)}>
                          Entfernen
                        </button>
                      </div>
                      <div className="filter-rule-body">
                        <label>
                          <span>Beschreibung</span>
                          <textarea
                            value={rule.description ?? ''}
                            onChange={event =>
                              updateRule(index, current => ({ ...current, description: event.target.value }))
                            }
                            placeholder="Kurze Erläuterung der Regel"
                          />
                        </label>
                        <label>
                          <span>Zielordner</span>
                          <input
                            type="text"
                            value={rule.target_folder}
                            onChange={event =>
                              updateRule(index, current => ({ ...current, target_folder: event.target.value }))
                            }
                            placeholder="Projekt/2024/Abrechnung"
                          />
                        </label>
                        <div className="filter-columns">
                          <label>
                            <span>Schlüsselwörter</span>
                            <textarea
                              value={rule.match.terms.join('\n')}
                              onChange={event =>
                                updateRule(index, current => ({
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
                              value={rule.tags.join('\n')}
                              onChange={event =>
                                updateRule(index, current => ({
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
                                name={`mode-${index}`}
                                value="all"
                                checked={rule.match.mode === 'all'}
                                onChange={() =>
                                  updateRule(index, current => ({
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
                                name={`mode-${index}`}
                                value="any"
                                checked={rule.match.mode === 'any'}
                                onChange={() =>
                                  updateRule(index, current => ({
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
                                  checked={rule.match.fields.includes(field)}
                                  onChange={() =>
                                    updateRule(index, current => {
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
                                value={rule.date?.after ?? ''}
                                onChange={event =>
                                  updateRule(index, current => ({
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
                                value={rule.date?.before ?? ''}
                                onChange={event =>
                                  updateRule(index, current => ({
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
                  ))}
                </div>
              )}
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
                <h2>Verarbeitungsmodus</h2>
                <p>
                  Der Verarbeitungsmodus bestimmt, wie stark Automatisierung eingreifen darf. Wortfilter greifen immer zuerst und
                  können Nachrichten sofort verschieben; die Auswahl unten steuert, ob anschließende KI-Vorschläge automatisch
                  ausgeführt werden.
                </p>
                <label className="mode-select large">
                  <span>Aktueller Modus</span>
                  <select
                    value={mode}
                    onChange={event => handleModeChange(event.target.value as MoveMode)}
                    disabled={modeBusy}
                  >
                    {modeOptions.map(option => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <ul className="mode-description-list">
                  {modeOptions.map(option => (
                    <li key={option} className={mode === option ? 'active' : ''}>
                      <strong>{option}</strong>
                      <span>{modeDescriptions[option]}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="general-card">
                <h2>Postfach-Tags</h2>
                {appConfig ? (
                  <ul className="tag-summary">
                    <li>
                      <strong>Geschützte Nachrichten</strong>
                      <span>{appConfig.protected_tag ?? 'Nicht gesetzt'}</span>
                    </li>
                    <li>
                      <strong>Verarbeitete Nachrichten</strong>
                      <span>{appConfig.processed_tag ?? 'Nicht gesetzt'}</span>
                    </li>
                    <li>
                      <strong>AI-Tag-Präfix</strong>
                      <span>{appConfig.ai_tag_prefix ?? 'Nicht gesetzt'}</span>
                    </li>
                    <li>
                      <strong>Pending-Limit</strong>
                      <span>
                        {appConfig.pending_list_limit > 0
                          ? `${appConfig.pending_list_limit} Einträge`
                          : 'Kein Limit'}
                      </span>
                    </li>
                  </ul>
                ) : (
                  <div className="placeholder">Konfiguration wird geladen…</div>
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
