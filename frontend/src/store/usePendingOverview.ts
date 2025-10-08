import { useCallback, useEffect, useRef, useState } from 'react'
import { PendingOverview, StreamEvent, getPendingOverview, openStream } from '../api'
import { recordDevEvent } from '../devtools'

export interface PendingOverviewState {
  data: PendingOverview | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function usePendingOverview(enabled = true): PendingOverviewState {
  const [data, setData] = useState<PendingOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)
  const activeRef = useRef(true)
  const snapshotSignatureRef = useRef<string>('')

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  const loadSnapshot = useCallback(
    async (reason: 'initial' | 'manual' = 'manual') => {
      if (!activeRef.current) {
        return
      }
      if (!enabled) {
        setData(null)
        setError(null)
        setLoading(false)
        snapshotSignatureRef.current = ''
        return
      }
      setLoading(true)
      try {
        const snapshot = await getPendingOverview(reason !== 'initial')
        if (!activeRef.current) {
          return
        }
        const nextSignature = JSON.stringify(snapshot)
        setData(prev => {
          if (snapshotSignatureRef.current === nextSignature && prev !== null) {
            return prev
          }
          snapshotSignatureRef.current = nextSignature
          return snapshot
        })
        setError(null)
        recordDevEvent({
          type: 'info',
          label: reason === 'initial' ? 'Pending initial' : 'Pending refresh',
          payload: snapshot,
        })
      } catch (err) {
        if (!activeRef.current) {
          return
        }
        const message = err instanceof Error ? err.message : 'Überblick konnte nicht geladen werden.'
        setError(message)
        recordDevEvent({
          type: 'error',
          label: reason === 'initial' ? 'Pending initial fehlgeschlagen' : 'Pending refresh fehlgeschlagen',
          payload: err instanceof Error ? err.message : String(err),
        })
      } finally {
        if (activeRef.current) {
          setLoading(false)
        }
      }
    },
    [enabled],
  )

  useEffect(() => {
    if (!enabled) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    void loadSnapshot('initial')
    let socket: WebSocket | null = null
    try {
      socket = openStream((event: StreamEvent) => {
        if (!activeRef.current) return
        if (event.type === 'pending_overview') {
          const payloadSignature = JSON.stringify(event.payload)
          setData(prev => {
            if (snapshotSignatureRef.current === payloadSignature && prev !== null) {
              return prev
            }
            snapshotSignatureRef.current = payloadSignature
            return event.payload
          })
          setError(null)
          setLoading(false)
          recordDevEvent({ type: 'stream', label: 'pending_overview', payload: event.payload })
        } else if (event.type === 'pending_error') {
          setError(event.error)
          setLoading(false)
          recordDevEvent({ type: 'error', label: 'pending_error', payload: event.error })
        }
      })
    } catch (err) {
      if (activeRef.current) {
        setError(err instanceof Error ? err.message : 'Echtzeitverbindung konnte nicht aufgebaut werden.')
        setLoading(false)
        recordDevEvent({
          type: 'error',
          label: 'WebSocket Aufbau fehlgeschlagen',
          payload: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (socket) {
      socket.onerror = () => {
        if (activeRef.current) {
          setError('Live-Updates nicht verfügbar (WebSocket-Fehler).')
          setLoading(false)
          recordDevEvent({ type: 'error', label: 'WebSocket onerror' })
        }
      }
      socket.onclose = () => {
        if (activeRef.current) {
          setError(prev => prev ?? 'Verbindung zur Echtzeitübersicht wurde beendet.')
          recordDevEvent({ type: 'info', label: 'WebSocket onclose' })
        }
      }
    }

    return () => {
      if (socket) {
        socket.close()
      }
    }
  }, [enabled, loadSnapshot])

  const refresh = useCallback(async () => {
    await loadSnapshot('manual')
  }, [loadSnapshot])

  return { data, loading, error, refresh }
}
