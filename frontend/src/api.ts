import { recordDevEvent } from './devtools'

export type MoveMode = 'DRY_RUN' | 'CONFIRM' | 'AUTO'
export type AnalysisModule = 'STATIC' | 'HYBRID' | 'LLM_PURE'

export interface SuggestionScore {
  name: string
  score: number
  reason?: string
}

export interface NewFolderProposal {
  parent: string
  name: string
  reason: string
  full_path?: string
  status?: 'pending' | 'accepted' | 'rejected'
  score_hint?: number
}

export interface SuggestionCategory {
  label?: string
  matched_folder?: string | null
  confidence?: number | null
  reason?: string | null
}

export type SuggestionScope = 'open' | 'all'

export interface Suggestion {
  id?: number
  message_uid: string
  src_folder?: string | null
  subject?: string | null
  from_addr?: string | null
  date?: string | null
  ranked?: SuggestionScore[]
  proposal?: NewFolderProposal | null
  category?: SuggestionCategory | null
  tags?: string[] | null
  status?: string
  decision?: string | null
  move_status?: string | null
  move_error?: string | null
  dry_run_result?: Record<string, unknown> | null
}

export interface PendingMail {
  message_uid: string
  folder: string
  subject: string
  from_addr?: string | null
  date?: string | null
}

export interface PendingOverview {
  total_messages: number
  processed_count: number
  pending_count: number
  pending_ratio: number
  pending: PendingMail[]
  displayed_pending?: number
  list_limit?: number
  limit_active?: boolean
}

export interface TagExample {
  message_uid: string
  subject: string
  from_addr?: string | null
  folder?: string | null
  date?: string | null
}

export interface TagSuggestion {
  tag: string
  occurrences: number
  last_seen?: string | null
  examples: TagExample[]
}

export type OllamaModelPurpose = 'classifier' | 'embedding' | 'custom'

export interface OllamaModelStatus {
  name: string
  normalized_name: string
  purpose: OllamaModelPurpose
  available: boolean
  pulled: boolean
  digest?: string | null
  size?: number | null
  message?: string | null
  pulling?: boolean
  progress?: number | null
  download_total?: number | null
  download_completed?: number | null
  status?: string | null
  error?: string | null
}

export interface OllamaStatus {
  host: string
  reachable: boolean
  message?: string | null
  last_checked?: string | null
  models: OllamaModelStatus[]
}

export interface OllamaPullRequest {
  model: string
  purpose?: OllamaModelPurpose
}

export interface OllamaDeleteRequest {
  model: string
}

export interface FolderChildConfig {
  name: string
  description?: string | null
  children: FolderChildConfig[]
  tag_guidelines: TagGuidelineConfig[]
}

export interface TagGuidelineConfig {
  name: string
  description?: string | null
}

export interface FolderTemplateConfig {
  name: string
  description?: string | null
  children: FolderChildConfig[]
  tag_guidelines: TagGuidelineConfig[]
}

export interface TagSlotConfig {
  name: string
  description?: string | null
  options: string[]
  aliases: string[]
}

export interface ContextTagConfig {
  name: string
  description?: string | null
  folder: string
}

export interface CatalogDefinition {
  folder_templates: FolderTemplateConfig[]
  tag_slots: TagSlotConfig[]
}

export interface CatalogSyncResponse extends CatalogDefinition {
  imported_folders: string[]
  created_folders: string[]
}

export type KeywordFilterField = 'subject' | 'sender' | 'body'

export interface KeywordFilterMatchConfig {
  mode: 'all' | 'any'
  fields: KeywordFilterField[]
  terms: string[]
}

export interface KeywordFilterDateConfig {
  after?: string | null
  before?: string | null
  include_future?: boolean
}

export interface KeywordFilterRuleConfig {
  name: string
  description?: string | null
  enabled: boolean
  target_folder: string
  tags: string[]
  match: KeywordFilterMatchConfig
  date?: KeywordFilterDateConfig | null
  tag_future_dates?: boolean
}

export interface KeywordFilterConfig {
  rules: KeywordFilterRuleConfig[]
}

export interface KeywordFilterActivityRule {
  name: string
  target_folder: string
  count: number
  last_match?: string | null
  tags: string[]
}

export interface KeywordFilterRecentEntry {
  message_uid: string
  rule_name: string
  src_folder?: string | null
  target_folder: string
  applied_tags: string[]
  matched_terms: string[]
  matched_at: string
  message_date?: string | null
}

export interface KeywordFilterActivity {
  total_hits: number
  hits_last_24h: number
  window_days: number
  rules: KeywordFilterActivityRule[]
  recent: KeywordFilterRecentEntry[]
}

