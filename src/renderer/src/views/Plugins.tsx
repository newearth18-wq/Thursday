import { useState } from 'react'
import { IMPLEMENTED_PERMISSIONS, PERMISSION_DESCRIPTIONS, type Permission } from '@shared/permissions.js'
import type { PluginRecord } from '@shared/schemas.js'
import { useAction, useStore } from '../state/store.js'

/** Installed plugins: enable/disable, health, permissions, and their skills. */
export function Plugins(): JSX.Element {
  const { plugins, skills } = useStore()
  const api = window.thursday
  const action = useAction()
  const [installDir, setInstallDir] = useState('')

  return (
    <div className="panel">
      <div className="panel-head">
        <h1 className="panel-title">Plugins</h1>
        <p className="panel-sub">
          Each enabled plugin runs in its own process. A plugin that fails is isolated — it takes its skills
          offline and nothing else.
        </p>
      </div>

      {action.error ? <div className="notice err">{action.error}</div> : null}
      {action.ok ? <div className="notice ok">{action.ok}</div> : null}

      {plugins.length === 0 ? (
        <div className="card">
          <div className="empty">No plugins installed.</div>
        </div>
      ) : (
        plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            skillCount={skills.filter((skill) => skill.pluginId === plugin.id).length}
            busy={action.busy}
            onAct={(work) => void action.run(work)}
          />
        ))
      )}

      <div className="card">
        <h2 className="card-title">Install from a directory</h2>
        <p className="panel-sub" style={{ marginBottom: 10 }}>
          Point Thursday at a folder containing <code>manifest.json</code> and the compiled entry file. It is
          copied into the user plugin directory and started immediately.
        </p>
        <div className="field">
          <label>Plugin directory</label>
          <input
            className="mono"
            value={installDir}
            placeholder="/path/to/my-plugin"
            onChange={(event) => setInstallDir(event.target.value)}
          />
        </div>
        <button
          className="btn primary"
          disabled={action.busy || !installDir.trim()}
          onClick={() =>
            void action.run(async () => {
              const result = await api['plugins:install']({ dir: installDir.trim() })
              if (!result.ok) throw new Error(result.error ?? 'The install failed')
              setInstallDir('')
              return `Installed "${result.pluginId}"`
            })
          }
        >
          Install plugin
        </button>
      </div>

      <div className="card">
        <h2 className="card-title">Registered skills ({skills.length})</h2>
        {skills.length === 0 ? (
          <div className="empty">No skills registered. Enable a healthy plugin to add some.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Skill id</th>
                <th>Name</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.id}>
                  <td className="mono">{skill.id}</td>
                  <td>{skill.name}</td>
                  <td style={{ color: 'var(--text-faint)' }}>{skill.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function PluginCard({
  plugin,
  skillCount,
  busy,
  onAct
}: {
  plugin: PluginRecord
  skillCount: number
  busy: boolean
  onAct(work: () => Promise<string | void>): void
}): JSX.Element {
  const api = window.thursday
  const [testSkill, setTestSkill] = useState('')
  const [testInput, setTestInput] = useState('{}')
  const [testResult, setTestResult] = useState<string | null>(null)
  const { skills } = useStore()
  const pluginSkills = skills.filter((skill) => skill.pluginId === plugin.id)

  const toggle = (permission: Permission, on: boolean): void =>
    onAct(async () => {
      const next = on
        ? [...plugin.grantedPermissions, permission]
        : plugin.grantedPermissions.filter((entry) => entry !== permission)
      await api['plugins:grantPermissions']({ id: plugin.id, permissions: next })
      await api['plugins:reload']({ id: plugin.id })
      return `Permissions updated for ${plugin.name}`
    })

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {plugin.name} <span className="mono" style={{ color: 'var(--text-faint)' }}>v{plugin.version}</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{plugin.description}</div>
          <div className="mono" style={{ color: 'var(--text-faint)', marginTop: 4 }}>{plugin.dir}</div>
        </div>
        <span className={`badge ${plugin.health === 'ok' ? 'ok' : plugin.health === 'disabled' ? 'off' : plugin.health === 'starting' ? 'info' : 'err'}`}>
          {plugin.health}
        </span>
      </div>

      {plugin.error ? <div className="notice err">{plugin.error}</div> : null}

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            onAct(async () => {
              await api['plugins:setEnabled']({ id: plugin.id, enabled: !plugin.enabled })
              return `${plugin.name} ${plugin.enabled ? 'disabled' : 'enabled'}`
            })
          }
        >
          {plugin.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            onAct(async () => {
              await api['plugins:reload']({ id: plugin.id })
              return `${plugin.name} reloaded`
            })
          }
        >
          Reload
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() =>
            onAct(async () => {
              await api['plugins:uninstall']({ id: plugin.id })
              return `${plugin.name} uninstalled`
            })
          }
        >
          Uninstall
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          {skillCount} skill{skillCount === 1 ? '' : 's'} registered
        </span>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 7 }}>
          Declared permissions — a plugin can never receive one it did not declare
        </div>
        {plugin.permissions.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>None declared.</div>
        ) : (
          <div className="list">
            {plugin.permissions.map((permission) => {
              const granted = plugin.grantedPermissions.includes(permission)
              const implemented = IMPLEMENTED_PERMISSIONS.includes(permission)
              return (
                <label className="row" key={permission} style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={granted}
                    disabled={busy}
                    style={{ width: 'auto' }}
                    onChange={(event) => toggle(permission, event.target.checked)}
                  />
                  <div className="row-main">
                    <div className="row-title mono">{permission}</div>
                    <div className="row-sub">{PERMISSION_DESCRIPTIONS[permission]}</div>
                  </div>
                  {!implemented ? <span className="badge off">declared only</span> : null}
                  <span className={`badge ${granted ? 'ok' : 'off'}`}>{granted ? 'granted' : 'denied'}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {pluginSkills.length > 0 ? (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 7 }}>Try a skill</div>
          <div className="field">
            <select value={testSkill} onChange={(event) => setTestSkill(event.target.value)}>
              <option value="">— choose a skill —</option>
              {pluginSkills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.id}
                </option>
              ))}
            </select>
          </div>
          {testSkill ? (
            <>
              <div className="field">
                <label>Input JSON</label>
                <textarea className="mono" value={testInput} onChange={(event) => setTestInput(event.target.value)} />
                <span className="hint">
                  Schema: {JSON.stringify(pluginSkills.find((skill) => skill.id === testSkill)?.inputSchema)}
                </span>
              </div>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  onAct(async () => {
                    let parsed: Record<string, unknown>
                    try {
                      parsed = JSON.parse(testInput) as Record<string, unknown>
                    } catch (err) {
                      throw new Error(`Input is not valid JSON: ${(err as Error).message}`)
                    }
                    const result = await api['skills:invoke']({ skillId: testSkill, input: parsed })
                    setTestResult(JSON.stringify(result, null, 2))
                  })
                }
              >
                Run skill
              </button>
              {testResult ? (
                <pre className="mono" style={{ marginTop: 10, whiteSpace: 'pre-wrap', color: 'var(--text-dim)', userSelect: 'text' }}>
                  {testResult}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
