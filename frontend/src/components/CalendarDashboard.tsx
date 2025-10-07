import React, { useCallback, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { CalendarEvent, CalendarScanSummary, importCalendarEvent } from '../api'
import { useCalendarOverview } from '../store/useCalendarOverview'

type CalendarView = 'list' | 'day' | 'week' | 'month' | 'year'

type StatusKind = 'info' | 'success' | 'error'

interface StatusMessage {
  kind: StatusKind
  message: string
}

const viewLabels: Record<CalendarView, string> = {
  list: 'Liste',
  day: 'Tag',
  week: 'Woche',
  month: 'Monat',
  year: 'Jahr',
}

const weekdayLabels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

const statusLabel: Record<CalendarEvent['status'], string> = {
  pending: 'Ausstehend',
  imported: 'Importiert',
  failed: 'Fehlgeschlagen',
}

const statusClass: Record<CalendarEvent['status'], string> = {
  pending: 'pending',
  imported: 'imported',
  failed: 'failed',
}

const toDateKey = (value: Date): string => {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const normalizeDate = (value: Date): Date => {
  const normalized = new Date(value)
  normalized.setHours(12, 0, 0, 0)
  return normalized
}

const parseEventDate = (event: CalendarEvent): Date | null => {
  const source = event.local_starts_at ?? event.starts_at ?? event.message_date
  if (!source) {
    return null
  }
  const date = new Date(source)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date
}

const formatDate = (date: Date, options: Intl.DateTimeFormatOptions, timeZone: string) =>
  new Intl.DateTimeFormat('de-DE', { timeZone, ...options }).format(date)

const formatDateRange = (event: CalendarEvent, timeZone: string) => {
  const start = event.local_starts_at ?? event.starts_at
  const end = event.local_ends_at ?? event.ends_at
  if (!start) {
    return 'Kein Datum'
  }
  const startDate = new Date(start)
  if (!end || event.all_day) {
    const dateLabel = formatDate(startDate, { dateStyle: 'long' }, timeZone)
    if (event.all_day) {
      return `${dateLabel} · Ganztägig`
    }
    const timeLabel = formatDate(startDate, { hour: '2-digit', minute: '2-digit' }, timeZone)
    return `${dateLabel} · ${timeLabel}`
  }
  const endDate = new Date(end)
  const sameDay = toDateKey(startDate) === toDateKey(endDate)
  if (sameDay) {
    const dateLabel = formatDate(startDate, { dateStyle: 'long' }, timeZone)
    const startTime = formatDate(startDate, { hour: '2-digit', minute: '2-digit' }, timeZone)
    const endTime = formatDate(endDate, { hour: '2-digit', minute: '2-digit' }, timeZone)
    return `${dateLabel} · ${startTime}–${endTime}`
  }
  const startLabel = formatDate(startDate, { dateStyle: 'short', timeStyle: 'short' }, timeZone)
  const endLabel = formatDate(endDate, { dateStyle: 'short', timeStyle: 'short' }, timeZone)
  return `${startLabel} → ${endLabel}`
}

const eventSortValue = (event: CalendarEvent): number => {
  const date = parseEventDate(event)
  if (date) {
    return date.getTime()
  }
  const fallback = event.last_import_at ?? event.message_date
  if (!fallback) {
    return Number.MAX_SAFE_INTEGER
  }
  const parsed = new Date(fallback)
  return Number.isNaN(parsed.getTime()) ? Number.MAX_SAFE_INTEGER : parsed.getTime()
}

const formatMonthTitle = (date: Date, timeZone: string) =>
  formatDate(date, { month: 'long', year: 'numeric' }, timeZone)

const monthMatrix = (date: Date): (Date | null)[][] => {
  const start = new Date(date.getFullYear(), date.getMonth(), 1)
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  const firstWeekday = (start.getDay() + 6) % 7
  const totalDays = end.getDate()
  const cells: (Date | null)[] = []
  for (let i = 0; i < firstWeekday; i += 1) {
    cells.push(null)
  }
  for (let day = 1; day <= totalDays; day += 1) {
    cells.push(new Date(date.getFullYear(), date.getMonth(), day))
  }
  while (cells.length % 7 !== 0) {
    cells.push(null)
  }
  const weeks: (Date | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }
  return weeks
}

const weekDays = (anchor: Date): Date[] => {
  const start = new Date(anchor)
  const weekday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - weekday)
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}

const yearMonths = (date: Date): Date[] =>
  Array.from({ length: 12 }, (_, index) => new Date(date.getFullYear(), index, 1))

const eventTitle = (event: CalendarEvent) =>
  event.summary || event.subject || `Einladung ${event.event_uid}`

export default function CalendarDashboard(): JSX.Element {
  const { overview, loading, error, refreshing, refresh, rescan } = useCalendarOverview(true)
  const [view, setView] = useState<CalendarView>('month')
  const [selectedDate, setSelectedDate] = useState<Date>(() => normalizeDate(new Date()))
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [lastScan, setLastScan] = useState<CalendarScanSummary | null>(null)
  const [importingId, setImportingId] = useState<number | null>(null)

  const timezone = overview?.timezone ?? 'Europe/Berlin'
  const events = overview?.events ?? []
  const metrics = overview?.metrics

  const sortedEvents = useMemo(() => {
    const list = [...events]
    list.sort((a, b) => eventSortValue(a) - eventSortValue(b))
    return list
  }, [events])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    sortedEvents.forEach(event => {
      const date = parseEventDate(event)
      if (!date) {
        return
      }
      const key = toDateKey(date)
      const bucket = map.get(key)
      if (bucket) {
        bucket.push(event)
      } else {
        map.set(key, [event])
      }
    })
    return map
  }, [sortedEvents])

  const selectedKey = toDateKey(selectedDate)
  const eventsForSelectedDay = eventsByDay.get(selectedKey) ?? []
  const detailDateLabel = useMemo(
    () => formatDate(selectedDate, { dateStyle: 'full' }, timezone),
    [selectedDate, timezone],
  )

  const monthViewDate = useMemo(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1), [selectedDate])
  const monthWeeks = useMemo(() => monthMatrix(monthViewDate), [monthViewDate])
  const weekViewDays = useMemo(() => weekDays(selectedDate), [selectedDate])
  const monthsOfYear = useMemo(() => yearMonths(selectedDate), [selectedDate])

  const monthCounts = useMemo(() => {
    const counts = new Array(12).fill(0)
    sortedEvents.forEach(event => {
      const date = parseEventDate(event)
      if (!date) {
        return
      }
      counts[date.getMonth()] += 1
    })
    return counts
  }, [sortedEvents])

  const showDetailPanel = view === 'week' || view === 'month'

  const dismissStatus = useCallback(() => setStatus(null), [])

  const handleViewChange = useCallback((next: CalendarView) => {
    setView(next)
    if (next === 'year') {
      setSelectedDate(prev => normalizeDate(new Date(prev.getFullYear(), prev.getMonth(), 1)))
    }
  }, [])

  const handleSelectDate = useCallback((value: Date) => {
    setSelectedDate(normalizeDate(value))
  }, [])

  const handleMonthChange = useCallback(
    (offset: number) => {
      setSelectedDate(current => {
        const next = new Date(current.getFullYear(), current.getMonth() + offset, 1)
        return normalizeDate(next)
      })
    },
    [],
  )

  const handleYearChange = useCallback(
    (offset: number) => {
      setSelectedDate(current => {
        const next = new Date(current.getFullYear() + offset, current.getMonth(), 1)
        return normalizeDate(next)
      })
    },
    [],
  )

  const handleRefresh = useCallback(async () => {
    setStatus(null)
    await refresh()
  }, [refresh])

  const handleRescan = useCallback(async () => {
    setStatus(null)
    const result = await rescan()
    if (result) {
      setLastScan(result.scan)
      setStatus({
        kind: 'success',
        message: `Kalender neu gescannt – ${result.scan.processed_events} ICS-Dateien geprüft, ${result.scan.created} neu erfasst, ${result.scan.updated} aktualisiert.`,
      })
    }
  }, [rescan])

  const handleImport = useCallback(
    async (event: CalendarEvent) => {
      setImportingId(event.id)
      setStatus(null)
      try {
        await importCalendarEvent({ event_id: event.id })
        await refresh()
        setStatus({ kind: 'success', message: `Termin „${eventTitle(event)}“ wurde importiert.` })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Import fehlgeschlagen.'
        setStatus({ kind: 'error', message })
      } finally {
        setImportingId(null)
      }
    },
    [refresh],
  )

  const renderEventActions = useCallback(
    (event: CalendarEvent) => {
      if (event.status === 'imported') {
        return <span className="event-status imported">Bereits importiert</span>
      }
      if (event.status === 'failed') {
        return (
          <button
            type="button"
            className="secondary"
            onClick={() => handleImport(event)}
            disabled={importingId === event.id || refreshing}
          >
            Erneut importieren
          </button>
        )
      }
      return (
        <button
          type="button"
          className="primary"
          onClick={() => handleImport(event)}
          disabled={importingId === event.id || refreshing}
        >
          In Kalender importieren
        </button>
      )
    },
    [handleImport, importingId, refreshing],
  )

  return (
    <div className="calendar-dashboard">
      <header className="calendar-header">
        <div>
          <h2>Kalenderübersicht</h2>
          <p className="calendar-subline">
            Finde Termineinladungen, Absagen und Aktualisierungen aus dem Posteingang und übernimm sie in deinen CalDAV-Kalender.
          </p>
        </div>
        <div className="calendar-header-actions">
          <button type="button" className="secondary" onClick={handleRefresh} disabled={loading || refreshing}>
            Aktualisieren
          </button>
          <button type="button" className="primary" onClick={handleRescan} disabled={refreshing || loading}>
            Neu scannen
          </button>
        </div>
      </header>

      <div className="calendar-meta">
        <div className="calendar-metrics">
          <div className="metric-card">
            <span>Gescannte Mails</span>
            <strong>{metrics?.scanned_mails ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span>Ausstehende Termine</span>
            <strong>{metrics?.pending_events ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span>Importierte Termine</span>
            <strong>{metrics?.imported_events ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span>Fehler beim Import</span>
            <strong>{metrics?.failed_events ?? 0}</strong>
          </div>
          <div className="metric-card">
            <span>Termine gesamt</span>
            <strong>{metrics?.total_events ?? 0}</strong>
          </div>
        </div>
        <div className="calendar-meta-info">
          <span className="calendar-timezone">Zeitzone: {timezone}</span>
          <NavLink to="/settings?tab=calendar" className="link">
            Kalender-Einstellungen anpassen
          </NavLink>
        </div>
      </div>

      {status && (
        <div className={`status-banner ${status.kind}`} role="status">
          <span>{status.message}</span>
          <button className="link" type="button" onClick={dismissStatus}>
            Schließen
          </button>
        </div>
      )}

      {error && <div className="status-banner error">{error}</div>}

      {lastScan && lastScan.errors.length > 0 && (
        <div className="status-banner warning">
          <strong>Fehler beim letzten Scan:</strong>
          <ul>
            {lastScan.errors.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="calendar-view-toggle" role="tablist" aria-label="Kalenderansichten">
        {(['list', 'day', 'week', 'month', 'year'] as CalendarView[]).map(mode => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={view === mode}
            className={`calendar-view-button ${view === mode ? 'active' : ''}`}
            onClick={() => handleViewChange(mode)}
          >
            {viewLabels[mode]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card">Kalenderdaten werden geladen …</div>
      ) : (
        <div className="calendar-content">
          {view === 'list' && (
            <div className="calendar-list">
              {sortedEvents.length === 0 && <div className="card">Keine Termineinladungen gefunden.</div>}
              {sortedEvents.map(event => (
                <details key={`${event.id}-${event.sequence ?? 0}`} className="calendar-event">
                  <summary>
                    <div>
                      <strong>{eventTitle(event)}</strong>
                      <span className="event-meta">{formatDateRange(event, timezone)}</span>
                    </div>
                    <span className={`event-status ${statusClass[event.status]}`}>{statusLabel[event.status]}</span>
                  </summary>
                  <div className="event-body">
                    <dl>
                      <div>
                        <dt>Status</dt>
                        <dd>{event.cancellation ? 'Absage' : statusLabel[event.status]}</dd>
                      </div>
                      <div>
                        <dt>Kalender</dt>
                        <dd>{event.timezone ?? timezone}</dd>
                      </div>
                      {event.organizer && (
                        <div>
                          <dt>Organisator</dt>
                          <dd>{event.organizer}</dd>
                        </div>
                      )}
                      {event.location && (
                        <div>
                          <dt>Ort</dt>
                          <dd>{event.location}</dd>
                        </div>
                      )}
                      {event.subject && (
                        <div>
                          <dt>Betreff</dt>
                          <dd>{event.subject}</dd>
                        </div>
                      )}
                      {event.from_addr && (
                        <div>
                          <dt>Absender</dt>
                          <dd>{event.from_addr}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Ordner</dt>
                        <dd>{event.folder}</dd>
                      </div>
                      {event.last_error && (
                        <div>
                          <dt>Fehler</dt>
                          <dd className="event-error">{event.last_error}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="event-actions">{renderEventActions(event)}</div>
                  </div>
                </details>
              ))}
            </div>
          )}

          {view === 'day' && (
            <div className="calendar-day-view">
              <header>
                <h3>{formatDate(selectedDate, { dateStyle: 'full' }, timezone)}</h3>
              </header>
              {eventsForSelectedDay.length === 0 ? (
                <div className="card">Keine Termine für den ausgewählten Tag.</div>
              ) : (
                <ul className="calendar-day-events">
                  {eventsForSelectedDay.map(event => (
                    <li key={`${event.id}-${event.sequence ?? 0}`} className={`calendar-day-event ${statusClass[event.status]}`}>
                      <div>
                        <strong>{eventTitle(event)}</strong>
                        <span>{formatDateRange(event, timezone)}</span>
                        <span className={`detail-status ${statusClass[event.status]}`}>
                          {event.cancellation ? 'Absage' : statusLabel[event.status]}
                        </span>
                      </div>
                      <div>{renderEventActions(event)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {view === 'week' && (
            <div className="calendar-week-view">
              <header>
                <h3>Woche ab {formatDate(weekViewDays[0], { dateStyle: 'long' }, timezone)}</h3>
              </header>
              <div className="week-grid">
                {weekViewDays.map(day => {
                  const key = toDateKey(day)
                  const eventsForDay = eventsByDay.get(key) ?? []
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`week-day ${toDateKey(selectedDate) === key ? 'active' : ''}`}
                      onClick={() => handleSelectDate(day)}
                    >
                      <div className="week-day-header">
                        <span>{weekdayLabels[(day.getDay() + 6) % 7]}</span>
                        <strong>{day.getDate()}</strong>
                      </div>
                      <div className="week-day-events">
                        {eventsForDay.length === 0 ? (
                          <span className="empty">Keine Termine</span>
                        ) : (
                          eventsForDay.map(event => (
                            <span key={`${event.id}-${event.sequence ?? 0}`} className={`badge ${statusClass[event.status]}`}>
                              {eventTitle(event)}
                            </span>
                          ))
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {view === 'month' && (
            <div className="calendar-month-view">
              <header>
                <div className="month-nav">
                  <button type="button" className="secondary" onClick={() => handleMonthChange(-1)}>
                    Vorheriger Monat
                  </button>
                  <h3>{formatMonthTitle(monthViewDate, timezone)}</h3>
                  <button type="button" className="secondary" onClick={() => handleMonthChange(1)}>
                    Nächster Monat
                  </button>
                </div>
              </header>
              <div className="month-grid">
                {weekdayLabels.map(label => (
                  <div key={label} className="weekday-header">
                    {label}
                  </div>
                ))}
                {monthWeeks.flat().map((day, index) => {
                  if (!day) {
                    return <div key={`empty-${index}`} className="month-cell empty" />
                  }
                  const key = toDateKey(day)
                  const eventsForDay = eventsByDay.get(key) ?? []
                  const isSelected = key === selectedKey
                  return (
                    <button
                      type="button"
                      key={key}
                      className={`month-cell ${eventsForDay.length > 0 ? 'has-events' : ''} ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleSelectDate(day)}
                    >
                      <span className="day-number">{day.getDate()}</span>
                      {eventsForDay.length > 0 && <span className="day-count">{eventsForDay.length}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {view === 'year' && (
            <div className="calendar-year-view">
              <header>
                <div className="month-nav">
                  <button type="button" className="secondary" onClick={() => handleYearChange(-1)}>
                    Vorheriges Jahr
                  </button>
                  <h3>{selectedDate.getFullYear()}</h3>
                  <button type="button" className="secondary" onClick={() => handleYearChange(1)}>
                    Nächstes Jahr
                  </button>
                </div>
              </header>
              <div className="year-grid">
                {monthsOfYear.map((month, index) => {
                  const isActive = month.getMonth() === selectedDate.getMonth()
                  return (
                    <button
                      key={month.toISOString()}
                      type="button"
                      className={`year-month ${isActive ? 'active' : ''}`}
                      onClick={() => handleSelectDate(month)}
                    >
                      <span>{formatDate(month, { month: 'long' }, timezone)}</span>
                      <strong>{monthCounts[index]}</strong>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {showDetailPanel && (
            <aside className="calendar-detail" aria-live="polite">
              <header>
                <div>
                  <h3>{detailDateLabel}</h3>
                  <span>
                    {eventsForSelectedDay.length === 1
                      ? '1 Termin'
                      : `${eventsForSelectedDay.length} Termine`}
                  </span>
                </div>
                <button
                  type="button"
                  className="link"
                  onClick={() => handleViewChange('day')}
                  disabled={view === 'day'}
                >
                  Tagesansicht öffnen
                </button>
              </header>
              {eventsForSelectedDay.length === 0 ? (
                <div className="card subtle">Keine Termine für den ausgewählten Tag.</div>
              ) : (
                <ul className="calendar-detail-list">
                  {eventsForSelectedDay.map(event => (
                    <li
                      key={`${event.id}-${event.sequence ?? 0}`}
                      className={`calendar-detail-item ${statusClass[event.status]}`}
                    >
                        <div className="detail-main">
                          <strong>{eventTitle(event)}</strong>
                          <span>{formatDateRange(event, timezone)}</span>
                          <span className={`detail-status ${statusClass[event.status]}`}>
                            {event.cancellation ? 'Absage' : statusLabel[event.status]}
                          </span>
                          {event.location && <span className="detail-location">{event.location}</span>}
                          {event.cancellation && <span className="detail-cancellation">Absage</span>}
                        </div>
                      <div className="detail-actions">{renderEventActions(event)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
