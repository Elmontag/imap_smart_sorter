export type MoveMode = 'DRY_RUN' | 'CONFIRM' | 'AUTO'

export interface SuggestionScore {
  name: string
  score: number
}

export interface NewFolderProposal {
  parent: string
  name: string
  reason: string
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

const envBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000'
const BASE = envBase.replace(/\/$/, '')

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

export async function getFolders(): Promise<string[]> {
  return request('/api/folders')
}

export async function getSuggestions(): Promise<Suggestion[]> {
  const data = await request<SuggestionsResponse>('/api/suggestions')
  return data.suggestions
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
