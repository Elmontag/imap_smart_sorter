import React, { useMemo } from 'react'
import { PendingOverview } from '../api'

interface PendingOverviewPanelProps {
  overview: PendingOverview | null
  loading: boolean
  error: string | null
}

const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(1)} %`

const formatSubject = (subject: string) => (subject.trim().length > 0 ? subject.trim() : '(kein Betreff)')

const formatSender = (sender?: string | null) => sender || 'Unbekannter Absender'

export default function PendingOverviewPanel({ overview, loading, error }: PendingOverviewPanelProps): JSX.Element {
  const pendingCount = overview?.pending_count ?? 0
  const totalMessages = overview?.total_messages ?? 0
  const processedCount = overview?.processed_count ?? 0
  const ratioText = useMemo(() => formatPercent(overview?.pending_ratio ?? 0), [overview?.pending_ratio])

  return (
    <section className="pending-overview">
      <div className="pending-header">
        <div>
          <h2>Offene Mails ohne KI-Vorschlag</h2>
          <p className="pending-subline">
            Übersicht über Nachrichten, die noch nicht verarbeitet wurden.
          </p>
        </div>
        <div className="pending-metrics">
          <div className="pending-metric">
            <span className="label">Offen</span>
            <strong>{pendingCount}</strong>
            <span className="muted">{ratioText}</span>
          </div>
          <div className="pending-metric">
            <span className="label">Bereits verarbeitet</span>
            <strong>{processedCount}</strong>
            <span className="muted">von {totalMessages}</span>
          </div>
        </div>
      </div>

      {error && <div className="status-banner error">{error}</div>}

      {loading && <div className="pending-placeholder">Live-Status wird geladen…</div>}

      {!loading && !pendingCount && !error && (
        <div className="pending-placeholder">Alle aktuellen Nachrichten wurden bereits analysiert.</div>
      )}

      {!loading && pendingCount > 0 && (
        <ul className="pending-list">
          {overview?.pending.map(item => (
            <li key={`${item.folder}-${item.message_uid}`} className="pending-item">
              <div className="pending-item-header">
                <span className="pending-subject">{formatSubject(item.subject)}</span>
                <span className="pending-folder">{item.folder}</span>
              </div>
              <div className="pending-item-meta">
                <span>{formatSender(item.from_addr)}</span>
                {item.date && <span className="date">{item.date}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
