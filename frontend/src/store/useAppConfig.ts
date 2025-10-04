import { useEffect, useState } from 'react'
import { AppConfig, getAppConfig } from '../api'
import { setDevMode } from '../devtools'

export interface AppConfigState {
  data: AppConfig | null
  loading: boolean
  error: string | null
}

export function useAppConfig(): AppConfigState {
  const [data, setData] = useState<AppConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const config = await getAppConfig()
        if (!active) {
          return
        }
        setData(config)
        setDevMode(config.dev_mode)
        setError(null)
      } catch (err) {
        if (!active) {
          return
        }
        setError(err instanceof Error ? err.message : 'Konfiguration konnte nicht geladen werden.')
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [])

  return { data, loading, error }
}
