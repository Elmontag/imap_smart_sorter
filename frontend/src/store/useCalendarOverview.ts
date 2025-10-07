import { useCallback, useEffect, useState } from 'react'
import {
  CalendarOverview,
  CalendarScanResult,
  getCalendarOverview,
  scanCalendarMailbox,
} from '../api'
import { recordDevEvent } from '../devtools'

export interface CalendarOverviewState {
  overview: CalendarOverview | null
  loading: boolean
  error: string | null
  refreshing: boolean
  refresh: () => Promise<void>
  rescan: () => Promise<CalendarScanResult | null>
}

export function useCalendarOverview(auto = true): CalendarOverviewState {
  const [overview, setOverview] = useState<CalendarOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(auto)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getCalendarOverview()
      setOverview(data)
      recordDevEvent({ type: 'calendar', label: 'Kalenderübersicht geladen', payload: data })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kalenderübersicht konnte nicht geladen werden.'
      setError(message)
      recordDevEvent({ type: 'error', label: 'Kalenderübersicht fehlgeschlagen', payload: message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!auto) {
      return
    }
    void load()
  }, [auto, load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const rescan = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const result = await scanCalendarMailbox()
      setOverview(result.overview)
      recordDevEvent({ type: 'calendar', label: 'Kalender neu gescannt', payload: result })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kalenderscan fehlgeschlagen.'
      setError(message)
      recordDevEvent({ type: 'error', label: 'Kalenderscan fehlgeschlagen', payload: message })
      return null
    } finally {
      setRefreshing(false)
    }
  }, [])

  return { overview, loading, error, refreshing, refresh, rescan }
}
