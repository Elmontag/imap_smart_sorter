import { useEffect, useState } from 'react'
import { PendingOverview, StreamEvent, getPendingOverview, openStream } from '../api'
import { recordDevEvent } from '../devtools'

export interface PendingOverviewState {
  data: PendingOverview | null
  loading: boolean
  error: string | null
}

export function usePendingOverview(): PendingOverviewState {
  const [data, setData] = useState<PendingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const loadInitial = async () => {
      try {
        const snapshot = await getPendingOverview()
        if (active) {
          setData(snapshot)
          setError(null)
          recordDevEvent({ type: 'info', label: 'Pending initial', payload: snapshot })
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Überblick konnte nicht geladen werden.')
          recordDevEvent({
            type: 'error',
            label: 'Pending initial fehlgeschlagen',
            payload: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadInitial()

    let socket: WebSocket | null = null
    try {
      socket = openStream((event: StreamEvent) => {
        if (!active) return
        if (event.type === 'pending_overview') {
          setData(event.payload)
          setError(null)
          recordDevEvent({ type: 'stream', label: 'pending_overview', payload: event.payload })
        } else if (event.type === 'pending_error') {
          setError(event.error)
          recordDevEvent({ type: 'error', label: 'pending_error', payload: event.error })
        }
      })
    } catch (err) {
      if (active) {
        setError(err instanceof Error ? err.message : 'Echtzeitverbindung konnte nicht aufgebaut werden.')
        recordDevEvent({
          type: 'error',
          label: 'WebSocket Aufbau fehlgeschlagen',
          payload: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (socket) {
      socket.onerror = () => {
        if (active) {
          setError('Live-Updates nicht verfügbar (WebSocket-Fehler).')
          recordDevEvent({ type: 'error', label: 'WebSocket onerror' })
        }
      }
      socket.onclose = () => {
        if (active) {
          setError(prev => prev ?? 'Verbindung zur Echtzeitübersicht wurde beendet.')
          recordDevEvent({ type: 'info', label: 'WebSocket onclose' })
        }
      }
    }

    return () => {
      active = false
      if (socket) {
        socket.close()
      }
    }
  }, [])

  return { data, loading, error }
}
