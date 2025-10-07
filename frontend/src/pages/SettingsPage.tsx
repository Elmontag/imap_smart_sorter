import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AnalysisModule,
  KeywordFilterConfig,
  KeywordFilterField,
  KeywordFilterRuleConfig,
  TagSlotConfig,
  MoveMode,
  OllamaModelPurpose,
  getKeywordFilters,
  getCalendarSettings,
  updateKeywordFilters,
  updateAppConfig,
  updateCalendarSettings,
  CalendarSettings,
  CalendarSettingsUpdateRequest,
  CalendarConnectionTestRequest,
  testCalendarConnection,
} from '../api'
import AutomationSummaryCard from '../components/AutomationSummaryCard'
import CatalogEditor from '../components/CatalogEditor'
import DevtoolsPanel from '../components/DevtoolsPanel'
import RuleEditorForm, { EditableRuleDraft } from '../components/RuleEditorForm'
import { useAppConfig } from '../store/useAppConfig'
import { useFilterActivity } from '../store/useFilterActivity'
import { useOllamaStatus } from '../store/useOllamaStatus'

const modeOptions: MoveMode[] = ['DRY_RUN', 'CONFIRM', 'AUTO']
const fieldOrder: KeywordFilterField[] = ['subject', 'sender', 'body']
const moduleOptions: AnalysisModule[] = ['STATIC', 'HYBRID', 'LLM_PURE']

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

const createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const baseRuleConfig = (): KeywordFilterRuleConfig => ({
  name: '',
  description: '',
  enabled: true,
  target_folder: '',
  tags: [],
  match: { mode: 'all', fields: [...fieldOrder], terms: [] },
  date: { after: null, before: null, include_future: false },
  tag_future_dates: false,
})

const cloneRuleConfig = (rule: KeywordFilterRuleConfig): KeywordFilterRuleConfig => ({
  name: rule.name,
  description: rule.description ?? '',
  enabled: rule.enabled,
  target_folder: rule.target_folder,
  tags: [...rule.tags],
  match: {
    mode: rule.match.mode,
    fields: [...rule.match.fields],
    terms: [...rule.match.terms],
  },
  date: rule.date
    ? {
        after: rule.date.after ?? null,
        before: rule.date.before ?? null,
        include_future: Boolean(rule.date.include_future),
      }
    : { after: null, before: null, include_future: false },
  tag_future_dates: Boolean(rule.tag_future_dates),
})

