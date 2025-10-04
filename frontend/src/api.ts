export type MoveMode = 'DRY_RUN' | 'CONFIRM' | 'AUTO'

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

export interface Suggestion {
  id?: number
  message_uid: string
  src_folder?: string | null
  subject?: string | null
  from_addr?: string | null
  date?: string | null
  ranked?: SuggestionScore[]
  proposal?: NewFolderProposal | null
  status?: string
  decision?: string | null
  move_status?: string | null
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
}

interface ModeResponse { mode: MoveMode }
interface SuggestionsResponse { suggestions: Suggestion[] }
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
}

export interface FolderSelectionResponse {
  available: string[]
  selected: string[]
}

export interface ProposalDecisionResponse {
  ok: boolean
  proposal: NewFolderProposal | null
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
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

export async function getSuggestions(): Promise<Suggestion[]> {
  const data = await request<SuggestionsResponse>('/api/suggestions')
  return data.suggestions
}

export async function getPendingOverview(): Promise<PendingOverview> {
  return request<PendingOverview>('/api/pending')
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

export async function decideProposal(message_uid: string, accept: boolean): Promise<ProposalDecisionResponse> {
  return request('/api/proposal', {
    method: 'POST',
    body: JSON.stringify({ message_uid, accept }),
  })
}

export function openStream(onEvent: (event: StreamEvent) => void): WebSocket {
  const socket = new WebSocket(STREAM_URL)
  socket.onmessage = rawEvent => {
    try {
      const parsed = JSON.parse(rawEvent.data) as StreamEvent
      onEvent(parsed)
    } catch (error) {
      console.error('Unbekannte Nachricht auf dem Stream', error)
    }
  }
  return socket
}
