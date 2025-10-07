import { useCallback, useEffect, useState } from 'react'
import {
  CalendarOverview,
  CalendarScanResponse,
  CalendarScanStartResponse,
  CalendarScanStatus,
  CalendarScanStopResponse,
  cancelCalendarRescan,
  getCalendarOverview,
  getCalendarScanStatus,
  runCalendarScan,
  startCalendarAutoScan,
  stopCalendarAutoScan,
} from '../api'
import { recordDevEvent } from '../devtools'

export interface CalendarOverviewState {
  overview: CalendarOverview | null
  loading: boolean
  error: string | null
  refreshing: boolean
  status: CalendarScanStatus | null
  statusLoading: boolean
  refresh: () => Promise<void>
  refreshStatus: () => Promise<void>
  rescan: () => Promise<CalendarScanResponse | null>
  startAuto: () => Promise<CalendarScanStartResponse | null>
  stopAuto: () => Promise<CalendarScanStopResponse | null>
  cancelManual: () => Promise<boolean>
}

export function useCalendarOverview(auto = true): CalendarOverviewState {
  const [overview, setOverview] = useState<CalendarOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(auto)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<CalendarScanStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState<boolean>(auto)

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

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const data = await getCalendarScanStatus()
      setStatus(data)
      recordDevEvent({ type: 'calendar', label: 'Kalenderscan-Status geladen', payload: data })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kalenderscan-Status konnte nicht geladen werden.'
      setError(prev => prev ?? message)
      recordDevEvent({ type: 'error', label: 'Kalenderscan-Status fehlgeschlagen', payload: message })
    } finally {
      setStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!auto) {
      return
    }
    void load()
    void loadStatus()
  }, [auto, load, loadStatus])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([load(), loadStatus()])
    } finally {
      setRefreshing(false)
    }
  }, [load, loadStatus])

  const refreshStatus = useCallback(async () => {
    await loadStatus()
  }, [loadStatus])

  const rescan = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const result = await runCalendarScan()
      setOverview(result.overview)
      setStatus(result.status)
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

  const startAuto = useCallback(async () => {
    setError(null)
    try {
      const response = await startCalendarAutoScan()
      setStatus(response.status)
      recordDevEvent({ type: 'calendar', label: 'Kalender-Autoscan gestartet', payload: response })
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kalender-Autoscan konnte nicht gestartet werden.'
      setError(message)
      recordDevEvent({ type: 'error', label: 'Kalender-Autoscan Start fehlgeschlagen', payload: message })
      return null
    }
  }, [])

  const stopAuto = useCallback(async () => {
    setError(null)
    try {
      const response = await stopCalendarAutoScan()
      setStatus(response.status)
      recordDevEvent({ type: 'calendar', label: 'Kalender-Autoscan gestoppt', payload: response })
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kalender-Autoscan konnte nicht gestoppt werden.'
      setError(message)
      recordDevEvent({ type: 'error', label: 'Kalender-Autoscan Stop fehlgeschlagen', payload: message })
      return null
    }
  }, [])

  const cancelManual = useCallback(async () => {
    try {
      const response = await cancelCalendarRescan()
      setStatus(response.status)
      recordDevEvent({ type: 'calendar', label: 'Kalender-Einzelscan abgebrochen', payload: response })
      return response.cancelled
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kalenderscan konnte nicht abgebrochen werden.'
      setError(prev => prev ?? message)
      recordDevEvent({ type: 'error', label: 'Kalenderabbruch fehlgeschlagen', payload: message })
      return false
    }
  }, [])

  return {
    overview,
    loading,
    error,
    refreshing,
    status,
    statusLoading,
    refresh,
    refreshStatus,
    rescan,
    startAuto,
    stopAuto,
    cancelManual,
  }
}
