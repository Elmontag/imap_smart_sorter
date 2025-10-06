import { useCallback, useEffect, useState } from 'react'

import { KeywordFilterActivity, getKeywordFilterActivity } from '../api'

export interface FilterActivityState {
  data: KeywordFilterActivity | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useFilterActivity(): FilterActivityState {
  const [data, setData] = useState<KeywordFilterActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
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
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    await load()
  }, [load])

  return { data, loading, error, refresh }
}
