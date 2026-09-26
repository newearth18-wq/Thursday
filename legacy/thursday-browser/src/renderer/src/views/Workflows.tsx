import { useEffect, useState } from 'react'
import type { WorkflowDefinition, WorkflowNodeType, WorkflowRun } from '@shared/schemas.js'
import { useAction, useStore } from '../state/store.js'

const NODE_TYPES: { type: WorkflowNodeType; hint: string }[] = [
  { type: 'ai', hint: 'config: { providerId, model, prompt, outputKey }' },
  { type: 'skill', hint: 'config: { skillId, input: {...}, outputKey }' },
  { type: 'condition', hint: 'config: { left, operator, right } — set onTrue / onFalse' },
  { type: 'wait', hint: 'config: { ms }' },
  { type: 'human_approval', hint: 'pauses the run until you approve it below' },
  { type: 'file', hint: 'config: { action: read|write, path, content }' },
  { type: 'browser', hint: 'config: { action: open, url }' },
  { type: 'output', hint: 'config: { value }' }
]

const STARTER = JSON.stringify(
  [
    { id: 'greet', type: 'skill', label: 'Echo a greeting', config: { skillId: 'demo-tools.echo_text', input: { text: 'Hello from a workflow' } } },
    { id: 'stamp', type: 'skill', label: 'Read the clock', config: { skillId: 'demo-tools.get_current_time', input: {} } },
    { id: 'done', type: 'output', label: 'Report', config: { value: '{{greet}} at {{stamp}}' } }
  ],
  null,
  2
)

/**
 * Workflows.
 *
 * Alpha ships the execution model, not a visual canvas: a workflow is a list
 * of nodes defined as JSON and run by the engine.
 */
