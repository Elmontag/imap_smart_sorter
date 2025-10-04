import { useSyncExternalStore } from 'react'

export type DevEventType = 'request' | 'response' | 'error' | 'info' | 'ai' | 'stream'

export interface DevEvent {
  id: number
  timestamp: number
  type: DevEventType
  label: string
  details?: string
  payload?: unknown
  durationMs?: number
  context?: string
}

const envFlag = String(import.meta.env.VITE_DEV_MODE ?? 'false').toLowerCase()
let devMode = envFlag === 'true' || envFlag === '1'
let events: DevEvent[] = []
let counter = 0

const eventListeners = new Set<() => void>()
const modeListeners = new Set<() => void>()

const notifyEvents = () => {
  eventListeners.forEach(listener => listener())
}

const notifyMode = () => {
  modeListeners.forEach(listener => listener())
}

export function setDevMode(enabled: boolean): void {
  if (devMode === enabled) {
    return
  }
  devMode = enabled
  if (!devMode) {
    events = []
    notifyEvents()
  } else {
    recordDevEvent({ type: 'info', label: 'Dev-Modus aktiviert' })
  }
  notifyMode()
}

export function isDevMode(): boolean {
  return devMode
}

interface RecordEventInput {
  type: DevEventType
  label: string
  details?: string
  payload?: unknown
  durationMs?: number
  context?: string
  timestamp?: number
}

export function recordDevEvent(entry: RecordEventInput): void {
  if (!devMode) {
    return
  }
  const next: DevEvent = {
    id: ++counter,
    timestamp: entry.timestamp ?? Date.now(),
    type: entry.type,
    label: entry.label,
    details: entry.details,
    payload: entry.payload,
    durationMs: entry.durationMs,
    context: entry.context,
  }
  events = [...events, next].slice(-200)
  notifyEvents()
}

function subscribeEvents(listener: () => void): () => void {
  eventListeners.add(listener)
  return () => {
    eventListeners.delete(listener)
  }
}

function subscribeMode(listener: () => void): () => void {
  modeListeners.add(listener)
  return () => {
    modeListeners.delete(listener)
  }
}

function getEventsSnapshot(): DevEvent[] {
  return events
}

function getModeSnapshot(): boolean {
  return devMode
}

export function useDevEvents(): DevEvent[] {
  return useSyncExternalStore(subscribeEvents, getEventsSnapshot, getEventsSnapshot)
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribeMode, getModeSnapshot, getModeSnapshot)
}
