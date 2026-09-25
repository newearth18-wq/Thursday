import { useEffect, useState } from 'react'
import type { DiagnosticsReport, LogCategory, LogLevel } from '@shared/schemas.js'
import { useAction, useStore } from '../state/store.js'

const CATEGORIES: LogCategory[] = [
  'CORE', 'BROWSER', 'DB', 'MODEL', 'PLUGIN', 'SKILL', 'WORKFLOW', 'MISSION', 'PERMISSION', 'ERROR'
]
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/** Health of every subsystem, checked live, plus the structured log. */
export function Diagnostics(): JSX.Element {
  const { logs, refreshLogs } = useStore()
  const api = window.thursday
  const action = useAction()
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [category, setCategory] = useState<LogCategory | ''>('')
  const [level, setLevel] = useState<LogLevel | ''>('')
  const [search, setSearch] = useState('')

  const run = (): void =>
    void action.run(async () => {
      setReport(await api['diagnostics:run']())
    })

  useEffect(run, [])

  const filtered = logs.filter(
    (entry) =>
      (!category || entry.category === category) &&
      (!level || entry.level === level) &&
      (!search || entry.message.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <h1 className="panel-title">Diagnostics</h1>
        <p className="panel-sub">Every line below is the result of a check run just now, not a stored assumption.</p>
      </div>

      {action.error ? <div className="notice err">{action.error}</div> : null}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h2 className="card-title" style={{ margin: 0, flex: 1 }}>System health</h2>
          <button className="btn" disabled={action.busy} onClick={run}>
            {action.busy ? 'Checking…' : 'Re-run checks'}
          </button>
        </div>

        {report === null ? (
          <div className="empty">Running checks…</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 200 }}>Component</th>
                <th style={{ width: 110 }}>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((item) => (
                <tr key={item.key}>
                  <td>{item.label}</td>
                  <td>
                    <span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {report ? (
          <div className="mono" style={{ color: 'var(--text-faint)', marginTop: 10 }}>
            Generated {new Date(report.generatedAt).toLocaleString()}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <h2 className="card-title" style={{ margin: 0, flex: 1 }}>Logs</h2>
          <select value={category} onChange={(event) => setCategory(event.target.value as LogCategory | '')} style={{ width: 140 }}>
            <option value="">All categories</option>
            {CATEGORIES.map((entry) => (
              <option key={entry} value={entry}>{entry}</option>
            ))}
          </select>
          <select value={level} onChange={(event) => setLevel(event.target.value as LogLevel | '')} style={{ width: 120 }}>
            <option value="">All levels</option>
            {LEVELS.map((entry) => (
              <option key={entry} value={entry}>{entry}</option>
            ))}
          </select>
          <input
            value={search}
            placeholder="Search messages"
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 200 }}
          />
          <button className="btn sm" onClick={() => void refreshLogs()}>Refresh</button>
          <button
            className="btn sm danger"
            onClick={() =>
              void action.run(async () => {
                await api['logs:clear']()
                await refreshLogs()
              })
            }
          >
            Clear
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">No log entries match.</div>
        ) : (
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            {filtered.map((entry) => (
              <div key={entry.id} className={`log-line log-${entry.level}`}>
                <span className="log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
                <span className="log-cat">[{entry.category}]</span>
                <span className="log-msg">
                  {entry.message}
                  {entry.data ? (
                    <span style={{ color: 'var(--text-faint)' }}> {JSON.stringify(entry.data)}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function statusClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'degraded':
      return 'warn'
    case 'error':
      return 'err'
    default:
      return 'off'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return 'OK'
    case 'degraded':
      return 'Degraded'
    case 'error':
      return 'Error'
    case 'offline':
      return 'Offline'
    case 'disabled':
      return 'Disabled'
    default:
      return 'Unknown'
  }
}
