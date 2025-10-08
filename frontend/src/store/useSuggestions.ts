import { useCallback, useEffect, useRef, useState } from 'react'
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
  const suggestionsSignatureRef = useRef<string>('')
  const statsSignatureRef = useRef<string>('')

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setData([])
      setStats(null)
      setError(null)
      setLoading(false)
      suggestionsSignatureRef.current = ''
      statsSignatureRef.current = ''
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await getSuggestions(scope)
      const nextStats: SuggestionStats = {
        openCount: result.open_count,
        decidedCount: result.decided_count,
        errorCount: result.error_count,
        totalCount: result.total_count,
      }
      const nextSuggestionsSignature = JSON.stringify(result.suggestions)
      const nextStatsSignature = JSON.stringify(nextStats)

      setData(prev => {
        if (suggestionsSignatureRef.current === nextSuggestionsSignature) {
          return prev
        }
        suggestionsSignatureRef.current = nextSuggestionsSignature
        return result.suggestions
      })

      setStats(prev => {
        if (statsSignatureRef.current === nextStatsSignature && prev !== null) {
          return prev
        }
        statsSignatureRef.current = nextStatsSignature
        return nextStats
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
