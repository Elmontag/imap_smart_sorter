import React, { useEffect, useMemo, useState } from 'react'
import { AnalysisModule, Suggestion, TagSlotConfig, createFolder, decide, decideProposal, moveOne } from '../api'

interface Props {
  suggestion: Suggestion
  onActionComplete: () => Promise<void> | void
  tagSlots?: TagSlotConfig[]
  availableFolders?: string[]
  onFolderCreated?: (folder: string) => Promise<void> | void
  analysisModule: AnalysisModule
}

type BusyState = 'simulate' | 'accept' | 'reject' | 'proposal-accept' | 'proposal-reject' | null

type StatusTone = 'open' | 'done' | 'error'

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'Unbekannter Fehler'))

const formatScore = (value: number) => value.toFixed(2)

const DEFAULT_TAG_SLOTS: TagSlotConfig[] = [
  { name: 'Komplexität', options: [], aliases: [] },
  { name: 'Priorität', options: [], aliases: [] },
  { name: 'Handlungsauftrag', options: [], aliases: [] },
]

const fallbackTarget = (suggestion: Suggestion) =>
  suggestion.proposal?.full_path ??
  suggestion.category?.matched_folder ??
  suggestion.ranked?.[0]?.name ??
  suggestion.proposal?.name ??
  suggestion.src_folder ??
  ''

