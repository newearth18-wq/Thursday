import { useEffect, useState } from 'react'
import type { ConnectionResult, LocalAiDetection, ModelInfo, ProviderConfig, ProviderKind } from '@shared/schemas.js'
import { useAction, useStore } from '../state/store.js'

const KINDS: { kind: ProviderKind; label: string; defaultBaseUrl: string; needsKey: boolean; hint: string }[] = [
  { kind: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', needsKey: true, hint: 'Chat Completions API. Models discovered from /models.' },
  { kind: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', needsKey: true, hint: 'Messages API. Models discovered from /models.' },
  { kind: 'gemini', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, hint: 'streamGenerateContent. Models discovered from /models.' },
  { kind: 'openai-compat', label: 'OpenAI-compatible', defaultBaseUrl: '', needsKey: false, hint: 'Any endpoint implementing /chat/completions and /models. Include /v1 in the base URL.' },
  { kind: 'ollama', label: 'Ollama (local)', defaultBaseUrl: 'http://127.0.0.1:11434', needsKey: false, hint: 'No API key needed.' },
  { kind: 'lmstudio', label: 'LM Studio (local)', defaultBaseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, hint: 'Start the LM Studio local server first.' }
]

export function Settings(): JSX.Element {
  const { settings, providers, refreshProviders, patchSettings } = useStore()
  const api = window.thursday
  const [appInfo, setAppInfo] = useState<Awaited<ReturnType<typeof api['app:info']>> | null>(null)

  useEffect(() => {
    void api['app:info']().then(setAppInfo)
  }, [api])

  return (
    <div className="panel">
      <div className="panel-head">
        <h1 className="panel-title">Settings</h1>
        <p className="panel-sub">Providers, local models, and how Thursday starts up.</p>
      </div>

      <ProvidersSection providers={providers} onChanged={refreshProviders} />
      <LocalAiSection onAdded={refreshProviders} />

      <div className="card">
        <h2 className="card-title">General</h2>
        {settings ? (
          <>
            <div className="grid-2">
              <div className="field">
                <label>Startup behaviour</label>
                <select
                  value={settings.startupBehavior}
                  onChange={(event) => void patchSettings({ startupBehavior: event.target.value as 'home' | 'restore' })}
                >
                  <option value="home">Open the home page</option>
                  <option value="restore">Start with a blank tab</option>
                </select>
              </div>
              <div className="field">
                <label>Home page</label>
                <input
                  value={settings.homeUrl}
                  onChange={(event) => void patchSettings({ homeUrl: event.target.value })}
                />
              </div>
              <div className="field">
                <label>Download location</label>
                <input
                  className="mono"
                  value={settings.downloadDir}
                  onChange={(event) => void patchSettings({ downloadDir: event.target.value })}
                />
              </div>
              <div className="field">
                <label>Theme</label>
                <select
                  value={settings.theme}
                  onChange={(event) => void patchSettings({ theme: event.target.value as 'dark' | 'midnight' })}
                >
                  <option value="dark">Dark</option>
                  <option value="midnight">Midnight</option>
                </select>
              </div>
              <div className="field">
                <label>Log entries to keep</label>
                <input
                  type="number"
                  min={100}
                  max={100000}
                  value={settings.logRetention}
                  onChange={(event) => void patchSettings({ logRetention: Number(event.target.value) })}
                />
                <span className="hint">Older entries are trimmed automatically.</span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">Loading…</div>
        )}
      </div>

      {appInfo ? (
        <div className="card">
          <h2 className="card-title">About</h2>
          <table className="data">
            <tbody>
              <tr><td>Version</td><td className="mono">{appInfo.version}</td></tr>
              <tr><td>Electron</td><td className="mono">{appInfo.electron}</td></tr>
              <tr><td>Chromium</td><td className="mono">{appInfo.chrome}</td></tr>
              <tr><td>Node</td><td className="mono">{appInfo.node}</td></tr>
              <tr><td>Platform</td><td className="mono">{appInfo.platform}</td></tr>
              <tr><td>User data</td><td className="mono">{appInfo.userDataDir}</td></tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

/* ----------------------------- providers ------------------------------ */

function ProvidersSection({
  providers,
  onChanged
}: {
  providers: ProviderConfig[]
  onChanged(): Promise<void>
}): JSX.Element {
  const api = window.thursday
  const action = useAction()
  const [editing, setEditing] = useState<string | null>(null)
  const [kind, setKind] = useState<ProviderKind>('openai')
  const [label, setLabel] = useState('OpenAI')
  const [baseUrl, setBaseUrl] = useState(KINDS[0].defaultBaseUrl)
  const [apiKey, setApiKey] = useState('')
  const [results, setResults] = useState<Record<string, ConnectionResult>>({})
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})

  const kindInfo = KINDS.find((entry) => entry.kind === kind) ?? KINDS[0]

  const resetForm = (): void => {
    setEditing(null)
    setKind('openai')
    setLabel('OpenAI')
    setBaseUrl(KINDS[0].defaultBaseUrl)
    setApiKey('')
  }

  const save = (): void =>
    void action.run(async () => {
      const saved = await api['providers:save']({
        id: editing ?? undefined,
        kind,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        ...(apiKey ? { apiKey } : {})
      })
      await onChanged()
      resetForm()
      return `Saved "${saved.label}"`
    })

  return (
    <div className="card">
      <h2 className="card-title">AI providers</h2>
      {action.error ? <div className="notice err">{action.error}</div> : null}
      {action.ok ? <div className="notice ok">{action.ok}</div> : null}

      {providers.length === 0 ? (
        <div className="empty">No providers yet. Add one below.</div>
      ) : (
        <div className="list" style={{ marginBottom: 16 }}>
          {providers.map((provider) => {
            const result = results[provider.id]
            const list = models[provider.id]
            return (
              <div className="row" key={provider.id} style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="row-main">
                    <div className="row-title">
                      {provider.label} <span className="badge off">{provider.kind}</span>
                      {provider.hasApiKey ? <span className="badge ok" style={{ marginLeft: 6 }}>key set</span> : null}
                    </div>
                    <div className="row-sub mono">{provider.baseUrl}</div>
                  </div>
                </div>

                {result ? (
                  <div className={`notice ${result.ok ? 'ok' : 'err'}`} style={{ marginBottom: 0 }}>
                    {result.message}
                    {result.detail ? <div style={{ opacity: 0.8, marginTop: 4 }}>{result.detail}</div> : null}
                  </div>
                ) : null}

                {list ? (
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>{list.length} model(s) fetched</label>
                    <select defaultValue="">
                      <option value="">— browse fetched models —</option>
                      {list.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div className="btn-row">
                  <button
                    className="btn sm"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const outcome = await api['providers:test']({ id: provider.id })
                        setResults((current) => ({ ...current, [provider.id]: outcome }))
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button
                    className="btn sm"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const outcome = await api['providers:models']({ id: provider.id })
                        setModels((current) => ({ ...current, [provider.id]: outcome.models }))
                        if (!outcome.ok) throw new Error(outcome.error ?? 'Could not fetch models')
                        return `Fetched ${outcome.models.length} model(s)`
                      })
                    }
                  >
                    Fetch models
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => {
                      setEditing(provider.id)
                      setKind(provider.kind)
                      setLabel(provider.label)
                      setBaseUrl(provider.baseUrl)
                      setApiKey('')
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn sm danger"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api['providers:delete']({ id: provider.id })
                        await onChanged()
                        return `Deleted "${provider.label}"`
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
          {editing ? 'Edit provider' : 'Add a provider'}
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Type</label>
            <select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as ProviderKind
                const info = KINDS.find((entry) => entry.kind === next)
                setKind(next)
                if (info) {
                  setBaseUrl(info.defaultBaseUrl)
                  if (!editing) setLabel(info.label)
                }
              }}
            >
              {KINDS.map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.label}
                </option>
              ))}
            </select>
            <span className="hint">{kindInfo.hint}</span>
          </div>
          <div className="field">
            <label>Display name</label>
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input className="mono" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </div>
          <div className="field">
            <label>API key {kindInfo.needsKey ? '(required)' : '(optional)'}</label>
            <input
              type="password"
              value={apiKey}
              placeholder={editing ? 'leave blank to keep the stored key' : ''}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="hint">Stored in the OS keychain when one is available.</span>
          </div>
        </div>
        <div className="btn-row">
          <button className="btn primary" disabled={action.busy || !label.trim()} onClick={save}>
            {editing ? 'Save changes' : 'Add provider'}
          </button>
          {editing ? (
            <button className="btn" onClick={resetForm}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ local AI ------------------------------ */

function LocalAiSection({ onAdded }: { onAdded(): Promise<void> }): JSX.Element {
  const api = window.thursday
  const action = useAction()
  const [detections, setDetections] = useState<LocalAiDetection[] | null>(null)

  const detect = (): void =>
    void action.run(async () => {
      setDetections(await api['localai:detect']())
    })

  useEffect(detect, [])

  return (
    <div className="card">
      <h2 className="card-title">Local AI</h2>
      <p className="panel-sub" style={{ marginBottom: 12 }}>
        Thursday probes the well-known local endpoints. A runtime is only reported as detected after a real
        request succeeds.
      </p>
      {action.error ? <div className="notice err">{action.error}</div> : null}

      {detections === null ? (
        <div className="empty">Probing…</div>
      ) : (
        <div className="list">
          {detections.map((detection) => (
            <div className="row" key={detection.kind}>
              <div className="row-main">
                <div className="row-title">{detection.label}</div>
                <div className="row-sub mono">{detection.baseUrl}</div>
                <div className="row-sub">{detection.detail}</div>
              </div>
              <span
                className={`badge ${detection.status === 'detected' ? 'ok' : detection.status === 'error' ? 'err' : 'off'}`}
              >
                {detection.status === 'detected' ? 'Detected' : detection.status === 'error' ? 'Connection error' : 'Not detected'}
              </span>
              {detection.status === 'detected' ? (
                <button
                  className="btn sm"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api['providers:save']({
                        kind: detection.kind,
                        label: detection.label,
                        baseUrl: detection.baseUrl
                      })
                      await onAdded()
                      return `Added ${detection.label} as a provider`
                    })
                  }
                >
                  Add as provider
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={action.busy} onClick={detect}>
          Re-scan
        </button>
      </div>
    </div>
  )
}
