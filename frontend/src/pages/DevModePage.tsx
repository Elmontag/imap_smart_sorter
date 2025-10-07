import React, { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import DevtoolsPanel from '../components/DevtoolsPanel'
import { useAppConfig } from '../store/useAppConfig'
import { useDevMode } from '../devtools'
import { API_BASE_URL, STREAM_WEBSOCKET_URL } from '../api'

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '–'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
}

export default function DevModePage(): JSX.Element {
  const devMode = useDevMode()
  const { data: appConfig, loading, error, refresh } = useAppConfig()

  const frontendEnv = useMemo(
    () => [
      { key: 'Build-Modus', value: import.meta.env.MODE },
      { key: 'Entwicklungsbuild', value: import.meta.env.DEV ? 'ja' : 'nein' },
      { key: 'Produktionsbuild', value: import.meta.env.PROD ? 'ja' : 'nein' },
      { key: 'Vite Base URL', value: import.meta.env.BASE_URL },
      { key: 'API Basis', value: API_BASE_URL },
      { key: 'Stream-Endpunkt', value: STREAM_WEBSOCKET_URL },
      {
        key: 'VITE_DEV_MODE',
        value: String(import.meta.env.VITE_DEV_MODE ?? 'nicht gesetzt'),
      },
    ],
    [],
  )

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-top">
          <div>
            <h1>Developer Console</h1>
            <p className="app-subline">
              Laufzeitparameter, Systemstatus und API-Aktivitäten im Überblick.
            </p>
          </div>
        </div>
        <nav className="primary-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Dashboard
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Einstellungen
          </NavLink>
          <NavLink to="/dev" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Dev-Mode
          </NavLink>
        </nav>
      </header>

      <main className="dev-mode-main">
        {!devMode && (
          <div className="status-banner warning" role="alert">
            <span>Dev-Modus ist nicht aktiv. Aktiviere ihn im Backend oder via Umgebungsvariable.</span>
          </div>
        )}
        {error && (
          <div className="status-banner error" role="alert">
            <span>{error}</span>
            <button type="button" className="link" onClick={() => refresh()}>
              Erneut laden
            </button>
          </div>
        )}
        <section className="dev-mode-grid">
          <article className="dev-card">
            <header>
              <h2>Backend-Konfiguration</h2>
              <span>{loading ? 'lädt…' : 'aktuell'}</span>
            </header>
            {appConfig ? (
              <dl>
                <div>
                  <dt>Dev-Modus</dt>
                  <dd>{appConfig.dev_mode ? 'aktiv' : 'deaktiviert'}</dd>
                </div>
                <div>
                  <dt>Move-Modus</dt>
                  <dd>{appConfig.mode}</dd>
                </div>
                <div>
                  <dt>Analyse-Modul</dt>
                  <dd>{appConfig.analysis_module}</dd>
                </div>
                <div>
                  <dt>Classifier-Modell</dt>
                  <dd>{appConfig.classifier_model}</dd>
                </div>
                <div>
                  <dt>Pending-Limit</dt>
                  <dd>
                    {appConfig.pending_list_limit > 0
                      ? `${appConfig.pending_list_limit} Einträge`
                      : 'kein Limit'}
                  </dd>
                </div>
                <div>
                  <dt>Protected-Tag</dt>
                  <dd>{appConfig.protected_tag ?? '–'}</dd>
                </div>
                <div>
                  <dt>Processed-Tag</dt>
                  <dd>{appConfig.processed_tag ?? '–'}</dd>
                </div>
                <div>
                  <dt>AI-Tag-Präfix</dt>
                  <dd>{appConfig.ai_tag_prefix ?? '–'}</dd>
                </div>
                <div>
                  <dt>Templates</dt>
                  <dd>{appConfig.folder_templates.length} Vorlagen</dd>
                </div>
                <div>
                  <dt>Tag-Slots</dt>
                  <dd>{appConfig.tag_slots.length} Slots</dd>
                </div>
                <div>
                  <dt>Kontext-Tags</dt>
                  <dd>{appConfig.context_tags.length} Einträge</dd>
                </div>
              </dl>
            ) : (
              <p className="muted">Keine Konfiguration geladen.</p>
            )}
          </article>

          <article className="dev-card">
            <header>
              <h2>Ollama-Status</h2>
              {appConfig?.ollama?.last_checked && (
                <span>Stand: {formatDate(appConfig.ollama.last_checked)}</span>
              )}
            </header>
            {appConfig?.ollama ? (
              <div className="dev-card-block">
                <dl>
                  <div>
                    <dt>Host</dt>
                    <dd>{appConfig.ollama.host}</dd>
                  </div>
                  <div>
                    <dt>Erreichbar</dt>
                    <dd>{appConfig.ollama.reachable ? 'ja' : 'nein'}</dd>
                  </div>
                  {appConfig.ollama.message && (
                    <div>
                      <dt>Meldung</dt>
                      <dd>{appConfig.ollama.message}</dd>
                    </div>
                  )}
                </dl>
                <div className="dev-models">
                  {appConfig.ollama.models.map(model => (
                    <article key={model.name} className={`dev-model ${model.available ? 'ready' : 'missing'}`}>
                      <header>
                        <strong>{model.name}</strong>
                        <span>{model.purpose}</span>
                      </header>
                      <dl>
                        <div>
                          <dt>Pull-Status</dt>
                          <dd>{model.pulled ? 'geladen' : 'nicht geladen'}</dd>
                        </div>
                        <div>
                          <dt>Verfügbar</dt>
                          <dd>{model.available ? 'ja' : 'nein'}</dd>
                        </div>
                        {model.digest && (
                          <div>
                            <dt>Digest</dt>
                            <dd>{model.digest}</dd>
                          </div>
                        )}
                        {typeof model.size === 'number' && (
                          <div>
                            <dt>Größe</dt>
                            <dd>{(model.size / (1024 ** 3)).toFixed(2)} GB</dd>
                          </div>
                        )}
                        {model.message && (
                          <div>
                            <dt>Hinweis</dt>
                            <dd>{model.message}</dd>
                          </div>
                        )}
                      </dl>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">Kein Ollama-Status verfügbar.</p>
            )}
          </article>

          <article className="dev-card">
            <header>
              <h2>Frontend-Umgebung</h2>
            </header>
            <dl>
              {frontendEnv.map(entry => (
                <div key={entry.key}>
                  <dt>{entry.key}</dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          </article>
        </section>
      </main>

      <DevtoolsPanel />
    </div>
  )
}
