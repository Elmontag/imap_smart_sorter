import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getOllamaStatus,
  pullOllamaModel,
  deleteOllamaModel,
  OllamaModelPurpose,
  OllamaStatus,
} from '../api'

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

export interface OllamaStatusState {
  status: OllamaStatus | null
  loading: boolean
  error: string | null
  refreshing: boolean
  pullBusy: boolean
  refresh: () => Promise<void>
  pullModel: (model: string, purpose?: OllamaModelPurpose) => Promise<void>
  deleteModel: (model: string) => Promise<void>
}

export function useOllamaStatus(enabled: boolean): OllamaStatusState {
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pullBusy, setPullBusy] = useState(false)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled) {
      setStatus(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await getOllamaStatus()
      if (!activeRef.current) {
        return
      }
      setStatus(data)
      setError(null)
    } catch (err) {
      if (!activeRef.current) {
        return
      }
      setError(toMessage(err))
    } finally {
      if (activeRef.current) {
        setLoading(false)
      }
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      setLoading(false)
      return
    }
    void refresh()
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled) {
      return
    }
    if (!status?.models.some(model => model.pulling)) {
      return
    }
    if (typeof window === 'undefined') {
      return
    }
    const id = window.setInterval(() => {
      void refresh()
    }, 2500)
    return () => {
      window.clearInterval(id)
    }
  }, [enabled, status?.models, refresh])

  const pullModel = useCallback(
    async (model: string, purpose?: OllamaModelPurpose) => {
      const trimmed = model.trim()
      if (!trimmed) {
        throw new Error('Modellname darf nicht leer sein')
      }
      setPullBusy(true)
      setLoading(true)
      setError(null)
      try {
        const data = await pullOllamaModel({ model: trimmed, purpose })
        if (!activeRef.current) {
          return
        }
        setStatus(data)
        setError(null)
      } catch (err) {
        if (!activeRef.current) {
          return
        }
        setError(toMessage(err))
        throw err
      } finally {
        if (activeRef.current) {
          setPullBusy(false)
          setLoading(false)
        }
      }
    },
    [],
  )

  const deleteModel = useCallback(async (model: string) => {
    const trimmed = model.trim()
    if (!trimmed) {
      throw new Error('Modellname darf nicht leer sein')
    }
    setPullBusy(true)
    setLoading(true)
    setError(null)
    try {
      const data = await deleteOllamaModel({ model: trimmed })
      if (!activeRef.current) {
        return
      }
      setStatus(data)
      setError(null)
    } catch (err) {
      if (!activeRef.current) {
        return
      }
      setError(toMessage(err))
      throw err
    } finally {
      if (activeRef.current) {
        setPullBusy(false)
        setLoading(false)
      }
    }
  }, [])

  const refreshing = useMemo(() => loading && !pullBusy, [loading, pullBusy])

  return {
    status,
    loading,
    error,
    refreshing,
    pullBusy,
    refresh,
    pullModel,
    deleteModel,
  }
}
