import { useCallback, useEffect, useRef, useState } from 'react'
import { AppConfig, getAppConfig } from '../api'
import { setDevMode } from '../devtools'

export interface AppConfigState {
  data: AppConfig | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useAppConfig(): AppConfigState {
  const [data, setData] = useState<AppConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const config = await getAppConfig()
      if (!activeRef.current) {
        return
      }
      setData(config)
      setDevMode(config.dev_mode)
      setError(null)
    } catch (err) {
      if (!activeRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : 'Konfiguration konnte nicht geladen werden.')
    } finally {
      if (activeRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return {
    data,
    loading,
    error,
    refresh: load,
  }
}
