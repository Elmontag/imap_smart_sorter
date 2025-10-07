import React, { useMemo } from 'react'
import { KeywordFilterField, KeywordFilterRuleConfig } from '../api'

export interface EditableRuleDraft extends KeywordFilterRuleConfig {
  id: string
}

interface RuleEditorFormProps {
  draft: EditableRuleDraft
  fieldOrder: KeywordFilterField[]
  parseList: (value: string) => string[]
  onChange: (updater: (draft: EditableRuleDraft) => EditableRuleDraft) => void
  tagOptions?: string[]
}

const ensureDateConfig = (draft: EditableRuleDraft) =>
  draft.date ?? { after: null, before: null, include_future: false }

export default function RuleEditorForm({
  draft,
  fieldOrder,
  parseList,
  onChange,
  tagOptions,
}: RuleEditorFormProps): JSX.Element {
  const handleNameChange = (value: string) =>
    onChange(current => ({ ...current, name: value }))

  const handleEnabledChange = (checked: boolean) =>
    onChange(current => ({ ...current, enabled: checked }))

  const handleDescriptionChange = (value: string) =>
    onChange(current => ({ ...current, description: value }))

  const handleTargetChange = (value: string) =>
    onChange(current => ({ ...current, target_folder: value }))

  const handleTermsChange = (value: string) =>
    onChange(current => ({
      ...current,
      match: { ...current.match, terms: parseList(value) },
    }))

  const handleTagsChange = (value: string) =>
    onChange(current => ({ ...current, tags: parseList(value) }))

  const availableTagOptions = useMemo(() => {
    if (!tagOptions || tagOptions.length === 0) {
      return []
    }
    const seen = new Set<string>()
    return tagOptions
      .map(option => option.trim())
      .filter(option => {
        const key = option.toLowerCase()
        if (!option || seen.has(key)) {
          return false
        }
        seen.add(key)
        return true
      })
      .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
  }, [tagOptions])

  const normalizedDraftTags = useMemo(() => {
    const seen = new Set<string>()
    draft.tags.forEach(tag => {
      const trimmed = tag.trim()
      if (trimmed) {
        seen.add(trimmed.toLowerCase())
      }
    })
    return seen
  }, [draft.tags])

  const handleTagToggle = (tag: string) =>
    onChange(current => {
      const normalized = tag.trim()
      if (!normalized) {
        return current
      }
      const lower = normalized.toLowerCase()
      const filtered = current.tags
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0)
      const exists = filtered.some(entry => entry.toLowerCase() === lower)
      const next = exists
        ? filtered.filter(entry => entry.toLowerCase() !== lower)
        : [...filtered, normalized]
      return { ...current, tags: next }
    })

  const handleModeChange = (mode: 'all' | 'any') =>
    onChange(current => ({
      ...current,
      match: { ...current.match, mode },
    }))

  const handleFieldToggle = (field: KeywordFilterField) =>
    onChange(current => {
      const active = new Set(current.match.fields)
      if (active.has(field)) {
        active.delete(field)
      } else {
        active.add(field)
      }
      if (active.size === 0) {
        active.add(field)
      }
      const nextFields = Array.from(active).sort(
        (a, b) => fieldOrder.indexOf(a) - fieldOrder.indexOf(b),
      )
      return {
        ...current,
        match: { ...current.match, fields: nextFields },
      }
    })

  const handleDateChange = (key: 'after' | 'before', value: string) =>
    onChange(current => {
      const date = ensureDateConfig(current)
      return {
        ...current,
        date: {
          ...date,
          [key]: value ? value : null,
        },
      }
    })

  const handleIncludeFutureChange = (checked: boolean) =>
    onChange(current => {
      const date = ensureDateConfig(current)
      return {
        ...current,
        date: { ...date, include_future: checked },
      }
    })

  const dateConfig = ensureDateConfig(draft)

  return (
    <div className="filter-rule-form">
      <div className="filter-rule-primary">
        <label>
          <span>Name</span>
          <input
            type="text"
            value={draft.name}
            onChange={event => handleNameChange(event.target.value)}
            placeholder="z. B. Rechnungen 2024"
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={event => handleEnabledChange(event.target.checked)}
          />
          Aktiv
        </label>
      </div>

      <label>
        <span>Beschreibung</span>
        <textarea
          value={draft.description ?? ''}
          onChange={event => handleDescriptionChange(event.target.value)}
          placeholder="Kurze Erläuterung der Regel"
        />
      </label>

      <label>
        <span>Zielordner</span>
        <input
          type="text"
          value={draft.target_folder}
          onChange={event => handleTargetChange(event.target.value)}
          placeholder="Projekt/2024/Abrechnung"
        />
      </label>

      <div className="filter-columns">
        <label>
          <span>Schlüsselwörter</span>
          <textarea
            value={draft.match.terms.join('\n')}
            onChange={event => handleTermsChange(event.target.value)}
            placeholder="Ein Begriff pro Zeile"
          />
        </label>
        <label>
          <span>Tags</span>
          <textarea
            value={draft.tags.join('\n')}
            onChange={event => handleTagsChange(event.target.value)}
            placeholder="Tag je Zeile, optional"
          />
          {availableTagOptions.length > 0 && (
            <div className="tag-option-chips" role="group" aria-label="Tag-Vorlagen">
              {availableTagOptions.map(option => {
                const active = normalizedDraftTags.has(option.toLowerCase())
                return (
                  <button
                    key={option}
                    type="button"
                    className={`tag-option-chip${active ? ' active' : ''}`}
                    onClick={() => handleTagToggle(option)}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          )}
        </label>
      </div>

      <div className="match-options">
        <fieldset>
          <legend>Match-Bedingung</legend>
          <label>
            <input
              type="radio"
              name={`mode-${draft.id}`}
              value="all"
              checked={draft.match.mode === 'all'}
              onChange={() => handleModeChange('all')}
            />
            Alle Begriffe erforderlich
          </label>
          <label>
            <input
              type="radio"
              name={`mode-${draft.id}`}
              value="any"
              checked={draft.match.mode === 'any'}
              onChange={() => handleModeChange('any')}
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
                checked={draft.match.fields.includes(field)}
                onChange={() => handleFieldToggle(field)}
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
              value={dateConfig.after ?? ''}
              onChange={event => handleDateChange('after', event.target.value)}
            />
          </label>
          <label>
            <span>bis</span>
            <input
              type="date"
              value={dateConfig.before ?? ''}
              onChange={event => handleDateChange('before', event.target.value)}
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={Boolean(dateConfig.include_future)}
              onChange={event => handleIncludeFutureChange(event.target.checked)}
            />
            auch künftige Datumsangaben berücksichtigen
          </label>
        </fieldset>
      </div>
    </div>
  )
}
