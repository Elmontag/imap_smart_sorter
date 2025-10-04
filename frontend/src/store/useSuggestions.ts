import { useCallback, useEffect, useState } from 'react'
import { Suggestion, getSuggestions } from '../api'

export interface SuggestionsState {
  data: Suggestion[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useSuggestions(): SuggestionsState {
  const [data, setData] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getSuggestions()
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler beim Laden der Vorschläge')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { data, loading, error, refresh: fetchData }
}
