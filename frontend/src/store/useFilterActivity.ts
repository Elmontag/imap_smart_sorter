import { useCallback, useEffect, useState } from 'react'

import { KeywordFilterActivity, getKeywordFilterActivity } from '../api'

export interface FilterActivityState {
  data: KeywordFilterActivity | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useFilterActivity(enabled = true): FilterActivityState {
  const [data, setData] = useState<KeywordFilterActivity | null>(null)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!enabled) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const activity = await getKeywordFilterActivity()
      setData(activity)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Filteraktivität konnte nicht geladen werden.')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    await load()
  }, [load])

  return { data, loading, error, refresh }
}
