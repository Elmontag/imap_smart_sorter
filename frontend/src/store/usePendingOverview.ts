import { useEffect, useState } from 'react'
import { PendingOverview, StreamEvent, getPendingOverview, openStream } from '../api'

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
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Überblick konnte nicht geladen werden.')
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
        } else if (event.type === 'pending_error') {
          setError(event.error)
        }
      })
    } catch (err) {
      if (active) {
        setError(err instanceof Error ? err.message : 'Echtzeitverbindung konnte nicht aufgebaut werden.')
      }
    }

    if (socket) {
      socket.onerror = () => {
        if (active) {
          setError('Live-Updates nicht verfügbar (WebSocket-Fehler).')
        }
      }
      socket.onclose = () => {
        if (active) {
          setError(prev => prev ?? 'Verbindung zur Echtzeitübersicht wurde beendet.')
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
