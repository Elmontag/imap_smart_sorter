import { useCallback, useEffect, useState } from 'react'
import { TagSuggestion, getTagSuggestions } from '../api'
import { recordDevEvent } from '../devtools'

export interface TagSuggestionsState {
  data: TagSuggestion[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useTagSuggestions(): TagSuggestionsState {
  const [data, setData] = useState<TagSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const tags = await getTagSuggestions()
      setData(tags)
      setError(null)
      recordDevEvent({ type: 'ai', label: 'Tag-Vorschläge', payload: tags })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tag-Vorschläge konnten nicht geladen werden.'
      setError(message)
      recordDevEvent({ type: 'error', label: 'Tag-Vorschläge fehlgeschlagen', payload: message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  return { data, loading, error, refresh: fetchData }
}
