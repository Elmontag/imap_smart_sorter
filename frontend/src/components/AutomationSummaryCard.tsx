import React, { useMemo } from 'react'
import { KeywordFilterActivity } from '../api'

interface Props {
  activity: KeywordFilterActivity | null
  loading: boolean
  error?: string | null
  onReload: () => void
}

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return '–'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return '–'
  }
  return parsed.toLocaleString('de-DE')
}

export default function AutomationSummaryCard({ activity, loading, error, onReload }: Props): JSX.Element {
  const topRules = useMemo(() => activity?.rules.slice(0, 3) ?? [], [activity?.rules])
  const recent = useMemo(() => activity?.recent.slice(0, 5) ?? [], [activity?.recent])

  return (
    <section className="automation-summary-card">
      <div className="automation-header">
        <div>
          <h2>Automatisierte Filter</h2>
          <p className="automation-subline">
            Schlüsselwortregeln greifen vor der KI-Klassifikation und verschieben passende Nachrichten direkt.
          </p>
        </div>
        <button type="button" className="ghost" onClick={onReload} disabled={loading}>
          {loading ? 'Aktualisiere…' : 'Aktualisieren'}
        </button>
      </div>
      {error && <div className="automation-error">{error}</div>}
      <div className="automation-metrics">
        <div className="automation-metric">
          <span className="label">Gesamt</span>
          <strong>{activity ? activity.total_hits : '–'}</strong>
          <span className="muted">automatisch sortierte Mails</span>
        </div>
        <div className="automation-metric">
          <span className="label">Letzte 24 h</span>
          <strong>{activity ? activity.hits_last_24h : '–'}</strong>
          <span className="muted">Sofortzuordnungen</span>
        </div>
        <div className="automation-metric">
          <span className="label">Zeitraum</span>
          <strong>
            {activity ? `${activity.window_days} Tage` : '–'}
          </strong>
          <span className="muted">für die Statistik</span>
        </div>
      </div>
      <div className="automation-columns">
        <div className="automation-column">
          <h3>Regel-Highlights</h3>
          {!topRules.length && <div className="placeholder">Noch keine Treffer vorhanden.</div>}
          {topRules.length > 0 && (
            <ul className="automation-rule-list">
              {topRules.map(rule => (
                <li key={rule.name}>
                  <div className="rule-headline">
                    <span className="rule-name">{rule.name}</span>
                    <span className="rule-count">{rule.count}</span>
                  </div>
                  <div className="rule-meta">Ziel: {rule.target_folder}</div>
                  {rule.tags.length > 0 && <div className="rule-tags">Tags: {rule.tags.join(', ')}</div>}
                  <div className="rule-meta">Zuletzt: {formatDateTime(rule.last_match)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="automation-column">
          <h3>Letzte Aktionen</h3>
          {!recent.length && <div className="placeholder">Keine automatisierten Verschiebungen im Zeitraum.</div>}
          {recent.length > 0 && (
            <ul className="automation-recent-list">
              {recent.map(entry => (
                <li key={`${entry.rule_name}-${entry.message_uid}`}>
                  <div className="recent-headline">
                    <span className="recent-rule">{entry.rule_name}</span>
                    <span className="recent-time">{formatDateTime(entry.matched_at)}</span>
                  </div>
                  <div className="recent-meta">Von {entry.src_folder ?? 'unbekannt'} nach {entry.target_folder}</div>
                  {entry.applied_tags.length > 0 && (
                    <div className="recent-tags">Tags: {entry.applied_tags.join(', ')}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