export function Workflows(): JSX.Element {
  const { skills } = useStore()
  const api = window.thursday
  const action = useAction()
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [name, setName] = useState('Demo workflow')
  const [description, setDescription] = useState('Proves the workflow engine end to end.')
  const [nodesJson, setNodesJson] = useState(STARTER)
  const [editingId, setEditingId] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    setWorkflows(await api['workflows:list']())
    setRuns(await api['workflows:runs']({}))
  }

  useEffect(() => {
    void action.run(reload)
    return api.on('workflow:update', (run) => {
      setRuns((current) => {
        const index = current.findIndex((entry) => entry.id === run.id)
        if (index === -1) return [run, ...current]
        const next = [...current]
        next[index] = run
        return next
      })
    })
  }, [])

  const save = (): void =>
    void action.run(async () => {
      let nodes: unknown[]
      try {
        nodes = JSON.parse(nodesJson) as unknown[]
      } catch (err) {
        throw new Error(`Nodes are not valid JSON: ${(err as Error).message}`)
      }
      if (!Array.isArray(nodes)) throw new Error('Nodes must be a JSON array')
      const saved = await api['workflows:save']({
        id: editingId ?? undefined,
        name: name.trim(),
        description,
        nodes: nodes as never
      })
      setEditingId(null)
      await reload()
      return `Saved "${saved.name}" with ${saved.nodes.length} node(s)`
    })

  return (
    <div className="panel">
      <div className="panel-head">
        <h1 className="panel-title">Workflows</h1>
        <p className="panel-sub">
          A workflow is an ordered list of nodes. Branch with a condition node's <code>onTrue</code> /{' '}
          <code>onFalse</code>; reference earlier results with <code>{'{{nodeId}}'}</code>.
        </p>
      </div>

      {action.error ? <div className="notice err">{action.error}</div> : null}
      {action.ok ? <div className="notice ok">{action.ok}</div> : null}

      <div className="card">
        <h2 className="card-title">Saved workflows</h2>
        {workflows.length === 0 ? (
          <div className="empty">None yet. Define one below and save it.</div>
        ) : (
          <div className="list">
            {workflows.map((workflow) => (
              <div className="row" key={workflow.id}>
                <div className="row-main">
                  <div className="row-title">{workflow.name}</div>
                  <div className="row-sub">{workflow.description || '—'}</div>
                  <div className="row-sub mono">
                    {workflow.nodes.map((node) => `${node.id}:${node.type}`).join(' → ')}
                  </div>
                </div>
                <button
                  className="btn sm primary"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const run = await api['workflows:run']({ workflowId: workflow.id })
                      await reload()
                      return `Run ${run.id.slice(0, 8)} started`
                    })
                  }
                >
                  Run
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setEditingId(workflow.id)
                    setName(workflow.name)
                    setDescription(workflow.description)
                    setNodesJson(JSON.stringify(workflow.nodes, null, 2))
                  }}
                >
                  Edit
                </button>
                <button
                  className="btn sm danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api['workflows:delete']({ id: workflow.id })
                      await reload()
                      return `Deleted "${workflow.name}"`
                    })
                  }
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">{editingId ? 'Edit workflow' : 'New workflow'}</h2>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label>Description</label>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div className="field">
          <label>Nodes (JSON array)</label>
          <textarea
            value={nodesJson}
            style={{ minHeight: 210 }}
            onChange={(event) => setNodesJson(event.target.value)}
          />
          <span className="hint">
            Registered skill ids: {skills.map((skill) => skill.id).join(', ') || 'none'}
          </span>
        </div>
        <div className="btn-row">
          <button className="btn primary" disabled={action.busy || !name.trim()} onClick={save}>
            {editingId ? 'Save changes' : 'Create workflow'}
          </button>
          {editingId ? (
            <button className="btn" onClick={() => { setEditingId(null); setNodesJson(STARTER) }}>
              Cancel
            </button>
          ) : null}
        </div>

        <details style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-faint)' }}>
          <summary style={{ cursor: 'pointer' }}>Node types</summary>
          <table className="data" style={{ marginTop: 8 }}>
            <tbody>
              {NODE_TYPES.map((entry) => (
                <tr key={entry.type}>
                  <td className="mono" style={{ width: 130 }}>{entry.type}</td>
                  <td>{entry.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <div className="card">
        <h2 className="card-title">Recent runs</h2>
        {runs.length === 0 ? (
          <div className="empty">No runs yet.</div>
        ) : (
          <div className="list">
            {runs.slice(0, 10).map((run) => (
              <div className="row" key={run.id} style={{ display: 'grid', gap: 7 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="row-main">
                    <div className="row-title mono">{run.id.slice(0, 8)}</div>
                    <div className="row-sub">
                      {workflows.find((workflow) => workflow.id === run.workflowId)?.name ?? run.workflowId}
                      {run.currentNodeId ? ` · at ${run.currentNodeId}` : ''}
                    </div>
                  </div>
                  <span className={`badge ${runClass(run.status)}`}>{run.status}</span>
                  {run.status === 'waiting_approval' ? (
                    <>
                      <button
                        className="btn sm primary"
                        onClick={() => void action.run(async () => { await api['workflows:approve']({ runId: run.id, approved: true }) })}
                      >
                        Approve
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={() => void action.run(async () => { await api['workflows:approve']({ runId: run.id, approved: false }) })}
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  {run.status === 'running' ? (
                    <button
                      className="btn sm danger"
                      onClick={() => void action.run(async () => { await api['workflows:cancel']({ runId: run.id }) })}
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>

                {run.error ? <div className="notice err" style={{ marginBottom: 0 }}>{run.error}</div> : null}

                {run.log.length > 0 ? (
                  <div>
                    {run.log.map((entry, index) => (
                      <div key={index} className={`log-line ${entry.ok ? 'log-info' : 'log-error'}`}>
                        <span className="log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
                        <span className="log-cat">{entry.nodeId}</span>
                        <span className="log-msg">{entry.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function runClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'ok'
    case 'failed':
      return 'err'
    case 'waiting_approval':
      return 'warn'
    case 'running':
      return 'info'
    default:
      return 'off'
  }
}