export interface AppConfig {
  dev_mode: boolean
  pending_list_limit: number
  mode: MoveMode
  analysis_module: AnalysisModule
  classifier_model: string
  protected_tag: string | null
  processed_tag: string | null
  ai_tag_prefix: string | null
  ollama?: OllamaStatus | null
  folder_templates: FolderTemplateConfig[]
  tag_slots: TagSlotConfig[]
  context_tags: ContextTagConfig[]
}

export interface AppConfigUpdateRequest {
  mode?: MoveMode
  analysis_module?: AnalysisModule
  classifier_model?: string
  protected_tag?: string | null
  processed_tag?: string | null
  ai_tag_prefix?: string | null
}

interface ModeResponse { mode: MoveMode }
export interface SuggestionsResponse {
  suggestions: Suggestion[]
  open_count: number
  decided_count: number
  error_count: number
  total_count: number
}
export interface MoveResponse {
  ok: boolean
  dry_run: boolean
  checks?: Record<string, unknown>
}

export interface DecideResponse {
  ok: boolean
  suggestion?: Suggestion
}

export interface RescanResponse {
  ok: boolean
  new_suggestions: number
  cancelled?: boolean
}

export interface FolderSelectionResponse {
  available: string[]
  selected: string[]
}

export interface FolderCreateResponse {
  created: string
  existed: boolean
}

export interface ProposalDecisionResponse {
  ok: boolean
  proposal: NewFolderProposal | null
}

export interface ScanStatus {
  active: boolean
  folders: string[]
  poll_interval: number
  last_started_at?: string | null
  last_finished_at?: string | null
  last_error?: string | null
  last_result_count?: number | null
  rescan_active?: boolean
  rescan_folders?: string[]
  rescan_started_at?: string | null
  rescan_finished_at?: string | null
  rescan_error?: string | null
  rescan_result_count?: number | null
  rescan_cancelled?: boolean
}

export interface ScanStartResponse {
  started: boolean
  status: ScanStatus
}

export interface ScanStopResponse {
  stopped: boolean
  status: ScanStatus
}

export type StreamEvent =
  | { type: 'hello'; msg: string }
  | { type: 'pending_overview'; payload: PendingOverview }
  | { type: 'pending_error'; error: string }

const envBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000'
const BASE = envBase.replace(/\/$/, '')
const baseUrl = new URL(BASE)
const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const normalizedPath = baseUrl.pathname.replace(/\/$/, '')
const STREAM_URL = `${wsProtocol}//${baseUrl.host}${normalizedPath}/ws/stream`

export const API_BASE_URL = BASE
export const STREAM_WEBSOCKET_URL = STREAM_URL

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const label = `${method} ${path}`
  if (init?.body) {
    let parsed: unknown = init.body
    if (typeof init.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch (error) {
        parsed = init.body
      }
    }
    recordDevEvent({ type: 'request', label, payload: parsed })
  } else {
    recordDevEvent({ type: 'request', label })
  }

  const started = performance.now()
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordDevEvent({
      type: 'error',
      label,
      details: 'Netzwerkfehler',
      payload: message,
      durationMs: performance.now() - started,
    })
    throw new Error(`API-Anfrage fehlgeschlagen: ${message}`)
  }
  if (!response.ok) {
    const text = await response.text()
    recordDevEvent({
      type: 'error',
      label,
      details: `${response.status} ${response.statusText}`,
      payload: text,
      durationMs: performance.now() - started,
    })
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  const clone = response.clone()
  const data = (await response.json()) as T
  try {
    const payload = await clone.json()
    recordDevEvent({
      type: 'response',
      label,
      payload,
      durationMs: performance.now() - started,
    })
  } catch (error) {
    recordDevEvent({
      type: 'response',
      label,
      payload: '[non-json response]',
      durationMs: performance.now() - started,
    })
  }
  return data
}

export async function getMode(): Promise<ModeResponse> {
  return request('/api/mode')
}

export async function setMode(mode: MoveMode): Promise<ModeResponse> {
  return request('/api/mode', { method: 'POST', body: JSON.stringify({ mode }) })
}

export async function getFolders(): Promise<FolderSelectionResponse> {
  return request('/api/folders')
}

export async function getSuggestions(scope: SuggestionScope = 'open'): Promise<SuggestionsResponse> {
  const query = scope === 'all' ? '?include=all' : ''
  return request<SuggestionsResponse>(`/api/suggestions${query}`)
}

export async function getPendingOverview(): Promise<PendingOverview> {
  return request<PendingOverview>('/api/pending')
}

export async function getTagSuggestions(): Promise<TagSuggestion[]> {
  return request<TagSuggestion[]>('/api/tags')
}

