import React, { useEffect, useMemo, useState } from 'react'
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
  const limitActive = overview?.limit_active ?? Boolean(overview?.list_limit && overview.list_limit > 0)
  const limitDisabled = !limitActive && (overview?.list_limit ?? null) === 0
  const entries = overview?.pending ?? []
  const itemsPerPage = 10
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(entries.length / itemsPerPage))

  useEffect(() => {
    setPage(1)
  }, [entries.length, limitActive])

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const startIndex = (page - 1) * itemsPerPage
  const pageItems = entries.slice(startIndex, startIndex + itemsPerPage)
  const truncated = limitActive && (overview?.displayed_pending ?? entries.length) < pendingCount

  return (
    <section className="pending-overview">
      <div className="pending-header">
        <div>
          <h2>Unbearbeite Mails</h2>
          <p className="pending-subline">Übersicht über alle noch nicht verarbeiteten Nachrichten.</p>
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
        <div className="pending-placeholder">
          {limitDisabled
            ? 'Detailansicht deaktiviert (PENDING_LIST_LIMIT=0). Zähler bleiben aktiv.'
            : 'Keine unbearbeiteten Nachrichten gefunden.'}
        </div>
      )}

      {!loading && pendingCount > 0 && entries.length === 0 && (
        <div className="pending-placeholder">
          {limitDisabled
            ? 'Die Liste der unbearbeiteten Nachrichten ist deaktiviert. Prüfe die Zähler, um den Umfang einzuschätzen.'
            : 'Keine Details verfügbar.'}
        </div>
      )}

      {!loading && pendingCount > 0 && entries.length > 0 && (
        <div className="pending-table-wrapper">
          {truncated && (
            <div className="pending-limit-info">
              Anzeige begrenzt auf {overview?.displayed_pending ?? entries.length} von {pendingCount} Einträgen.
            </div>
          )}
          <table className="pending-table">
            <thead>
              <tr>
                <th>Betreff</th>
                <th>Ordner</th>
                <th>Absender</th>
                <th>Datum</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map(item => (
                <tr key={`${item.folder}-${item.message_uid}`}>
                  <td data-label="Betreff">{formatSubject(item.subject)}</td>
                  <td data-label="Ordner">{item.folder}</td>
                  <td data-label="Absender">{formatSender(item.from_addr)}</td>
                  <td data-label="Datum">{item.date ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length > itemsPerPage && (
            <div className="pending-pagination" role="navigation" aria-label="Pending Navigation">
              <button type="button" onClick={() => setPage(page - 1)} disabled={page <= 1}>
                Zurück
              </button>
              <span>
                Seite {page} von {totalPages}
              </span>
              <button type="button" onClick={() => setPage(page + 1)} disabled={page >= totalPages}>
                Weiter
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
