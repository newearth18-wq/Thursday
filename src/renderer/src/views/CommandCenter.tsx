import { useMemo, useState } from 'react'
import type { Mission, MissionStep } from '@shared/schemas.js'
import { Brain } from '../components/Brain.js'
import { useAction, useStore } from '../state/store.js'

/**
 * Thursday Command Center.
 *
 * Shows what the system is doing right now — mission, step, model, skill,
 * plugin health, warnings, recent logs — and gives direct control over it.
 */

export function CommandCenter(): JSX.Element {
  const { command, missions, logs, skills, settings, refreshMissions } = useStore()
  const control = useAction()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const mission = useMemo<Mission | null>(() => {
    if (selectedId) return missions.find((entry) => entry.id === selectedId) ?? null
    return command?.mission ?? null
  }, [selectedId, missions, command])

  const recentLogs = logs.slice(0, 14)
  const brain = command?.brain ?? 'idle'

  const act = (work: () => Promise<unknown>) =>
    control.run(async () => {
      await work()
      await refreshMissions()
    })

  return (
    <div className="panel">
      <div className="panel-head">
        <h1 className="panel-title">Thursday Command Center</h1>
        <p className="panel-sub">Live state of the agent, its mission and its subsystems.</p>
      </div>

      {control.error ? <div className="notice err">{control.error}</div> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 320px) 1fr', gap: 18, alignItems: 'start' }}>
        <div className="card" style={{ display: 'grid', placeItems: 'center', paddingTop: 26, paddingBottom: 20 }}>
          <Brain state={brain} size={250} />
          <div style={{ display: 'grid', gap: 6, width: '100%', marginTop: 16, fontSize: 11.5 }}>
            <div className="meta-row">
              <span className="meta-key">Provider</span>
              <span className="meta-val">{command?.activeProvider ?? '—'}</span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Model</span>
              <span className="meta-val">{command?.activeModel ?? '—'}</span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Active skill</span>
              <span className="meta-val">{command?.activeSkill ?? 'idle'}</span>
            </div>
            <div className="meta-row">
              <span className="meta-key">Skills registered</span>
              <span className="meta-val">{skills.length}</span>
            </div>
          </div>
        </div>

        <div>
          {command && command.warnings.length > 0 ? (
            <div className="card" style={{ borderColor: 'rgba(255,196,87,0.35)' }}>
              <h2 className="card-title" style={{ color: 'var(--amber)' }}>Warnings</h2>
              <div className="list">
                {command.warnings.map((warning) => (
                  <div className="notice warn" key={warning} style={{ marginBottom: 0 }}>
                    {warning}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card">
            <h2 className="card-title">Current mission</h2>
            {mission ? (
              <MissionPanel mission={mission} busy={control.busy} onAct={act} />
            ) : (
              <div className="empty">No missions yet. Create one below to give Thursday something to do.</div>
            )}
          </div>

          <div className="card">
            <h2 className="card-title">Plugin health</h2>
            {command && command.pluginHealth.length > 0 ? (
              <div className="list">
                {command.pluginHealth.map((plugin) => (
                  <div className="row" key={plugin.id}>
                    <div className="row-main">
                      <div className="row-title">{plugin.name}</div>
                      {plugin.error ? <div className="row-sub">{plugin.error}</div> : null}
                    </div>
                    <span className={`badge ${healthClass(plugin.health)}`}>{plugin.health}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">No plugins installed.</div>
            )}
          </div>

          <NewMission
            onCreated={(created) => {
              setSelectedId(created.id)
              void refreshMissions()
            }}
            providerId={settings?.activeProviderId ?? null}
            model={settings?.activeModel ?? null}
          />

          <div className="card">
            <h2 className="card-title">Mission history</h2>
            {missions.length === 0 ? (
              <div className="empty">Nothing yet.</div>
            ) : (
              <div className="list">
                {missions.slice(0, 8).map((entry) => (
                  <button
                    className="row"
                    key={entry.id}
                    style={{ textAlign: 'left', width: '100%' }}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <div className="row-main">
                      <div className="row-title">{entry.title}</div>
                      <div className="row-sub">{entry.goal}</div>
                    </div>
                    <span className="mono" style={{ color: 'var(--text-faint)' }}>{entry.progress}%</span>
                    <span className={`badge ${missionClass(entry)}`}>{entry.status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="card-title">Recent logs</h2>
            {recentLogs.length === 0 ? (
              <div className="empty">No log entries yet.</div>
            ) : (
              recentLogs.map((entry) => (
                <div key={entry.id} className={`log-line log-${entry.level}`}>
                  <span className="log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
                  <span className="log-cat">[{entry.category}]</span>
                  <span className="log-msg">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ mission ------------------------------- */

function MissionPanel({
  mission,
  busy,
  onAct
}: {
  mission: Mission
  busy: boolean
  onAct(work: () => Promise<unknown>): void
}): JSX.Element {
  const api = window.thursday
  const [details, setDetails] = useState(false)
  const running = mission.status === 'EXECUTING' || mission.status === 'PLANNING' || mission.status === 'VERIFYING'
  const startable = mission.status === 'IDLE' || mission.status === 'FAILED' || mission.status === 'CANCELLED'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{mission.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{mission.goal}</div>
        </div>
        <span className={`badge ${missionClass(mission)}`}>{mission.status}</span>
      </div>

      <div className="status-progress" style={{ maxWidth: 'none', marginBottom: 12 }}>
        <div style={{ width: `${mission.progress}%` }} />
      </div>

      <div className="btn-row" style={{ marginBottom: 12 }}>
        {startable ? (
          <button className="btn primary" disabled={busy} onClick={() => onAct(() => api['missions:start']({ id: mission.id }))}>
            Start
          </button>
        ) : null}
        <button
          className="btn"
          disabled={busy || !running}
          onClick={() => onAct(() => api['missions:pause']({ id: mission.id }))}
        >
          Pause
        </button>
        <button
          className="btn"
          disabled={busy || mission.status !== 'PAUSED'}
          onClick={() => onAct(() => api['missions:resume']({ id: mission.id }))}
        >
          Resume
        </button>
        <button
          className="btn danger"
          disabled={busy || ['COMPLETED', 'CANCELLED'].includes(mission.status)}
          onClick={() => onAct(() => api['missions:cancel']({ id: mission.id }))}
        >
          Stop
        </button>
        <button className="btn" onClick={() => setDetails((value) => !value)}>
          {details ? 'Hide details' : 'View details'}
        </button>
      </div>

      <div className="list">
        {mission.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            current={step.id === mission.currentStepId}
            details={details}
            busy={busy}
            onApprove={(approved) =>
              onAct(() =>
                approved
                  ? api['missions:approve']({ missionId: mission.id, stepId: step.id })
                  : api['missions:reject']({ missionId: mission.id, stepId: step.id, reason: 'Rejected from Command Center' })
              )
            }
          />
        ))}
      </div>

      {mission.errors.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          {mission.errors.map((error, index) => (
            <div className="notice err" key={index} style={{ marginBottom: 6 }}>
              {error}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function StepRow({
  step,
  current,
  details,
  busy,
  onApprove
}: {
  step: MissionStep
  current: boolean
  details: boolean
  busy: boolean
  onApprove(approved: boolean): void
}): JSX.Element {
  return (
    <div className={`step ${step.status}${current ? ' current' : ''}`}>
      <span className="step-index">{step.index + 1}</span>
      <div className="step-body">
        <div className="step-title">{step.title}</div>
        <div className="step-meta">
          {step.skillId ? <code>{step.skillId}</code> : 'checkpoint'} · {step.status}
          {step.attempts > 0 ? ` · attempt ${step.attempts}/${step.maxAttempts}` : ''}
        </div>
        {step.error ? <div className="step-meta" style={{ color: 'var(--red)' }}>{step.error}</div> : null}
        {details && step.output !== null ? (
          <pre className="step-meta mono" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(step.output, null, 2)}
          </pre>
        ) : null}
        {details && step.input ? (
          <div className="step-meta mono">input: {JSON.stringify(step.input)}</div>
        ) : null}
      </div>
      {step.status === 'waiting_approval' ? (
        <div className="btn-row">
          <button className="btn primary sm" disabled={busy} onClick={() => onApprove(true)}>
            Approve
          </button>
          <button className="btn danger sm" disabled={busy} onClick={() => onApprove(false)}>
            Reject
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------- mission builder ------------------------- */

interface DraftStep {
  title: string
  skillId: string
  input: string
  requiresApproval: boolean
}

function NewMission({
  onCreated,
  providerId,
  model
}: {
  onCreated(mission: Mission): void
  providerId: string | null
  model: string | null
}): JSX.Element {
  const { skills } = useStore()
  const api = window.thursday
  const action = useAction()
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState<DraftStep[]>([
    { title: '', skillId: '', input: '{}', requiresApproval: false }
  ])

  const update = (index: number, patch: Partial<DraftStep>): void =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)))

  const create = (): void =>
    void action.run(async () => {
      const parsedSteps = steps
        .filter((step) => step.title.trim().length > 0)
        .map((step, index) => {
          let input: Record<string, unknown> = {}
          if (step.input.trim()) {
            try {
              input = JSON.parse(step.input) as Record<string, unknown>
            } catch (err) {
              throw new Error(`Step ${index + 1} input is not valid JSON: ${(err as Error).message}`)
            }
          }
          return {
            title: step.title.trim(),
            skillId: step.skillId || null,
            input,
            requiresApproval: step.requiresApproval,
            maxAttempts: 2
          }
        })

      if (parsedSteps.length === 0) throw new Error('Add at least one step with a title')
      if (!title.trim()) throw new Error('The mission needs a title')
      if (!goal.trim()) throw new Error('The mission needs a goal')

      const mission = await api['missions:create']({ title: title.trim(), goal: goal.trim(), steps: parsedSteps })
      onCreated(mission)
      setTitle('')
      setGoal('')
      setSteps([{ title: '', skillId: '', input: '{}', requiresApproval: false }])
      return `Mission "${mission.title}" created with ${mission.steps.length} step(s)`
    })

  const plan = (): void =>
    void action.run(async () => {
      if (!title.trim() || !goal.trim()) throw new Error('Give the mission a title and a goal first')
      const mission = await api['missions:plan']({
        title: title.trim(),
        goal: goal.trim(),
        providerId: providerId ?? undefined,
        model: model ?? undefined
      })
      onCreated(mission)
      return `Model produced a ${mission.steps.length}-step plan`
    })

  return (
    <div className="card">
      <h2 className="card-title">New mission</h2>
      {action.error ? <div className="notice err">{action.error}</div> : null}
      {action.ok ? <div className="notice ok">{action.ok}</div> : null}

      <div className="field">
        <label>Title</label>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Save a timestamped note" />
      </div>
      <div className="field">
        <label>Goal</label>
        <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What should Thursday achieve?" />
      </div>

      <div className="field">
        <label>Steps</label>
        <div className="list">
          {steps.map((step, index) => (
            <div className="row" key={index} style={{ display: 'grid', gap: 7 }}>
              <input
                value={step.title}
                placeholder={`Step ${index + 1} title`}
                onChange={(event) => update(index, { title: event.target.value })}
              />
              <select value={step.skillId} onChange={(event) => update(index, { skillId: event.target.value })}>
                <option value="">— checkpoint (no skill) —</option>
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.id} — {skill.name}
                  </option>
                ))}
              </select>
              {step.skillId ? (
                <input
                  className="mono"
                  value={step.input}
                  placeholder='{"text":"hello"}'
                  onChange={(event) => update(index, { input: event.target.value })}
                />
              ) : null}
              <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11, color: 'var(--text-dim)' }}>
                <input
                  type="checkbox"
                  checked={step.requiresApproval}
                  style={{ width: 'auto' }}
                  onChange={(event) => update(index, { requiresApproval: event.target.checked })}
                />
                Require approval before running this step
              </label>
            </div>
          ))}
        </div>
        <button
          className="btn sm"
          style={{ justifySelf: 'start', marginTop: 8 }}
          onClick={() => setSteps((current) => [...current, { title: '', skillId: '', input: '{}', requiresApproval: false }])}
        >
          + Add step
        </button>
      </div>

      <div className="btn-row">
        <button className="btn primary" disabled={action.busy} onClick={create}>
          Create mission
        </button>
        <button className="btn" disabled={action.busy || !providerId || !model} onClick={plan} title={!providerId || !model ? 'Choose a provider and model in the sidebar first' : 'Let the model write the plan'}>
          Plan with AI
        </button>
      </div>
    </div>
  )
}

function healthClass(health: string): string {
  if (health === 'ok') return 'ok'
  if (health === 'disabled') return 'off'
  if (health === 'starting') return 'info'
  return 'err'
}

function missionClass(mission: Mission): string {
  switch (mission.status) {
    case 'COMPLETED':
      return 'ok'
    case 'FAILED':
      return 'err'
    case 'WAITING_APPROVAL':
    case 'PAUSED':
      return 'warn'
    case 'EXECUTING':
    case 'PLANNING':
    case 'VERIFYING':
      return 'info'
    default:
      return 'off'
  }
}
