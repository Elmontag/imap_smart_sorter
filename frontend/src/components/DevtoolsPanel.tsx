import React, { useMemo } from 'react'
import { DevEvent, isDevMode, useDevEvents, useDevMode } from '../devtools'

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const stringifyPayload = (payload: unknown): string => {
  try {
    return JSON.stringify(payload, null, 2)
  } catch (error) {
    return String(payload)
  }
}

export default function DevtoolsPanel(): JSX.Element | null {
  const devMode = useDevMode()
  const events = useDevEvents()

  const ordered = useMemo(() => [...events].reverse(), [events])

  if (!devMode || !isDevMode()) {
    return null
  }

  return (
    <section className="devtools-panel" aria-live="polite">
      <div className="devtools-header">
        <h2>Dev-Debugger</h2>
        <span>{ordered.length} Events</span>
      </div>
      <div className="devtools-log">
        {ordered.length === 0 && <div className="pending-placeholder">Noch keine Aktivitäten protokolliert.</div>}
        {ordered.map((event: DevEvent) => (
          <article key={event.id} className={`dev-entry ${event.type}`}>
            <header>
              <strong>{event.type.toUpperCase()}</strong>
              <span>{formatTime(event.timestamp)}</span>
            </header>
            <div className="dev-body">
              <div className="dev-label">{event.label}</div>
              {event.details && <div className="dev-details">{event.details}</div>}
              {event.payload !== undefined && (
                <pre className="dev-payload">{stringifyPayload(event.payload)}</pre>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