export async function getAppConfig(): Promise<AppConfig> {
  return request<AppConfig>('/api/config')
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  return request<OllamaStatus>('/api/ollama')
}

export async function pullOllamaModel(payload: OllamaPullRequest): Promise<OllamaStatus> {
  return request<OllamaStatus>('/api/ollama/pull', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function deleteOllamaModel(payload: OllamaDeleteRequest): Promise<OllamaStatus> {
  return request<OllamaStatus>('/api/ollama/delete', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function updateAppConfig(payload: AppConfigUpdateRequest): Promise<AppConfig> {
  return request<AppConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function getCatalogDefinition(): Promise<CatalogDefinition> {
  return request<CatalogDefinition>('/api/catalog')
}

export async function updateCatalogDefinition(payload: CatalogDefinition): Promise<CatalogDefinition> {
  return request<CatalogDefinition>('/api/catalog', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export interface CatalogImportOptions {
  excludeDefaults?: string[]
}

export async function importCatalogFromMailbox(options?: CatalogImportOptions): Promise<CatalogSyncResponse> {
  const payload = {
    exclude_defaults: options?.excludeDefaults?.filter(value => value.trim().length > 0) ?? [],
  }
  return request<CatalogSyncResponse>('/api/catalog/import-mailbox', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function exportCatalogToMailbox(): Promise<CatalogSyncResponse> {
  return request<CatalogSyncResponse>('/api/catalog/export-mailbox', { method: 'POST' })
}

export async function getKeywordFilters(): Promise<KeywordFilterConfig> {
  return request<KeywordFilterConfig>('/api/filters')
}

export async function updateKeywordFilters(payload: KeywordFilterConfig): Promise<KeywordFilterConfig> {
  return request<KeywordFilterConfig>('/api/filters', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function getKeywordFilterActivity(): Promise<KeywordFilterActivity> {
  return request<KeywordFilterActivity>('/api/filters/activity')
}

export async function decide(message_uid: string, target_folder: string, decision: 'accept' | 'reject', dry_run = false): Promise<DecideResponse | MoveResponse> {
  return request<DecideResponse | MoveResponse>('/api/decide', {
    method: 'POST',
    body: JSON.stringify({ message_uid, target_folder, decision, dry_run }),
  })
}

export async function moveOne(message_uid: string, target_folder: string, dry_run = false): Promise<MoveResponse> {
  return request<MoveResponse>('/api/move', {
    method: 'POST',
    body: JSON.stringify({ message_uid, target_folder, dry_run }),
  })
}

export async function rescan(folders?: string[]): Promise<RescanResponse> {
  return request<RescanResponse>('/api/rescan', {
    method: 'POST',
    body: JSON.stringify({ folders }),
  })
}

export async function updateFolderSelection(folders: string[]): Promise<FolderSelectionResponse> {
  return request('/api/folders/selection', {
    method: 'POST',
    body: JSON.stringify({ folders }),
  })
}

export async function createFolder(path: string): Promise<FolderCreateResponse> {
  return request<FolderCreateResponse>('/api/folders/create', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export async function decideProposal(message_uid: string, accept: boolean): Promise<ProposalDecisionResponse> {
  return request('/api/proposal', {
    method: 'POST',
    body: JSON.stringify({ message_uid, accept }),
  })
}

export async function getScanStatus(): Promise<ScanStatus> {
  return request<ScanStatus>('/api/scan/status')
}

export async function startScan(folders?: string[]): Promise<ScanStartResponse> {
  return request<ScanStartResponse>('/api/scan/start', {
    method: 'POST',
    body: JSON.stringify({ folders }),
  })
}

export async function stopScan(): Promise<ScanStopResponse> {
  return request<ScanStopResponse>('/api/scan/stop', { method: 'POST' })
}

export function openStream(onEvent: (event: StreamEvent) => void): WebSocket {
  const socket = new WebSocket(STREAM_URL)
  recordDevEvent({ type: 'info', label: 'WebSocket verbinden', details: STREAM_URL })
  socket.onmessage = rawEvent => {
    try {
      const parsed = JSON.parse(rawEvent.data) as StreamEvent
      recordDevEvent({ type: 'stream', label: parsed.type, payload: parsed })
      onEvent(parsed)
    } catch (error) {
      recordDevEvent({ type: 'error', label: 'Stream parse error', payload: String(error) })
    }
  }
  socket.onerror = event => {
    recordDevEvent({ type: 'error', label: 'WebSocket Fehler', payload: event })
  }
  socket.onopen = () => {
    recordDevEvent({ type: 'info', label: 'WebSocket geöffnet' })
  }
  socket.onclose = () => {
    recordDevEvent({ type: 'info', label: 'WebSocket geschlossen' })
  }
  return socket
}
