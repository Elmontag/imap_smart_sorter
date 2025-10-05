import React, { useMemo } from 'react'
import { TagSuggestion } from '../api'

interface TagCanvasProps {
  tags: TagSuggestion[]
  loading: boolean
  error: string | null
  onReload: () => Promise<void> | void
}

const formatDate = (value?: string | null) => {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed.toLocaleString('de-DE')
}

export default function TagCanvas({ tags, loading, error, onReload }: TagCanvasProps): JSX.Element {
  const headline = useMemo(() => {
    if (loading) {
      return 'Tags werden geladen…'
    }
    if (!tags.length) {
      return 'Noch keine vorgeschlagenen Tags'
    }
    return `${tags.length} Tag-Vorschläge`
  }, [loading, tags.length])

  return (
    <section className="tag-canvas" aria-labelledby="tag-canvas-title">
      <div className="tag-canvas-header">
        <div>
          <h2 id="tag-canvas-title">{headline}</h2>
          <p className="tag-canvas-subline">
            Tags werden unabhängig von Ordnerentscheidungen vorgeschlagen und können gesammelt bewertet werden.
          </p>
        </div>
        <button type="button" className="ghost" onClick={onReload} disabled={loading}>
          {loading ? 'Aktualisiere…' : 'Tags aktualisieren'}
        </button>
      </div>

      {error && <div className="status-banner error">{error}</div>}

      {loading && <div className="placeholder">Bitte warten…</div>}

      {!loading && !tags.length && !error && (
        <div className="placeholder">Sobald neue Tags erkannt werden, erscheinen sie hier.</div>
      )}

      {!loading && tags.length > 0 && (
        <div className="tag-grid">
          {tags.map(tag => {
            const lastSeen = formatDate(tag.last_seen)
            return (
              <article key={tag.tag} className="tag-card">
                <header>
                  <h3>{tag.tag}</h3>
                  <div className="tag-meta">
                    <span className="count">{tag.occurrences}× vorgeschlagen</span>
                    {lastSeen && <span className="last-seen">zuletzt {lastSeen}</span>}
                  </div>
                </header>
                {tag.examples.length > 0 && (
                  <ul className="tag-examples" aria-label={`Beispiele für ${tag.tag}`}>
                    {tag.examples.map(example => (
                      <li key={example.message_uid}>
                        <strong>{example.subject || '(kein Betreff)'}</strong>
                        {example.from_addr && <span className="from"> · {example.from_addr}</span>}
                        {example.folder && <span className="folder"> · {example.folder}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
