import { useCallback, useEffect, useState } from 'react'
import { Suggestion, SuggestionScope, getSuggestions } from '../api'
import { recordDevEvent } from '../devtools'

export interface SuggestionStats {
  openCount: number
  decidedCount: number
  errorCount: number
  totalCount: number
}

export interface SuggestionsState {
  data: Suggestion[]
  stats: SuggestionStats | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useSuggestions(scope: SuggestionScope = 'open', enabled = true): SuggestionsState {
  const [data, setData] = useState<Suggestion[]>([])
  const [stats, setStats] = useState<SuggestionStats | null>(null)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setData([])
      setStats(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await getSuggestions(scope)
      setData(result.suggestions)
      setStats({
        openCount: result.open_count,
        decidedCount: result.decided_count,
        errorCount: result.error_count,
        totalCount: result.total_count,
      })
      recordDevEvent({
        type: 'ai',
        label: `Vorschläge (${result.suggestions.length})`,
        payload: result,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler beim Laden der Vorschläge')
      recordDevEvent({
        type: 'error',
        label: 'Vorschläge laden fehlgeschlagen',
        payload: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(false)
    }
  }, [enabled, scope])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { data, stats, loading, error, refresh: fetchData }
}
