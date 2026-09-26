import { useEffect, useId, useRef, useState } from 'react'
import {
  SkillCategory,
  SkillHealthStatus,
  SkillProvider,
  type ErrorEnvelope,
  type SkillFilter,
  type SkillInfo,
  type SkillResult,
  type SkillSchema
} from '@jupiter/contracts'
import { uuidv7 } from '@jupiter/core'
import { request } from '../api'
import { Select, Switch } from '../components/FormControls'
import { StateMessage } from '../components/StateMessage'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { EXECUTION_TONE, HEALTH_TONE } from '../skillText'
import { useSkill, useSkillList } from '../useSkills'
import { coreSessionOf, envelopeOf, useRuntimeContext, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import { ViewHeader } from './ViewHeader'

/**
 * The Skill Center (SET 6): every registered Skill with its provider,
 * category, enabled state, permissions, version, health, last check and
 * runtime, straight from Jupiter Core's Skill Registry. Low-risk internal
 * Skills can be tried here; the result is the real result of a real run.
 */

type Any = 'any'

/** The Skill last opened, kept while the interface is open (Skill ids are not addresses). */
let lastSkill: string | null = null

export function SkillsView() {
  const { t } = useI18n()
  const { status } = useRuntimeContext()
  const coreSession = coreSessionOf(status)
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<SkillCategory | Any>('any')
  const [provider, setProvider] = useState<SkillProvider | Any>('any')
  const [health, setHealth] = useState<SkillHealthStatus | Any>('any')
  const [selected, setSelected] = useState<string | null>(lastSkill)
  const filter: SkillFilter = {
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(category === 'any' ? {} : { category }),
    ...(provider === 'any' ? {} : { provider }),
    ...(health === 'any' ? {} : { health })
  }
  const skills = useSkillList(filter, coreSession)
  const select = (skillId: string) => {
    lastSkill = skillId
    setSelected(skillId)
  }

  return (
    <section className="view view-skills" aria-labelledby="skills-title">
      <ViewHeader id="skills-title" title={t('nav.skills')} />
      <p className="muted">{t('skills.intro')}</p>
      {coreSession === null ? (
        <StateMessage kind="unavailable" title={t('skills.coreDown')} testId="skills-core-down" />
      ) : null}
      <div className="missions-layout">
        <div className="mission-list-panel">
          <div className="field">
            <label htmlFor={searchId}>{t('skills.search')}</label>
            <input
              id={searchId}
              className="input"
              type="search"
              value={query}
              maxLength={100}
              data-testid="skills-search"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
            />
          </div>
          <div className="skills-filters">
            <Select<SkillCategory | Any>
              label={t('skills.category')}
              testId="skills-filter-category"
              value={category}
              onChange={setCategory}
              choices={[
                { value: 'any', label: t('skills.any') },
                ...SkillCategory.options.map((value) => ({
                  value,
                  label: t(`skillCategory.${value}` as MessageKey)
                }))
              ]}
            />
            <Select<SkillProvider | Any>
              label={t('skills.provider')}
              testId="skills-filter-provider"
              value={provider}
              onChange={setProvider}
              choices={[
                { value: 'any', label: t('skills.any') },
                ...SkillProvider.options.map((value) => ({
                  value,
                  label: t(`skillProvider.${value}` as MessageKey)
                }))
              ]}
            />
            <Select<SkillHealthStatus | Any>
              label={t('skills.health')}
              testId="skills-filter-health"
              value={health}
              onChange={setHealth}
              choices={[
                { value: 'any', label: t('skills.any') },
                ...SkillHealthStatus.options.map((value) => ({
                  value,
                  label: t(`skillHealth.${value}` as MessageKey)
                }))
              ]}
            />
          </div>
          <SkillList skills={skills} selected={selected} onSelect={select} />
        </div>
        <div className="mission-detail-panel">
          {selected === null ? (
            <StateMessage kind="empty" title={t('skills.noneSelected')} testId="skill-none">
              <p>{t('skills.noneSelectedHint')}</p>
            </StateMessage>
          ) : (
            <SkillPanel key={selected} skillId={selected} coreSession={coreSession} />
          )}
        </div>
      </div>
    </section>
  )
}

function Badge({
  tone,
  children,
  testId
}: {
  readonly tone: string
  readonly children: string
  readonly testId?: string
}) {
  return (
    <span className={`badge badge-${tone}`} data-testid={testId}>
      {children}
    </span>
  )
}

function SkillList({
  skills,
  selected,
  onSelect
}: {
  readonly skills: Loadable<SkillInfo[]>
  readonly selected: string | null
  readonly onSelect: (skillId: string) => void
}) {
  const { t } = useI18n()
  if (skills.state === 'loading') return <p className="muted small">{t('load.loading')}</p>
  if (skills.state === 'error')
    return <LoadFailure title={t('skills.listFailed')} error={skills.error} />
  if (skills.value.length === 0)
    return (
      <p className="muted small" data-testid="skills-empty">
        {t('skills.empty')}
      </p>
    )
  return (
    <nav aria-label={t('nav.skills')}>
      <ul className="mission-list" data-testid="skills">
        {skills.value.map((skill) => (
          <li key={skill.definition.skillId}>
            <button
              type="button"
              className="conversation-item mission-item"
              aria-current={skill.definition.skillId === selected ? 'page' : undefined}
              data-testid="skill-item"
              data-skill-id={skill.definition.skillId}
              data-health={skill.health.status}
              data-enabled={skill.enabled}
              onClick={() => {
                onSelect(skill.definition.skillId)
              }}
            >
              <span className="conversation-title">{skill.definition.name}</span>
              <span className="mission-item-meta">
                <Badge tone={HEALTH_TONE[skill.health.status]} testId="skill-item-health">
                  {t(`skillHealth.${skill.health.status}` as MessageKey)}
                </Badge>
                {skill.enabled ? null : <Badge tone="muted">{t('skills.disabled')}</Badge>}
                {skill.definition.provider === 'internal' ? null : (
                  <Badge tone="warning">
                    {t(`skillProvider.${skill.definition.provider}` as MessageKey)}
                  </Badge>
                )}
                <span className="muted small">
                  {skill.definition.skillId} · {skill.definition.version}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function SkillPanel({
  skillId,
  coreSession
}: {
  readonly skillId: string
  readonly coreSession: string | null
}) {
  const { t, locale } = useI18n()
  const { skill, refresh, replace } = useSkill(skillId, coreSession)
  const [busy, setBusy] = useState<'state' | 'health' | null>(null)
  // The switch shows the requested state while Core applies it; Core's answer replaces it.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'medium'
  })
  if (skill.state === 'loading') return <StateMessage kind="loading" title={t('load.loading')} />
  if (skill.state === 'error')
    return (
      <LoadFailure title={t('skills.loadFailed')} error={skill.error} testId="skill-load-failure" />
    )
  const { info, versions, executions } = skill.value
  const { definition } = info

  const act = (kind: 'state' | 'health', work: () => Promise<SkillInfo>) => {
    setBusy(kind)
    setFailure(null)
    work()
      .then(replace)
      .catch((error: unknown) => {
        setFailure(envelopeOf(error))
      })
      .finally(() => {
        setBusy(null)
        setPendingEnabled(null)
      })
  }

  return (
    <article
      className="mission-detail"
      aria-labelledby="skill-detail-title"
      data-testid="skill-detail"
      data-skill-id={definition.skillId}
      data-health={info.health.status}
      data-enabled={info.enabled}
    >
      <header className="mission-detail-header">
        <div>
          <h2 id="skill-detail-title" className="conversation-heading" data-testid="skill-name">
            {definition.name}
          </h2>
          <p className="mission-badges">
            <Badge tone={HEALTH_TONE[info.health.status]} testId="skill-health">
              {t(`skillHealth.${info.health.status}` as MessageKey)}
            </Badge>
            <Badge tone="muted">{t(`skillCategory.${definition.category}` as MessageKey)}</Badge>
            <Badge tone={definition.provider === 'internal' ? 'muted' : 'warning'}>
              {t(`skillProvider.${definition.provider}` as MessageKey)}
            </Badge>
            <Badge tone="muted">{definition.version}</Badge>
          </p>
        </div>
        <div className="actions">
          <Switch
            label={t('skills.enabled')}
            testId="skill-enabled"
            checked={pendingEnabled ?? info.enabled}
            disabled={busy !== null}
            description={pendingEnabled === null ? undefined : t('skills.saving')}
            onChange={(enabled) => {
              setPendingEnabled(enabled)
              act('state', () => request(enabled ? 'skills.enable' : 'skills.disable', { skillId }))
            }}
          />
          <button
            type="button"
            className="button"
            data-testid="skill-health-check"
            disabled={busy !== null}
            onClick={() => {
              act('health', () => request('skills.health-check', { skillId }))
            }}
          >
            {busy === 'health' ? t('skills.checking') : t('skills.checkNow')}
          </button>
        </div>
      </header>

      {failure ? (
        <LoadFailure title={t('skills.actionFailed')} error={failure} testId="skill-action-error" />
      ) : null}

      <p>{definition.description}</p>

      {info.blockedReason ? (
        <div className="notice notice-warning" role="status" data-testid="skill-blocked">
          <p className="notice-title">{t('skills.cannotRun')}</p>
          <p>{info.blockedReason}</p>
        </div>
      ) : null}

      <dl className="facts mission-facts">
        <div>
          <dt>{t('skills.id')}</dt>
          <dd>
            <code>{definition.skillId}</code>
          </dd>
        </div>
        <div>
          <dt>{t('skills.healthDetail')}</dt>
          <dd data-testid="skill-health-detail">{info.health.detail}</dd>
        </div>
        <div>
          <dt>{t('skills.lastCheck')}</dt>
          <dd data-testid="skill-last-check">
            {info.health.checkedAt
              ? t('skills.lastCheckValue', {
                  when: format.format(new Date(info.health.checkedAt)),
                  ms: info.health.durationMs ?? 0
                })
              : t('skills.neverChecked')}
          </dd>
        </div>
        <div>
          <dt>{t('skills.runtime')}</dt>
          <dd data-testid="skill-runtime">
            {t(info.runtimeCompatible ? 'skills.runtimeOk' : 'skills.runtimeIncompatible', {
              needs: definition.compatibleRuntime,
              has: info.runtime
            })}
          </dd>
        </div>
        <div>
          <dt>{t('skills.timeout')}</dt>
          <dd>{t('skills.timeoutValue', { seconds: definition.timeoutMs / 1000 })}</dd>
        </div>
        <div>
          <dt>{t('skills.permissions')}</dt>
          <dd data-testid="skill-permissions">
            {info.permissions.length === 0 ? t('skills.noPermissions') : null}
            {info.permissions.map((permission) => (
              <span
                key={permission.name}
                className="skill-permission"
                data-permission={permission.name}
              >
                <code>{permission.name}</code>{' '}
                <Badge tone={permission.risk === 'LOW' ? 'muted' : 'warning'}>
                  {t(`risk.${permission.risk}` as MessageKey)}
                </Badge>{' '}
                <span className="muted small">
                  {t(permission.granted ? 'skills.granted' : 'skills.notGranted')}
                </span>
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>{t('skills.versions')}</dt>
          <dd data-testid="skill-versions">
            {versions.map((item) => item.definition.version).join(', ')}
          </dd>
        </div>
      </dl>

      <details className="tool-call">
        <summary>{t('skills.schemas')}</summary>
        <p className="small">{t('skills.inputSchema')}</p>
        <pre className="code-block">{JSON.stringify(definition.inputSchema, null, 2)}</pre>
        <p className="small">{t('skills.outputSchema')}</p>
        <pre className="code-block">{JSON.stringify(definition.outputSchema, null, 2)}</pre>
      </details>

      <section aria-labelledby="skill-test-title">
        <h3 id="skill-test-title">{t('skills.test')}</h3>
        {info.testable ? (
          <SkillTester info={info} onFinished={refresh} />
        ) : (
          <p className="muted small" data-testid="skill-not-testable">
            {t('skills.notTestable')}
          </p>
        )}
      </section>

      <section aria-labelledby="skill-history-title">
        <h3 id="skill-history-title">{t('skills.history')}</h3>
        {executions.length === 0 ? (
          <p className="muted small">{t('skills.noHistory')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="skill-history">
              <thead>
                <tr>
                  <th scope="col">{t('skills.startedColumn')}</th>
                  <th scope="col">{t('skills.statusColumn')}</th>
                  <th scope="col">{t('skills.byColumn')}</th>
                  <th scope="col">{t('skills.inputColumn')}</th>
                  <th scope="col">{t('skills.outputColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((execution) => (
                  <tr
                    key={execution.executionId}
                    data-testid="skill-execution"
                    data-status={execution.status}
                  >
                    <td>{format.format(new Date(execution.startedAt))}</td>
                    <td>
                      <Badge tone={EXECUTION_TONE[execution.status]}>
                        {t(`skillStatus.${execution.status}` as MessageKey)}
                      </Badge>{' '}
                      {execution.errorCode ? (
                        <code className="small">{execution.errorCode}</code>
                      ) : null}
                    </td>
                    <td>{t(`actor.${execution.actor}` as MessageKey)}</td>
                    <td className="small">{shape(execution.inputSummary, t)}</td>
                    <td className="small">
                      {execution.outputSummary ? shape(execution.outputSummary, t) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t('skills.historyPrivacy')}</p>
      </section>
    </article>
  )
}

function shape(
  summary: { type: string; size: number | null; fields: readonly string[] },
  t: ReturnType<typeof useI18n>['t']
): string {
  if (summary.type === 'object')
    return summary.fields.length > 0
      ? t('skills.shapeFields', { fields: summary.fields.join(', ') })
      : t('skills.shapeEmpty')
  if (summary.type === 'string') return t('skills.shapeText', { size: summary.size ?? 0 })
  if (summary.type === 'array') return t('skills.shapeList', { size: summary.size ?? 0 })
  return summary.type
}

type FieldValue = string | boolean

function initialValues(schema: SkillSchema): Record<string, FieldValue> {
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, field]) => [
      name,
      field.type === 'boolean' ? false : field.enum?.[0] !== undefined ? String(field.enum[0]) : ''
    ])
  )
}

function inputFrom(
  schema: SkillSchema,
  values: Record<string, FieldValue>
): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const value = values[name]
    if (field.type === 'boolean') input[name] = value === true
    else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value === 'string' && value.trim() !== '') input[name] = Number(value)
    } else if (typeof value === 'string' && (value !== '' || schema.required?.includes(name)))
      input[name] = value
  }
  return input
}

/**
 * The safe test form: a real invocation through Jupiter Core, with the same
 * checks as any other (enabled, healthy, permissions, input schema). Cancel
 * ends the Skill's runtime.
 */
function SkillTester({
  info,
  onFinished
}: {
  readonly info: SkillInfo
  readonly onFinished: () => void
}) {
  const { t } = useI18n()
  const formId = useId()
  const { definition } = info
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    initialValues(definition.inputSchema)
  )
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<SkillResult | null>(null)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  const fields = Object.entries(definition.inputSchema.properties ?? {})

  const run = () => {
    const id = uuidv7()
    setRunning(id)
    setResult(null)
    setFailure(null)
    request('skills.invoke', {
      executionId: id,
      skillId: definition.skillId,
      input: inputFrom(definition.inputSchema, values)
    })
      .then((next) => {
        if (mounted.current) setResult(next)
      })
      .catch((error: unknown) => {
        if (mounted.current) setFailure(envelopeOf(error))
      })
      .finally(() => {
        if (mounted.current) setRunning(null)
        onFinished()
      })
  }

  return (
    <form
      className="dialog-form skill-tester"
      data-testid="skill-test-form"
      onSubmit={(event) => {
        event.preventDefault()
        run()
      }}
    >
      {fields.length === 0 ? <p className="muted small">{t('skills.noInput')}</p> : null}
      {fields.map(([name, field]) => {
        const id = `${formId}-${name}`
        const value = values[name]
        const set = (next: FieldValue) => {
          setValues((current) => ({ ...current, [name]: next }))
        }
        if (field.type === 'boolean')
          return (
            <Switch
              key={name}
              label={name}
              checked={value === true}
              testId={`skill-input-${name}`}
              onChange={set}
            />
          )
        return (
          <div className="field" key={name}>
            <label htmlFor={id}>{name}</label>
            {field.description ? <p className="muted small">{field.description}</p> : null}
            {field.type === 'string' && !field.enum ? (
              <textarea
                id={id}
                className="composer-input"
                rows={3}
                maxLength={field.maxLength}
                value={typeof value === 'string' ? value : ''}
                data-testid={`skill-input-${name}`}
                onChange={(event) => {
                  set(event.target.value)
                }}
              />
            ) : (
              <input
                id={id}
                className="input"
                type={field.type === 'string' ? 'text' : 'number'}
                value={typeof value === 'string' ? value : ''}
                data-testid={`skill-input-${name}`}
                onChange={(event) => {
                  set(event.target.value)
                }}
              />
            )}
          </div>
        )
      })}
      <div className="dialog-footer">
        {running ? (
          <button
            type="button"
            className="button button-danger"
            data-testid="skill-cancel"
            onClick={() => {
              void request('skills.cancel', { executionId: running })
            }}
          >
            {t('skills.cancel')}
          </button>
        ) : null}
        <button
          type="submit"
          className="button button-primary"
          data-testid="skill-run"
          disabled={running !== null}
        >
          {running ? t('skills.running') : t('skills.run')}
        </button>
      </div>
      {failure ? (
        <LoadFailure title={t('skills.runFailed')} error={failure} testId="skill-run-error" />
      ) : null}
      {result ? (
        <div
          className="skill-result"
          data-testid="skill-result"
          data-status={result.status}
          role="status"
        >
          <p className="mission-badges">
            <Badge tone={EXECUTION_TONE[result.status]} testId="skill-result-status">
              {t(`skillStatus.${result.status}` as MessageKey)}
            </Badge>
            <span className="muted small">
              {t('skills.took', {
                ms: Date.parse(result.completedAt) - Date.parse(result.startedAt)
              })}
            </span>
          </p>
          {result.status === 'SUCCESS' ? (
            <pre className="code-block" data-testid="skill-output">
              {JSON.stringify(result.output, null, 2)}
            </pre>
          ) : null}
          {result.error ? (
            <p className="small mission-step-error" data-testid="skill-result-error">
              <code>{result.error.code}</code> {result.error.message}
            </p>
          ) : null}
          {result.verificationHints.length > 0 ? (
            <ul className="plain-list small">
              {result.verificationHints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}