export default function SuggestionCard({
  suggestion,
  onActionComplete,
  tagSlots,
  availableFolders = [],
  onFolderCreated,
  analysisModule,
}: Props): JSX.Element {
  const [target, setTarget] = useState<string>(fallbackTarget(suggestion))
  const [busy, setBusy] = useState<BusyState>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState(suggestion.proposal ?? null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [recentlyCreated, setRecentlyCreated] = useState<string[]>([])

  const statusInfo = useMemo((): { label: string; tone: StatusTone; detail: string | null } => {
    const baseStatus = (suggestion.status ?? 'open').toLowerCase()
    const moveStatus = (suggestion.move_status ?? '').toLowerCase()
    if (baseStatus === 'decided') {
      if (moveStatus === 'moved') {
        return {
          label: 'Verschoben',
          tone: 'done',
          detail: 'Bereits verschoben – neue Entscheidungen überschreiben das Ergebnis.',
        }
      }
      if (moveStatus === 'rejected') {
        return {
          label: 'Abgelehnt',
          tone: 'done',
          detail: 'Vorschlag verworfen – du kannst neu zuordnen.',
        }
      }
      if (moveStatus === 'failed') {
        return {
          label: 'Fehlgeschlagen',
          tone: 'error',
          detail: suggestion.move_error
            ? `Verschieben fehlgeschlagen: ${suggestion.move_error}`
            : 'Verschieben fehlgeschlagen – bitte prüfen.',
        }
      }
      return {
        label: 'Bearbeitet',
        tone: 'done',
        detail: 'Entscheidung gespeichert – du kannst sie bei Bedarf anpassen.',
      }
    }
    if (baseStatus === 'error') {
      return {
        label: 'Fehler',
        tone: 'error',
        detail: suggestion.move_error ?? 'Bitte prüfen und erneut versuchen.',
      }
    }
    return { label: 'Offen', tone: 'open', detail: null }
  }, [suggestion.status, suggestion.move_status, suggestion.move_error])

  useEffect(() => {
    setTarget(fallbackTarget(suggestion))
    setProposal(suggestion.proposal ?? null)
    setRecentlyCreated([])
  }, [suggestion.message_uid, suggestion.proposal])

  const effectiveFolders = useMemo(() => {
    const combined = [...availableFolders, ...recentlyCreated]
    const seen = new Set<string>()
    return combined.filter(folder => {
      const trimmed = folder.trim()
      if (!trimmed || seen.has(trimmed)) {
        return false
      }
      seen.add(trimmed)
      return true
    })
  }, [availableFolders, recentlyCreated])

  const availableSet = useMemo(() => new Set(effectiveFolders), [effectiveFolders])
  const normalizedTarget = target.trim()
  const targetExists = !normalizedTarget || availableSet.has(normalizedTarget)

  const created = useMemo(() => {
    if (!suggestion.date) return null
    const parsed = new Date(suggestion.date)
    return Number.isNaN(parsed.getTime()) ? suggestion.date : parsed.toLocaleString('de-DE')
  }, [suggestion.date])

  const showAiContext = analysisModule !== 'STATIC'
  const topScore = suggestion.ranked?.[0]?.score ?? null
  const topReason = suggestion.ranked?.[0]?.reason ?? null
  const category = suggestion.category ?? null
  const categoryLabel = category?.label ?? null
  const categoryMatch = category?.matched_folder ?? null
  const categoryConfidence =
    typeof category?.confidence === 'number' && !Number.isNaN(category.confidence) ? category.confidence : null
  const categoryReason = category?.reason ?? null
  const hasTagField = Object.prototype.hasOwnProperty.call(suggestion, 'tags')
  const slotDefinitions = useMemo(() => {
    if (Array.isArray(tagSlots) && tagSlots.length > 0) {
      return tagSlots
    }
    return DEFAULT_TAG_SLOTS
  }, [tagSlots])
  const rawTags = Array.isArray(suggestion.tags) ? suggestion.tags : []
  const tagCategories = slotDefinitions.map((slot, index) => {
    const raw = rawTags[index]
    const value = typeof raw === 'string' ? raw.trim() : ''
    return { label: slot.name, value: value || null }
  })
  const extraTags = rawTags.slice(slotDefinitions.length)
    .map(tag => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(tag => tag.length > 0)
  const hasAnyTagValues = tagCategories.some(item => item.value) || extraTags.length > 0

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
      setFeedback(
        folderOk
          ? 'Ordner vorhanden – bereit zum Verschieben.'
          : 'Ordner existiert nicht – bitte über „Ordner erstellen“ anlegen.',
      )
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

  const handleProposalDecision = async (accept: boolean) => {
    if (!proposal) {
      return
    }
    setBusy(accept ? 'proposal-accept' : 'proposal-reject')
    setFeedback(null)
    setError(null)
    try {
      const result = await decideProposal(suggestion.message_uid, accept)
      if (result.proposal) {
        setProposal(result.proposal)
        if (accept) {
          const createdPath =
            result.proposal.full_path ??
            (result.proposal.parent && result.proposal.name
              ? `${result.proposal.parent}/${result.proposal.name}`
              : null)
          if (createdPath) {
            setTarget(createdPath)
            setFeedback(`Ordner angelegt: ${createdPath}`)
            setRecentlyCreated(current => (current.includes(createdPath) ? current : [...current, createdPath]))
            if (onFolderCreated) {
              await onFolderCreated(createdPath)
            }
          } else {
            setError('Ordner konnte nicht angelegt werden: fehlende Pfadangaben.')
          }
        } else {
          setFeedback('Ordner-Vorschlag verworfen.')
        }
      }
      await onActionComplete()
    } catch (err) {
      setError(`Vorschlag konnte nicht verarbeitet werden: ${toMessage(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleCreateFolder = async () => {
    const path = normalizedTarget
    if (!path) {
      setError('Bitte zuerst einen Zielordner angeben.')
      return
    }
    setCreatingFolder(true)
    setFeedback(null)
    setError(null)
    try {
      const response = await createFolder(path)
      if (response.existed) {
        setFeedback('Ordner ist bereits vorhanden.')
      } else {
        setTarget(response.created)
        setFeedback(`Ordner angelegt: ${response.created}`)
        setRecentlyCreated(current =>
          current.includes(response.created) ? current : [...current, response.created],
        )
        if (onFolderCreated) {
          await onFolderCreated(response.created)
        }
      }
    } catch (err) {
      setError(`Ordner konnte nicht angelegt werden: ${toMessage(err)}`)
    } finally {
      setCreatingFolder(false)
    }
  }

  const cardClass = statusInfo.tone === 'open' ? 'suggestion-card' : `suggestion-card state-${statusInfo.tone}`

  return (
    <article className={cardClass}>
      <header>
        <div className="subject-row">
          <div className="subject" title={suggestion.subject ?? undefined}>
            {suggestion.subject || '(kein Betreff)'}
          </div>
          <span className={`suggestion-status ${statusInfo.tone}`}>{statusInfo.label}</span>
        </div>
        {suggestion.from_addr && <div className="meta">{suggestion.from_addr}</div>}
        {created && <div className="meta">Empfangen: {created}</div>}
        {suggestion.src_folder && <div className="badge">Quelle: {suggestion.src_folder}</div>}
        {showAiContext && categoryLabel && (
          <div className="category-info">
            <span className="category-label">Überbegriff:</span>
            <strong>{categoryLabel}</strong>
            {categoryConfidence !== null && (
              <span className="category-confidence">· {(categoryConfidence * 100).toFixed(0)}%</span>
            )}
            {categoryMatch && <span className="category-match">→ {categoryMatch}</span>}
            {categoryReason && <div className="category-reason">{categoryReason}</div>}
          </div>
        )}
      </header>

      {statusInfo.detail && (
        <div className={`feedback ${statusInfo.tone === 'error' ? 'error' : 'info'}`}>{statusInfo.detail}</div>
      )}

      {showAiContext && topScore !== null && (
        <div className="score">
          Empfohlener Ordner: {suggestion.ranked?.[0]?.name ?? '–'} (Score {formatScore(topScore)})
          {topReason && <span className="score-reason"> – {topReason}</span>}
        </div>
      )}

      {showAiContext && suggestion.ranked && suggestion.ranked.length > 1 && (
        <div className="alternatives" aria-label="Weitere Vorschläge">
          {suggestion.ranked.slice(1).map(item => (
            <span key={item.name} className="alt-badge">
              {item.name} · {formatScore(item.score)}
              {item.reason ? ` – ${item.reason}` : ''}
            </span>
          ))}
        </div>
      )}

      {showAiContext && hasTagField && (
        <div className="tag-list" aria-label="Erkannte Tag-Kategorien">
          {tagCategories.map(item => (
            <span key={item.label} className={`tag-badge${item.value ? '' : ' empty'}`}>
              <span className="tag-label">{item.label}</span>
              <strong>{item.value ?? '–'}</strong>
            </span>
          ))}
          {extraTags.length > 0 && (
            <div className="tag-extras" aria-label="Zusätzliche Kontext-Tags">
              {extraTags.map(tag => (
                <span key={tag} className="tag-extra">{tag}</span>
              ))}
            </div>
          )}
          {!hasAnyTagValues && <span className="tag-hint">Noch keine konkreten Tags ermittelt.</span>}
        </div>
      )}

      {proposal && (
        <div className="proposal">
          <div className="proposal-text">
            Neuer Ordner-Vorschlag: <code>{proposal.full_path ?? `${proposal.parent}/${proposal.name}`}</code>
            {proposal.reason ? ` · ${proposal.reason}` : ''}
          </div>
          {proposal.status === 'pending' && (
            <div className="proposal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => handleProposalDecision(true)}
                disabled={busy !== null}
              >
                {busy === 'proposal-accept' ? 'Lege an…' : 'Ordner anlegen'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => handleProposalDecision(false)}
                disabled={busy !== null}
              >
                {busy === 'proposal-reject' ? 'Verwerfe…' : 'Vorschlag ablehnen'}
              </button>
            </div>
          )}
          {proposal.status && proposal.status !== 'pending' && (
            <div className={`proposal-status ${proposal.status}`}>
              {proposal.status === 'accepted' ? 'Ordner wurde angelegt.' : 'Vorschlag verworfen.'}
            </div>
          )}
        </div>
      )}

      <label className={`target-input${targetExists ? '' : ' missing'}`}>
        <span>Zielordner</span>
        <input value={target} onChange={event => setTarget(event.target.value)} placeholder="Ordnerpfad" />
      </label>

      {!targetExists && (
        <div className="target-warning" role="status">
          <span>Dieser Ordner existiert noch nicht.</span>
          <button
            type="button"
            className="ghost"
            onClick={handleCreateFolder}
            disabled={creatingFolder || !normalizedTarget}
          >
            {creatingFolder ? 'Lege an…' : 'Ordner erstellen'}
          </button>
        </div>
      )}

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