const createRuleDraft = (rule?: KeywordFilterRuleConfig): EditableRuleDraft => ({
  ...cloneRuleConfig(rule ?? baseRuleConfig()),
  id: createId(),
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

const sameStringLists = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

type SettingsTab = 'staticRules' | 'catalogFolders' | 'catalogTags' | 'analysis' | 'general' | 'calendar'

const settingsTabs: SettingsTab[] = [
  'staticRules',
  'catalogFolders',
  'catalogTags',
  'analysis',
  'general',
  'calendar',
]

const isSettingsTab = (value: string | null): value is SettingsTab =>
  Boolean(value) && (settingsTabs as readonly string[]).includes(value)

type RuleDraft = EditableRuleDraft
type TemplateDraft = EditableRuleDraft

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

interface ConfigDraft {
  mode: MoveMode
  analysisModule: AnalysisModule
  classifierModel: string
  protectedTag: string
  processedTag: string
  aiTagPrefix: string
}

interface CalendarDraft {
  enabled: boolean
  caldav_url: string
  username: string
  calendar_name: string
  timezone: string
  processed_tag: string
  source_folders: string
  processed_folder: string
  password: string
  clear_password: boolean
}
const defaultTemplateConfigs: KeywordFilterRuleConfig[] = [
  {
    ...baseRuleConfig(),
    name: 'Newsletter Technik',
    description: 'Automatische Ablage von Technik-Updates und Produktnews.',
    target_folder: 'Newsletter/Technik',
    tags: ['newsletter', 'technik'],
    match: {
      mode: 'any',
      fields: ['subject', 'sender'],
      terms: ['newsletter', 'technik', 'update', 'abo'],
    },
  },
  {
    ...baseRuleConfig(),
    name: 'Newsletter Mode',
    description: 'Sortiert Mode-Newsletter automatisch in einen Sammelordner.',
    target_folder: 'Newsletter/Mode',
    tags: ['newsletter', 'mode'],
    match: {
      mode: 'any',
      fields: ['subject', 'sender'],
      terms: ['newsletter', 'mode', 'fashion', 'lookbook', 'trend'],
    },
  },
  {
    ...baseRuleConfig(),
    name: 'Newsletter Lebensmittel',
    description: 'Lebensmittel-Newsletter landen zuverlässig im passenden Ordner.',
    target_folder: 'Newsletter/Lebensmittel',
    tags: ['newsletter', 'lebensmittel'],
    match: {
      mode: 'any',
      fields: ['subject', 'sender'],
      terms: ['newsletter', 'rezept', 'angebot', 'lebensmittel', 'wochenangebot'],
    },
  },
  {
    ...baseRuleConfig(),
    name: 'Bestellungen & Rechnungen',
    description: 'Sortiert Bestell- und Rechnungs-Mails nach Händler in einen Sammelordner.',
    target_folder: 'Finanzen/Bestellungen',
    tags: ['bestellung', 'rechnung'],
    match: {
      mode: 'any',
      fields: ['subject', 'sender', 'body'],
      terms: ['rechnung', 'bestellung', 'versandbestätigung', 'amazon', 'otto', 'mediamarkt', 'saturn', 'lieferung'],
    },
  },
  {
    ...baseRuleConfig(),
    name: 'Konzerte & Veranstaltungen',
    description: 'Ticketbestätigungen werden gesammelt und bleiben bis zum Event verfügbar.',
    target_folder: 'Events/Konzerte',
    tags: ['event', 'konzert'],
    match: {
      mode: 'any',
      fields: ['subject', 'body'],
      terms: ['eventim', 'ticketmaster', 'konzert', 'veranstaltung', 'tickets', 'tour'],
    },
  },
  {
    ...baseRuleConfig(),
    name: 'Kalendereinladungen',
    description: 'Sammelt Einladungen mit Kalendereinträgen an einem Ort.',
    target_folder: 'Termine/Eingehend',
    tags: ['kalender', 'termin'],
    match: {
      mode: 'any',
      fields: ['subject', 'body'],
      terms: ['kalender', 'termin', 'einladung', '.ics', 'calendar', 'invite'],
    },
  },
]

const moduleLabels: Record<AnalysisModule, string> = {
  STATIC: 'Statisch',
  HYBRID: 'Hybrid',
  LLM_PURE: 'LLM Pure',
}

const moduleDescriptions: Record<AnalysisModule, string> = {
  STATIC: 'Nur definierte Regeln laufen – KI-Kontexte werden im Dashboard ausgeblendet.',
  HYBRID: 'Regeln filtern vor und übergeben verbleibende Mails an die KI zur Analyse.',
  LLM_PURE: 'Alle Nachrichten gehen direkt an das LLM – Regelübersichten werden ausgeblendet.',
}

const modeDescriptions = {
  DRY_RUN: 'Verschiebe nichts automatisch, protokolliere nur die Vorschläge.',
  CONFIRM: 'Automatische Moves benötigen eine manuelle Bestätigung im Dashboard.',
  AUTO: 'Filter und KI dürfen Nachrichten eigenständig verschieben.',
} as const

const formatBytes = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

const modelLabel = (purpose: OllamaModelPurpose) => {
  if (purpose === 'classifier') return 'Klassifikator'
  if (purpose === 'embedding') return 'Embeddings'
  return 'Modell'
}

const modelProgressLabel = (
  progress?: number | null,
  completed?: number | null,
  total?: number | null,
  status?: string | null,
) => {
  const percent = typeof progress === 'number' ? Math.round(progress * 100) : null
  const completedLabel = formatBytes(completed)
  const totalLabel = formatBytes(total)
  const parts: string[] = []
  if (percent !== null) {
    parts.push(`${percent}%`)
  }
  if (completedLabel && totalLabel) {
    parts.push(`${completedLabel} / ${totalLabel}`)
  }
  if (parts.length === 0 && completedLabel) {
    parts.push(completedLabel)
  }
  if (parts.length === 0 && status) {
    parts.push(status)
  }
  return parts.join(' · ')
}

export default function SettingsPage(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const tabFromQuery = useMemo<SettingsTab>(() => {
    const params = new URLSearchParams(location.search)
    const requested = params.get('tab')
    return isSettingsTab(requested) ? requested : 'staticRules'
  }, [location.search])
  const [activeTab, setActiveTab] = useState<SettingsTab>(tabFromQuery)
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>([])
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null)
  const [filtersLoading, setFiltersLoading] = useState(true)
  const [filtersSaving, setFiltersSaving] = useState(false)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false)
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false)
  const [ruleTemplates, setRuleTemplates] = useState<TemplateDraft[]>(() =>
    defaultTemplateConfigs.map(config => createRuleDraft(config)),
  )
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({
    mode: 'DRY_RUN',
    analysisModule: 'HYBRID',
    classifierModel: '',
    protectedTag: '',
    processedTag: '',
    aiTagPrefix: '',
  })
  const [configSaving, setConfigSaving] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [calendarConfig, setCalendarConfig] = useState<CalendarSettings | null>(null)
  const [calendarDraft, setCalendarDraft] = useState<CalendarDraft>({
    enabled: false,
    caldav_url: '',
    username: '',
    calendar_name: '',
    timezone: 'Europe/Berlin',
    processed_tag: 'Termin bearbeitet',
    source_folders: '',
    processed_folder: '',
    password: '',
    clear_password: false,
  })
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarSaving, setCalendarSaving] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [calendarHasPassword, setCalendarHasPassword] = useState(false)
  const [calendarTesting, setCalendarTesting] = useState(false)
  const [calendarTestStatus, setCalendarTestStatus] = useState<StatusMessage | null>(null)
  const templateMenuRef = useRef<HTMLDivElement | null>(null)

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
  const ollamaEnabled = Boolean(appConfig?.analysis_module && appConfig.analysis_module !== 'STATIC')
  const {
    status: ollamaStatus,
    loading: ollamaLoading,
    error: ollamaError,
    pullBusy: ollamaPullBusy,
    refresh: refreshOllama,
    pullModel,
    deleteModel,
  } = useOllamaStatus(ollamaEnabled)
  const [pullModelDraft, setPullModelDraft] = useState('')
  const [pullPurpose, setPullPurpose] = useState<OllamaModelPurpose>('classifier')
  const [modelActionFeedback, setModelActionFeedback] = useState<StatusMessage | null>(null)

  useEffect(() => {
    if (tabFromQuery !== activeTab) {
      setActiveTab(tabFromQuery)
    }
  }, [tabFromQuery, activeTab])

  const handleTabChange = useCallback(
    (next: SettingsTab) => {
      setActiveTab(next)
      const params = new URLSearchParams(location.search)
      params.set('tab', next)
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
    },
    [location.pathname, location.search, navigate],
  )

  const loadFilters = useCallback(async () => {
    setFiltersLoading(true)
    try {
      const config = await getKeywordFilters()
      const drafts = config.rules.map(rule => createRuleDraft(rule))
      setRuleDrafts(drafts)
      setSelectedRuleId(drafts.length > 0 ? drafts[0].id : null)
      setFilterError(null)
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : 'Filter konnten nicht geladen werden.')
    } finally {
      setFiltersLoading(false)
    }
  }, [])

  const loadCalendarConfig = useCallback(async () => {
    setCalendarLoading(true)
    try {
      const settings = await getCalendarSettings()
      setCalendarConfig(settings)
      setCalendarHasPassword(Boolean(settings.has_password))
      setCalendarDraft({
        enabled: settings.enabled,
        caldav_url: settings.caldav_url ?? '',
        username: settings.username ?? '',
        calendar_name: settings.calendar_name ?? '',
        timezone: settings.timezone ?? 'Europe/Berlin',
        processed_tag: settings.processed_tag ?? 'Termin bearbeitet',
        source_folders: settings.source_folders?.join('\n') ?? '',
        processed_folder: settings.processed_folder ?? '',
        password: '',
        clear_password: false,
      })
      setCalendarError(null)
      setCalendarTestStatus(null)
    } catch (err) {
      setCalendarError(
        err instanceof Error ? err.message : 'Kalenderkonfiguration konnte nicht geladen werden.',
      )
    } finally {
      setCalendarLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFilters()
    void loadCalendarConfig()
  }, [loadFilters, loadCalendarConfig])

  useEffect(() => {
    setTemplateMenuOpen(false)
    setTemplateManagerOpen(false)
  }, [activeTab])

  useEffect(() => {
    if (!templateManagerOpen) {
      return
    }
    if (ruleTemplates.length === 0) {
      setExpandedTemplateId(null)
      return
    }
    if (!expandedTemplateId || !ruleTemplates.some(template => template.id === expandedTemplateId)) {
      setExpandedTemplateId(ruleTemplates[0].id)
    }
  }, [templateManagerOpen, ruleTemplates, expandedTemplateId])

  useEffect(() => {
    if (!templateMenuOpen) {
      return
    }
    const handleClick = (event: MouseEvent) => {
      if (!templateMenuRef.current) {
        return
      }
      if (!templateMenuRef.current.contains(event.target as Node)) {
        setTemplateMenuOpen(false)
      }
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTemplateMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [templateMenuOpen])

  useEffect(() => {
    if (!appConfig) {
      return
    }
    setConfigDraft({
      mode: appConfig.mode,
      analysisModule: appConfig.analysis_module,
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

  const updateTemplate = useCallback((id: string, mutator: (template: TemplateDraft) => TemplateDraft) => {
    setRuleTemplates(current => current.map(template => (template.id === id ? mutator(template) : template)))
  }, [])

  const classifierOptions = useMemo(() => {
    const models = ollamaStatus?.models ?? []
    const seen = new Set<string>()
    const names: string[] = []
    models.forEach(model => {
      if (model.purpose !== 'classifier') {
        return
      }
      const trimmed = (model.name || '').trim()
      if (trimmed.length === 0 || seen.has(trimmed)) {
        return
      }
      seen.add(trimmed)
      names.push(trimmed)
    })
    const current = (configDraft.classifierModel || '').trim()
    if (current && !seen.has(current)) {
      names.push(current)
    }
    return names
  }, [ollamaStatus?.models, configDraft.classifierModel])

  const tagSlotOptions = useMemo<TagSlotConfig[]>(() => {
    if (!appConfig?.tag_slots) {
      return []
    }
    return appConfig.tag_slots
      .map(slot => {
        const seen = new Set<string>()
        const options = slot.options
          .map(option => option.trim())
          .filter(option => {
            if (!option) {
              return false
            }
            const key = option.toLowerCase()
            if (seen.has(key)) {
              return false
            }
            seen.add(key)
            return true
          })
          .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
        return {
          name: slot.name,
          description: slot.description,
          options,
          aliases: [...slot.aliases],
        }
      })
      .filter(slot => slot.options.length > 0)
  }, [appConfig?.tag_slots])

  const configDirty = useMemo(() => {
    if (!appConfig) {
      return false
    }
    return (
      configDraft.mode !== appConfig.mode ||
      configDraft.analysisModule !== appConfig.analysis_module ||
      configDraft.classifierModel.trim() !== (appConfig.classifier_model ?? '').trim() ||
      configDraft.protectedTag.trim() !== (appConfig.protected_tag ?? '').trim() ||
      configDraft.processedTag.trim() !== (appConfig.processed_tag ?? '').trim() ||
      configDraft.aiTagPrefix.trim() !== (appConfig.ai_tag_prefix ?? '').trim()
    )
  }, [appConfig, configDraft])

  const calendarDirty = useMemo(() => {
    if (!calendarConfig) {
      return false
    }
    if (calendarDraft.enabled !== calendarConfig.enabled) {
      return true
    }
    if (calendarDraft.caldav_url.trim() !== (calendarConfig.caldav_url ?? '').trim()) {
      return true
    }
    if (calendarDraft.username.trim() !== (calendarConfig.username ?? '').trim()) {
      return true
    }
    if (calendarDraft.calendar_name.trim() !== (calendarConfig.calendar_name ?? '').trim()) {
      return true
    }
    if (calendarDraft.timezone.trim() !== (calendarConfig.timezone ?? '').trim()) {
      return true
    }
    if (calendarDraft.processed_tag.trim() !== (calendarConfig.processed_tag ?? '').trim()) {
      return true
    }
    const draftFolders = parseList(calendarDraft.source_folders)
    const storedFolders = normalizeList(
      (calendarConfig.source_folders ?? []).map(folder => folder.trim()),
    )
    if (!sameStringLists(draftFolders, storedFolders)) {
      return true
    }
    if (calendarDraft.processed_folder.trim() !== (calendarConfig.processed_folder ?? '').trim()) {
      return true
    }
    if (calendarDraft.password.trim().length > 0 || calendarDraft.clear_password) {
      return true
    }
    return false
  }, [calendarConfig, calendarDraft])

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
    const draft = createRuleDraft()
    setRuleDrafts(current => [...current, draft])
    setSelectedRuleId(draft.id)
    setTemplateMenuOpen(false)
  }, [])

  const handleApplyTemplate = useCallback(
    (templateId: string) => {
      const template = ruleTemplates.find(item => item.id === templateId)
      if (!template) {
        return
      }
      const draft = createRuleDraft(template)
      setRuleDrafts(current => [...current, draft])
      setSelectedRuleId(draft.id)
      setStatus({
        kind: 'info',
        message: `Vorlage „${template.name || 'Ohne Titel'}“ übernommen. Passe die Details bei Bedarf an.`,
      })
      setTemplateMenuOpen(false)
    },
    [ruleTemplates],
  )

  const handleDuplicateRule = useCallback(
    (id: string) => {
      let nextId: string | null = null
      setRuleDrafts(current => {
        const index = current.findIndex(rule => rule.id === id)
        if (index === -1) {
          return current
        }
        const original = current[index]
        const duplicate = createRuleDraft(original)
        duplicate.name = original.name ? `${original.name} (Kopie)` : 'Unbenannte Regel'
        nextId = duplicate.id
        const next = [...current]
        next.splice(index + 1, 0, duplicate)
        return next
      })
      if (nextId) {
        setSelectedRuleId(nextId)
        setStatus({ kind: 'info', message: 'Regel dupliziert. Prüfe die Kopie vor dem Speichern.' })
      }
    },
    [],
  )

  const handleSaveAsTemplate = useCallback(
    (rule: RuleDraft) => {
      const template = createRuleDraft(rule)
      template.name = rule.name || 'Neue Vorlage'
      setRuleTemplates(current => [...current, template])
      setTemplateManagerOpen(true)
      setExpandedTemplateId(template.id)
      setStatus({
        kind: 'success',
        message: `Regel „${rule.name || 'Ohne Titel'}“ als Vorlage gespeichert.`,
      })
    },
    [],
  )

  const handleAddTemplateDefinition = useCallback(() => {
    const template = createRuleDraft()
    template.name = 'Neue Vorlage'
    setRuleTemplates(current => [...current, template])
    setTemplateManagerOpen(true)
    setExpandedTemplateId(template.id)
  }, [])

  const handleRemoveTemplateDefinition = useCallback((id: string) => {
    setRuleTemplates(current => current.filter(template => template.id !== id))
    setExpandedTemplateId(current => (current === id ? null : current))
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
            rule.date && (rule.date.after || rule.date.before || rule.date.include_future)
              ? {
                  after: rule.date.after || null,
                  before: rule.date.before || null,
                  include_future: Boolean(rule.date.include_future),
                }
              : undefined,
          tag_future_dates: Boolean(rule.tag_future_dates),
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
    (field: keyof ConfigDraft, value: string | MoveMode | AnalysisModule) => {
      setConfigDraft(current => ({ ...current, [field]: value }))
    },
    [],
  )

  const handleModelReload = useCallback(
    async (model: string, purpose: OllamaModelPurpose) => {
      const trimmed = model.trim()
      if (!trimmed) {
        return
      }
      setModelActionFeedback(null)
      try {
        await pullModel(trimmed, purpose)
        setModelActionFeedback({ kind: 'info', message: `Pull für ${trimmed} gestartet.` })
      } catch (err) {
        setModelActionFeedback({ kind: 'error', message: `Pull fehlgeschlagen: ${toMessage(err)}` })
      }
    },
    [pullModel],
  )

  const handleModelDelete = useCallback(
    async (model: string) => {
      const trimmed = model.trim()
      if (!trimmed) {
        return
      }
      if (typeof window !== 'undefined') {
        const confirmed = window.confirm(`Soll das Modell ${trimmed} wirklich gelöscht werden?`)
        if (!confirmed) {
          return
        }
      }
      setModelActionFeedback(null)
      try {
        await deleteModel(trimmed)
        setModelActionFeedback({ kind: 'success', message: `Modell ${trimmed} gelöscht.` })
      } catch (err) {
        setModelActionFeedback({ kind: 'error', message: `Löschen fehlgeschlagen: ${toMessage(err)}` })
      }
    },
    [deleteModel],
  )

  const handlePullSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const trimmed = pullModelDraft.trim()
      if (!trimmed) {
        setModelActionFeedback({ kind: 'error', message: 'Bitte einen Modellnamen angeben.' })
        return
      }
      setModelActionFeedback(null)
      try {
        await pullModel(trimmed, pullPurpose)
        setModelActionFeedback({ kind: 'info', message: `Pull für ${trimmed} gestartet.` })
        setPullModelDraft('')
      } catch (err) {
        setModelActionFeedback({ kind: 'error', message: `Pull fehlgeschlagen: ${toMessage(err)}` })
      }
    },
    [pullModelDraft, pullPurpose, pullModel],
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
        analysis_module: configDraft.analysisModule,
        classifier_model: configDraft.classifierModel.trim(),
        protected_tag: configDraft.protectedTag.trim() || null,
        processed_tag: configDraft.processedTag.trim() || null,
        ai_tag_prefix: configDraft.aiTagPrefix.trim() || null,
      })
      setConfigDraft({
        mode: response.mode,
        analysisModule: response.analysis_module,
        classifierModel: response.classifier_model,
        protectedTag: response.protected_tag ?? '',
        processedTag: response.processed_tag ?? '',
        aiTagPrefix: response.ai_tag_prefix ?? '',
      })
      setStatus({ kind: 'success', message: 'Konfiguration gespeichert.' })
      setConfigError(null)
      await refreshAppConfig()
      await refreshOllama()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Konfiguration konnte nicht gespeichert werden.'
      setStatus({ kind: 'error', message })
      setConfigError(message)
    } finally {
      setConfigSaving(false)
    }
  }, [configDraft, refreshAppConfig])

  const handleCalendarSave = useCallback(async () => {
    const trimmedTimezone = calendarDraft.timezone.trim()
    const trimmedProcessedTag = calendarDraft.processed_tag.trim()
    if (!trimmedTimezone) {
      setStatus({ kind: 'error', message: 'Die Zeitzone darf nicht leer sein.' })
      return
    }
    if (!trimmedProcessedTag) {
      setStatus({ kind: 'error', message: 'Bitte gib einen Tag für importierte Termine an.' })
      return
    }
    const missing: string[] = []
    if (calendarDraft.enabled) {
      if (!calendarDraft.caldav_url.trim()) {
        missing.push('CalDAV-URL')
      }
      if (!calendarDraft.username.trim()) {
        missing.push('Benutzername')
      }
      if (!calendarDraft.calendar_name.trim()) {
        missing.push('Kalendername')
      }
    }
    if (missing.length > 0) {
      const suffix = missing.length > 1 ? 'Bitte fülle folgende Felder aus: ' : 'Bitte fülle folgendes Feld aus: '
      setStatus({ kind: 'error', message: `${suffix}${missing.join(', ')}` })
      return
    }
    const sourceFolders = parseList(calendarDraft.source_folders)
    const processedFolder = calendarDraft.processed_folder.trim()
    setCalendarSaving(true)
    try {
      const payload: CalendarSettingsUpdateRequest = {
        enabled: calendarDraft.enabled,
        caldav_url: calendarDraft.caldav_url.trim(),
        username: calendarDraft.username.trim(),
        calendar_name: calendarDraft.calendar_name.trim(),
        timezone: trimmedTimezone,
        processed_tag: trimmedProcessedTag,
        source_folders: sourceFolders,
        processed_folder: processedFolder,
      }
      const trimmedPassword = calendarDraft.password.trim()
      if (trimmedPassword && !calendarDraft.clear_password) {
        payload.password = trimmedPassword
      }
      if (calendarDraft.clear_password) {
        payload.clear_password = true
      }
      const updated = await updateCalendarSettings(payload)
      setCalendarConfig(updated)
      setCalendarHasPassword(Boolean(updated.has_password))
      setCalendarDraft({
        enabled: updated.enabled,
        caldav_url: updated.caldav_url ?? '',
        username: updated.username ?? '',
        calendar_name: updated.calendar_name ?? '',
        timezone: updated.timezone ?? 'Europe/Berlin',
        processed_tag: updated.processed_tag ?? 'Termin bearbeitet',
        source_folders: updated.source_folders?.join('\n') ?? '',
        processed_folder: updated.processed_folder ?? '',
        password: '',
        clear_password: false,
      })
      setStatus({ kind: 'success', message: 'Kalenderkonfiguration gespeichert.' })
      setCalendarError(null)
      setCalendarTestStatus(null)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Kalenderkonfiguration konnte nicht gespeichert werden.'
      setStatus({ kind: 'error', message })
      setCalendarError(message)
    } finally {
      setCalendarSaving(false)
    }
  }, [calendarDraft])

  const handleCalendarTest = useCallback(async () => {
    const trimmedUrl = calendarDraft.caldav_url.trim()
    const trimmedUser = calendarDraft.username.trim()
    const trimmedCalendar = calendarDraft.calendar_name.trim()
    const trimmedPassword = calendarDraft.password.trim()
    const missing: string[] = []
    if (!trimmedUrl) {
      missing.push('CalDAV-URL')
    }
    if (!trimmedUser) {
      missing.push('Benutzername')
    }
    if (!trimmedCalendar) {
      missing.push('Kalendername')
    }
    if (missing.length > 0) {
      const suffix = missing.length > 1 ? 'Bitte fülle folgende Felder aus: ' : 'Bitte fülle folgendes Feld aus: '
      setCalendarTestStatus({ kind: 'error', message: `${suffix}${missing.join(', ')}` })
      return
    }
    setCalendarTestStatus(null)
    setCalendarTesting(true)
    try {
      const payload: CalendarConnectionTestRequest = {
        caldav_url: trimmedUrl,
        username: trimmedUser,
        calendar_name: trimmedCalendar,
      }
      if (trimmedPassword && !calendarDraft.clear_password) {
        payload.password = trimmedPassword
      } else if (calendarHasPassword && !calendarDraft.clear_password) {
        payload.use_stored_password = true
      }
      const response = await testCalendarConnection(payload)
      const message =
        response.message ??
        (response.ok ? 'Verbindung erfolgreich getestet.' : 'Verbindungstest fehlgeschlagen.')
      setCalendarTestStatus({ kind: response.ok ? 'success' : 'error', message })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verbindungstest fehlgeschlagen.'
      setCalendarTestStatus({ kind: 'error', message })
    } finally {
      setCalendarTesting(false)
    }
  }, [
    calendarDraft.caldav_url,
    calendarDraft.username,
    calendarDraft.calendar_name,
    calendarDraft.password,
    calendarDraft.clear_password,
    calendarHasPassword,
  ])

  useEffect(() => {
    setCalendarTestStatus(null)
  }, [
    calendarDraft.caldav_url,
    calendarDraft.username,
    calendarDraft.calendar_name,
    calendarDraft.password,
    calendarDraft.clear_password,
  ])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-top">
          <div>
            <h1>Einstellungen</h1>
            <p className="app-subline">Passe Automatisierung, KI-Verhalten und Betriebsmodus fein an.</p>
          </div>
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
      {filterError && <div className="status-banner error">{filterError}</div>}
      {configError && <div className="status-banner error">{configError}</div>}
      {appConfigError && <div className="status-banner error">{appConfigError}</div>}

      <div className="settings-shell">
        <nav className="settings-subnav" role="tablist" aria-label="Einstellungen">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'staticRules'}
            className={`settings-tab ${activeTab === 'staticRules' ? 'active' : ''}`}
            onClick={() => handleTabChange('staticRules')}
          >
            Statische Regeln
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'catalogFolders'}
            className={`settings-tab ${activeTab === 'catalogFolders' ? 'active' : ''}`}
            onClick={() => handleTabChange('catalogFolders')}
          >
            Ordnerkatalog
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'catalogTags'}
            className={`settings-tab ${activeTab === 'catalogTags' ? 'active' : ''}`}
            onClick={() => handleTabChange('catalogTags')}
          >
            Tag-Slots
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'analysis'}
            className={`settings-tab ${activeTab === 'analysis' ? 'active' : ''}`}
            onClick={() => handleTabChange('analysis')}
          >
            KI & Tags
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'calendar'}
            className={`settings-tab ${activeTab === 'calendar' ? 'active' : ''}`}
            onClick={() => handleTabChange('calendar')}
          >
            Kalender
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'general'}
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => handleTabChange('general')}
          >
            Betrieb
          </button>
        </nav>
        <main className="settings-content">
          {activeTab === 'staticRules' && (
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
                <div className="template-menu-wrapper" ref={templateMenuRef}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setTemplateMenuOpen(open => !open)}
                    disabled={filtersSaving}
                    aria-expanded={templateMenuOpen}
                  >
                    Neue Regel
                  </button>
                  {templateMenuOpen && (
                    <div className="template-menu" role="menu">
                      <button
                        type="button"
                        className="template-menu-item"
                        onClick={handleAddRule}
                        disabled={filtersSaving}
                        role="menuitem"
                      >
                        Ohne Vorlage starten
                      </button>
                      <div className="template-menu-divider" role="presentation" />
                      <div className="template-menu-list">
                        {ruleTemplates.length === 0 && (
                          <span className="template-menu-empty">Noch keine Vorlagen vorhanden.</span>
                        )}
                        {ruleTemplates.map(template => (
                          <button
                            key={template.id}
                            type="button"
                            className="template-menu-item"
                            onClick={() => handleApplyTemplate(template.id)}
                            disabled={filtersSaving}
                            role="menuitem"
                          >
                            <strong>{template.name || 'Unbenannte Vorlage'}</strong>
                            <span>{template.target_folder || 'Kein Zielordner hinterlegt'}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setTemplateManagerOpen(open => !open)}
                  disabled={filtersSaving}
                >
                  {templateManagerOpen ? 'Vorlagen ausblenden' : 'Vorlagen verwalten'}
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
                    <div className="placeholder">Noch keine Regeln vorhanden. Nutze „Neue Regel“, um zu starten.</div>
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
                          <h2>{selectedRule.name || 'Unbenannte Regel'}</h2>
                          <div className="filter-rule-meta">
                            <span>{selectedRule.target_folder || 'Kein Zielordner'}</span>
                          </div>
                        </div>
                        <div className="filter-rule-actions">
                          <button type="button" className="ghost" onClick={() => handleDuplicateRule(selectedRule.id)}>
                            Regel duplizieren
                          </button>
                          <button type="button" className="ghost" onClick={() => handleSaveAsTemplate(selectedRule)}>
                            Als Vorlage speichern
                          </button>
                          <button type="button" className="link danger" onClick={() => handleRuleRemoval(selectedRule.id)}>
                            Regel löschen
                          </button>
                        </div>
                      </div>
                      <RuleEditorForm
                        draft={selectedRule}
                        fieldOrder={fieldOrder}
                        parseList={parseList}
                        onChange={mutator => updateRule(selectedRule.id, mutator)}
                        tagSlots={tagSlotOptions}
                      />
                    </div>
                  )}

                </section>
              </div>

              {templateManagerOpen && (
                <section className="template-manager">
                  <div className="template-manager-header">
                    <div>
                      <h2>Regelvorlagen</h2>
                      <p className="muted">Passe Vorlagen an oder ergänze neue Muster für häufige Fälle.</p>
                    </div>
                    <div className="template-manager-actions">
                      <button type="button" className="ghost" onClick={handleAddTemplateDefinition}>
                        Vorlage hinzufügen
                      </button>
                      <button type="button" className="link" onClick={() => setTemplateManagerOpen(false)}>
                        Schließen
                      </button>
                    </div>
                  </div>
                  {ruleTemplates.length === 0 && (
                    <div className="placeholder">Noch keine Vorlagen vorhanden. Lege eine neue Vorlage an.</div>
                  )}
                  {ruleTemplates.length > 0 && (
                    <div className="template-list">
                      {ruleTemplates.map(template => (
                        <article className="template-card" key={template.id}>
                          <header className="template-card-header">
                            <button
                              type="button"
                              className={`template-toggle${template.id === expandedTemplateId ? ' open' : ''}`}
                              onClick={() =>
                                setExpandedTemplateId(current => (current === template.id ? null : template.id))
                              }
                              aria-expanded={template.id === expandedTemplateId}
                            >
                              <div className="template-toggle-body">
                                <span className="template-name">{template.name || 'Unbenannte Vorlage'}</span>
                                <span className="template-folder">{template.target_folder || 'Kein Zielordner'}</span>
                              </div>
                              <span className="template-toggle-icon" aria-hidden="true">
                                {template.id === expandedTemplateId ? '▾' : '▸'}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="link danger"
                              onClick={() => handleRemoveTemplateDefinition(template.id)}
                            >
                              Template löschen
                            </button>
                          </header>
                          {expandedTemplateId === template.id && (
                            <div className="template-card-body">
                              <RuleEditorForm
                                draft={template}
                                fieldOrder={fieldOrder}
                                parseList={parseList}
                                onChange={mutator => updateTemplate(template.id, mutator)}
                                tagSlots={tagSlotOptions}
                              />
                            </div>
                          )}
                    </article>
                      ))}
                    </div>
                  )}
                </section>
              )}

            </div>
          )}

          {activeTab === 'catalogFolders' && (
            <div className="settings-section wide">
              <CatalogEditor embedded showDevtools={false} section="folders" />
            </div>
          )}

          {activeTab === 'catalogTags' && (
            <div className="settings-section wide">
              <CatalogEditor embedded showDevtools={false} section="tagSlots" />
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="settings-section">
              <section className="analysis-card">
                <h2>Ollama & Modelle</h2>
                <div className={`ollama-status-card ${ollamaStatus?.reachable ? 'ok' : 'error'}`}>
                  <div className="ollama-status-header">
                    <span className="label">Host</span>
                    <span className={`indicator ${ollamaStatus?.reachable ? 'online' : 'offline'}`}>
                      {ollamaStatus?.reachable ? 'verbunden' : 'nicht verbunden'}
                    </span>
                  </div>
                  <div className="ollama-status-body">
                    {ollamaLoading && <div className="placeholder">Lade Status…</div>}
                    {!ollamaLoading && ollamaStatus && (
                      <>
                        <div className="host">{ollamaStatus.host}</div>
                        <div className="models detailed">
                          {ollamaStatus.models.length === 0 && <span>Keine Modelle bekannt.</span>}
                          {ollamaStatus.models.map(model => {
                            const progressValue = Math.max(0, Math.min(100, Math.round((model.progress ?? 0) * 100)))
                            return (
                              <div key={`${model.purpose}-${model.normalized_name}`} className="ollama-model-detail">
                                <div className="ollama-model-detail-header">
                                  <div>
                                    <span className="model-purpose">{modelLabel(model.purpose)}</span>
                                    <strong>{model.name}</strong>
                                  </div>
                                  {model.name && (
                                    <div className="ollama-model-detail-actions">
                                      <button
                                        type="button"
                                        className="link"
                                        onClick={() => handleModelReload(model.name, model.purpose as OllamaModelPurpose)}
                                        disabled={ollamaPullBusy || model.pulling}
                                      >
                                        {model.pulling ? 'Lädt…' : 'Neu laden'}
                                      </button>
                                      <button
                                        type="button"
                                        className="link danger"
                                        onClick={() => handleModelDelete(model.name)}
                                        disabled={ollamaPullBusy || model.pulling}
                                      >
                                        Löschen
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {model.pulling && (
                                  <div
                                    className="ollama-progress-bar"
                                    role="progressbar"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={progressValue}
                                  >
                                    <div className="ollama-progress-indicator" style={{ width: `${progressValue}%` }} />
                                  </div>
                                )}
                                <div className="ollama-model-detail-meta">
                                  {model.pulling && (
                                    <span>{modelProgressLabel(model.progress, model.download_completed, model.download_total, model.status)}</span>
                                  )}
                                  {!model.pulling && model.message && <span>{model.message}</span>}
                                  {model.error && <span className="error">{model.error}</span>}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        {ollamaStatus.message && <div className="ollama-note">{ollamaStatus.message}</div>}
                      </>
                    )}
                    {!ollamaLoading && !ollamaStatus && (
                      <div className="placeholder">
                        {ollamaEnabled
                          ? 'Keine Ollama-Informationen verfügbar.'
                          : 'Ollama ist für das statische Modul deaktiviert.'}
                      </div>
                    )}
                    {ollamaError && (
                      <div className="status-banner error inline">Status konnte nicht geladen werden: {ollamaError}</div>
                    )}
                  </div>
                  <div className="ollama-status-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => refreshOllama()}
                      disabled={ollamaLoading || ollamaPullBusy}
                    >
                      {ollamaLoading ? 'Aktualisiere…' : 'Status aktualisieren'}
                    </button>
                  </div>
                </div>
                <form className="ollama-pull-form" onSubmit={handlePullSubmit}>
                  <h3>Modell herunterladen</h3>
                  <div className="ollama-pull-grid">
                    <label>
                      <span>Modellname</span>
                      <input
                        type="text"
                        value={pullModelDraft}
                        onChange={event => setPullModelDraft(event.target.value)}
                        placeholder="z. B. llama3"
                        disabled={ollamaPullBusy}
                      />
                    </label>
                    <label>
                      <span>Zweck</span>
                      <select
                        value={pullPurpose}
                        onChange={event => setPullPurpose(event.target.value as OllamaModelPurpose)}
                        disabled={ollamaPullBusy}
                      >
                        <option value="classifier">Klassifikator</option>
                        <option value="embedding">Embeddings</option>
                        <option value="custom">Allgemein</option>
                      </select>
                    </label>
                    <div className="ollama-pull-actions">
                      <button type="submit" className="primary" disabled={ollamaPullBusy}>
                        {ollamaPullBusy ? 'Starte…' : 'Pull starten'}
                      </button>
                    </div>
                  </div>
                  {modelActionFeedback && (
                    <div className={`status-banner ${modelActionFeedback.kind} inline`}>
                      {modelActionFeedback.message}
                    </div>
                  )}
                </form>
              </section>
              <section className="analysis-card">
                <h2>Analyse-Modell</h2>
                <label className="mode-select large">
                  <span>Sprachmodell</span>
                  <div className="model-select-row">
                    <select
                      value={configDraft.classifierModel}
                      onChange={event => handleConfigChange('classifierModel', event.target.value)}
                      disabled={configSaving}
                    >
                      <option value="">Modell wählen…</option>
                      {classifierOptions.map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={configDraft.classifierModel}
                      onChange={event => handleConfigChange('classifierModel', event.target.value)}
                      placeholder="Eigenes Modell"
                      disabled={configSaving}
                    />
                  </div>
                  <span className="field-hint">Die Freitexteingabe überschreibt die Auswahl.</span>
                </label>
                <div className="config-actions secondary">
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleConfigSave}
                    disabled={!configDirty || configSaving}
                  >
                    {configSaving ? 'Speichere…' : 'Konfiguration speichern'}
                  </button>
                </div>
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

          {activeTab === 'calendar' && (
            <div className="settings-section">
              <section className="general-card">
                <h2>CalDAV-Synchronisation</h2>
                <p className="muted">
                  Hinterlege Verbindungsdaten für den CalDAV-Kalender und definiere den IMAP-Tag, der nach dem Import gesetzt
                  wird.
                </p>
                {calendarError && <div className="status-banner error">{calendarError}</div>}
                <div className="config-grid">
                  <label className="toggle-field">
                    <span>Synchronisation aktiv</span>
                    <div className="toggle-control">
                      <input
                        type="checkbox"
                        checked={calendarDraft.enabled}
                        onChange={event =>
                          setCalendarDraft(current => ({ ...current, enabled: event.target.checked }))
                        }
                        disabled={calendarLoading || calendarSaving}
                      />
                      <span>{calendarDraft.enabled ? 'Aktiv' : 'Inaktiv'}</span>
                    </div>
                  </label>
                  <label>
                    <span>CalDAV-URL</span>
                    <input
                      type="text"
                      value={calendarDraft.caldav_url}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, caldav_url: event.target.value }))
                      }
                      placeholder="https://cloud.example.org/remote.php/dav/calendars/user/termine/"
                      disabled={calendarLoading || calendarSaving}
                    />
                  </label>
                  <label>
                    <span>Benutzername</span>
                    <input
                      type="text"
                      value={calendarDraft.username}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, username: event.target.value }))
                      }
                      disabled={calendarLoading || calendarSaving}
                    />
                  </label>
                  <label>
                    <span>Kalendername / Pfad</span>
                    <input
                      type="text"
                      value={calendarDraft.calendar_name}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, calendar_name: event.target.value }))
                      }
                      placeholder="z. B. Termine"
                      disabled={calendarLoading || calendarSaving}
                    />
                  </label>
                  <label>
                    <span>Standard-Zeitzone</span>
                    <input
                      type="text"
                      value={calendarDraft.timezone}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, timezone: event.target.value }))
                      }
                      placeholder="Europe/Berlin"
                      disabled={calendarLoading || calendarSaving}
                    />
                  </label>
                  <label>
                    <span>IMAP-Tag nach Import</span>
                    <input
                      type="text"
                      value={calendarDraft.processed_tag}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, processed_tag: event.target.value }))
                      }
                      placeholder="Termin bearbeitet"
                      disabled={calendarLoading || calendarSaving}
                    />
                  </label>
                  <label>
                    <span>IMAP-Ordner für Kalenderscan</span>
                    <textarea
                      value={calendarDraft.source_folders}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, source_folders: event.target.value }))
                      }
                      placeholder={'INBOX/Kalender\nINBOX/Termine'}
                      rows={3}
                      disabled={calendarLoading || calendarSaving}
                    />
                    <small className="muted">
                      Ein Ordner pro Zeile. Leer lassen, um die überwachten Ordner zu verwenden.
                    </small>
                  </label>
                  <label>
                    <span>Ordner für bearbeitete Termine</span>
                    <input
                      type="text"
                      value={calendarDraft.processed_folder}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, processed_folder: event.target.value }))
                      }
                      placeholder="z. B. Archiv/Kalender"
                      disabled={calendarLoading || calendarSaving}
                    />
                    <small className="muted">
                      Nach dem Import verschobene Terminmails landen in diesem Ordner. Leer lassen, um sie nicht zu bewegen.
                    </small>
                  </label>
                  <label>
                    <span>Passwort</span>
                    <input
                      type="password"
                      value={calendarDraft.password}
                      onChange={event =>
                        setCalendarDraft(current => ({ ...current, password: event.target.value }))
                      }
                      placeholder={calendarHasPassword ? 'Passwort beibehalten' : 'Neues Passwort'}
                      disabled={calendarLoading || calendarSaving}
                    />
                    <small className="muted">
                      {calendarHasPassword
                        ? 'Leer lassen, um das vorhandene Passwort weiter zu nutzen.'
                        : 'Trage hier das Passwort für den CalDAV-Zugang ein.'}
                    </small>
                  </label>
                  <label className="toggle-field">
                    <span>Passwort löschen</span>
                    <div className="toggle-control">
                      <input
                        type="checkbox"
                        checked={calendarDraft.clear_password}
                        onChange={event =>
                          setCalendarDraft(current => ({ ...current, clear_password: event.target.checked }))
                        }
                        disabled={calendarLoading || calendarSaving}
                      />
                      <span>{calendarDraft.clear_password ? 'Wird entfernt' : 'Beibehalten'}</span>
                    </div>
                    <small className="muted">
                      Aktiviere diese Option, wenn du das gespeicherte Passwort zurücksetzen möchtest.
                    </small>
                  </label>
                </div>
                <div className="config-actions">
                  {calendarTestStatus && (
                    <div className={`status-banner ${calendarTestStatus.kind} inline`}>
                      {calendarTestStatus.message}
                    </div>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void handleCalendarTest()}
                    disabled={calendarLoading || calendarSaving || calendarTesting}
                  >
                    {calendarTesting ? 'Teste Verbindung…' : 'Verbindung testen'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void loadCalendarConfig()}
                    disabled={calendarLoading || calendarSaving}
                  >
                    {calendarLoading ? 'Lade…' : 'Neu laden'}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={handleCalendarSave}
                    disabled={!calendarDirty || calendarSaving}
                  >
                    {calendarSaving ? 'Speichere…' : 'Kalender speichern'}
                  </button>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="settings-section">
              <section className="general-card">
                <h2>Analyse-Module & Modus</h2>
                <div className="option-board">
                  <div className="option-group">
                    <h3>Analyse-Modul</h3>
                    <div className="option-grid modules">
                      {moduleOptions.map(option => (
                        <button
                          key={option}
                          type="button"
                          className={`option-card${configDraft.analysisModule === option ? ' selected' : ''}`}
                          onClick={() => handleConfigChange('analysisModule', option)}
                          disabled={configSaving || appConfigLoading}
                        >
                          <div className="option-title">
                            <strong>{moduleLabels[option]}</strong>
                            {appConfig?.analysis_module === option && <span className="badge">Aktuell</span>}
                          </div>
                          <p>{moduleDescriptions[option]}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="option-group">
                    <h3>Verarbeitungsmodus</h3>
                    <div className="option-grid modes">
                      {modeOptions.map(option => (
                        <button
                          key={option}
                          type="button"
                          className={`option-card${configDraft.mode === option ? ' selected' : ''}`}
                          onClick={() => handleConfigChange('mode', option)}
                          disabled={configSaving || appConfigLoading}
                        >
                          <div className="option-title">
                            <strong>{option}</strong>
                          </div>
                          <p>{modeDescriptions[option]}</p>
                        </button>
                      ))}
                    </div>
                  </div>
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
