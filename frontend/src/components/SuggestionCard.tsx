import React, { useMemo, useState } from 'react'
import { Suggestion, decide, moveOne } from '../api'

interface Props {
  suggestion: Suggestion
  onActionComplete: () => Promise<void> | void
}

type BusyState = 'simulate' | 'accept' | 'reject' | null

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

const formatScore = (value: number) => value.toFixed(2)

const fallbackTarget = (suggestion: Suggestion) =>
  suggestion.ranked?.[0]?.name ?? suggestion.proposal?.name ?? suggestion.src_folder ?? ''

export default function SuggestionCard({ suggestion, onActionComplete }: Props): JSX.Element {
  const [target, setTarget] = useState<string>(fallbackTarget(suggestion))
  const [busy, setBusy] = useState<BusyState>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const created = useMemo(() => {
    if (!suggestion.date) return null
    const parsed = new Date(suggestion.date)
    return Number.isNaN(parsed.getTime()) ? suggestion.date : parsed.toLocaleString('de-DE')
  }, [suggestion.date])

  const topScore = suggestion.ranked?.[0]?.score ?? null

  const handleSimulate = async () => {
    if (!target) {
      setError('Bitte zuerst einen Zielordner angeben.')
      return
    }
    setBusy('simulate')
    setFeedback(null)
    setError(null)
    try {
      const result = await moveOne(suggestion.message_uid, target, true)
      const folderOk = Boolean(result.checks && result.checks['folder_exists'])
      setFeedback(folderOk ? 'Ordner vorhanden – bereit zum Verschieben.' : 'Ordner existiert nicht.')
    } catch (err) {
      setError(`Simulation fehlgeschlagen: ${toMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleDecision = async (decision: 'accept' | 'reject') => {
    if (!target && decision === 'accept') {
      setError('Zum Bestätigen wird ein Zielordner benötigt.')
      return
    }
    setBusy(decision)
    setFeedback(null)
    setError(null)
    try {
      await decide(suggestion.message_uid, target, decision, false)
      setFeedback(decision === 'accept' ? 'Aktion gespeichert.' : 'Vorschlag verworfen.')
      await onActionComplete()
    } catch (err) {
      setError(`Aktion fehlgeschlagen: ${toMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="suggestion-card">
      <header>
        <div className="subject" title={suggestion.subject ?? undefined}>
          {suggestion.subject || '(kein Betreff)'}
        </div>
        {suggestion.from_addr && <div className="meta">{suggestion.from_addr}</div>}
        {created && <div className="meta">Empfangen: {created}</div>}
        {suggestion.src_folder && <div className="badge">Quelle: {suggestion.src_folder}</div>}
      </header>

      {topScore !== null && (
        <div className="score">Empfohlener Ordner: {suggestion.ranked?.[0]?.name ?? '–'} (Score {formatScore(topScore)})</div>
      )}

      {suggestion.ranked && suggestion.ranked.length > 1 && (
        <div className="alternatives" aria-label="Weitere Vorschläge">
          {suggestion.ranked.slice(1).map(item => (
            <span key={item.name} className="alt-badge">
              {item.name} · {formatScore(item.score)}
            </span>
          ))}
        </div>
      )}

      {suggestion.proposal && (
        <div className="proposal">
          Neuer Ordner-Vorschlag: <code>{suggestion.proposal.parent}/{suggestion.proposal.name}</code> · {suggestion.proposal.reason}
        </div>
      )}

      <label className="target-input">
        <span>Zielordner</span>
        <input value={target} onChange={event => setTarget(event.target.value)} placeholder="Ordnerpfad" />
      </label>

      <div className="actions">
        <button type="button" onClick={handleSimulate} disabled={busy !== null}>
          {busy === 'simulate' ? 'Prüfe…' : 'Simulation'}
        </button>
        <button type="button" className="primary" onClick={() => handleDecision('accept')} disabled={busy !== null}>
          {busy === 'accept' ? 'Übernehme…' : 'Bestätigen'}
        </button>
        <button type="button" className="ghost" onClick={() => handleDecision('reject')} disabled={busy !== null}>
          {busy === 'reject' ? 'Verwerfe…' : 'Ablehnen'}
        </button>
      </div>

      {feedback && <div className="feedback success">{feedback}</div>}
      {error && <div className="feedback error">{error}</div>}
    </article>
  )
}
