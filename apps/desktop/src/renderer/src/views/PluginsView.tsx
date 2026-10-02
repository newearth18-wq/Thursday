import { useCallback, useState } from 'react'
import type {
  DomainEvent,
  ErrorEnvelope,
  EventFilter,
  PluginCandidate,
  PluginInfo,
  PluginState,
  PluginsStatus
} from '@jupiter/contracts'
import { request } from '../api'
import { ConfirmDialog } from '../components/InfoDialogs'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { keyOf, useBump, useQuery } from '../useAi'
import { withPermission } from '../useFiles'
import { useLiveEvents } from '../useLiveEvents'
import { coreSessionOf, envelopeOf, useRuntimeContext } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import { ViewHeader } from './ViewHeader'

/**
 * Plugins (SET 15): the plugins that ship with Jupiter and can be installed,
 * and the installed ones with their state, publisher (unverified), source,
 * permissions, handles, Skills and their health, integrity and storage —
 * all as Jupiter Core reports them. Installing and updating ask for
 * `plugin.install` every time; every refusal is shown with its reasons.
 */

const PLUGIN_EVENTS: EventFilter = {
  types: [
    'plugin.changed',
    'skill.registered',
    'skill.health_checked',
    'skill.execution_started',
    'skill.execution_finished'
  ],
  streams: null,
  missionId: null
}

const STATE_TONE: Record<PluginState, string> = {
  INSTALLED: 'badge-muted',
  DISABLED: 'badge-muted',
  ENABLED: 'badge-success',
  RUNNING: 'badge-info',
  DEGRADED: 'badge-warning',
  FAILED: 'badge-error',
  INCOMPATIBLE: 'badge-error'
}

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: 'badge-success',
  UNHEALTHY: 'badge-error',
  UNKNOWN: 'badge-muted'
}

type Busy = { readonly pluginId: string | null; readonly action: string } | null

export function PluginsView() {
  const { t } = useI18n()
  const { status: runtime } = useRuntimeContext()
  const coreSession = coreSessionOf(runtime)
  const [version, bump] = useBump(50)
  const onEvent = useCallback(
    (_event: DomainEvent) => {
      bump()
    },
    [bump]
  )
  const { opened } = useLiveEvents(PLUGIN_EVENTS, onEvent, coreSession)
  const load = useCallback(async () => request('plugins.list', {}), [])
  const [status] = useQuery(keyOf(coreSession, 'plugins', opened, version), load)
  const [busy, setBusy] = useState<Busy>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<ErrorEnvelope | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const act = useCallback(
    async (
      pluginId: string | null,
      action: string,
      run: () => Promise<unknown>,
      message: string
    ) => {
      setBusy({ pluginId, action })
      setError(null)
      setDone(null)
      try {
        await withPermission(run, setWaiting)
        setDone(message)
      } catch (failure) {
        const envelope = envelopeOf(failure)
        // Closing the folder dialog is not an error.
        if (envelope.code !== 'PLUGIN_NOT_CHOSEN') setError(envelope)
      } finally {
        setBusy(null)
        bump()
      }
    },
    [bump]
  )

  return (
    <section className="view view-plugins" aria-labelledby="plugins-title">
      <ViewHeader id="plugins-title" title={t('nav.plugins')} />
      <p className="muted">{t('plugins.lede')}</p>
      {status.state === 'error' ? (
        <LoadFailure title={t('plugins.loadFailed')} error={status.error} />
      ) : status.state !== 'ready' ? (
        <p className="muted">{t('load.loading')}</p>
      ) : (
        <>
          <RuntimeCard
            status={status.value}
            busy={busy !== null}
            onInstall={() => {
              void act(
                null,
                'install-local',
                () => request('plugins.install', { source: 'local' }),
                t('plugins.done.installed')
              )
            }}
          />
          {waiting ? (
            <p className="notice notice-info" role="status" data-testid="plugins-waiting">
              {t('plugins.waitingPermission')}
            </p>
          ) : null}
          {done ? (
            <p className="notice notice-info" role="status" data-testid="plugins-done">
              {done}
            </p>
          ) : null}
          {error ? (
            <div
              className="notice notice-error"
              role="alert"
              data-testid="plugins-error"
              data-code={error.code}
            >
              <p>{error.message}</p>
              {error.userAction ? <p className="small">{error.userAction}</p> : null}
            </div>
          ) : null}
          {status.value.available.length > 0 ? (
            <section
              className="card"
              aria-labelledby="plugins-available-title"
              data-testid="plugins-available"
            >
              <h2 id="plugins-available-title">{t('plugins.available')}</h2>
              <p className="muted small">{t('plugins.availableHint')}</p>
              <ul className="plain-list">
                {status.value.available.map((candidate) => (
                  <Candidate
                    key={candidate.pluginId}
                    candidate={candidate}
                    busy={busy !== null}
                    onInstall={() => {
                      void act(
                        candidate.pluginId,
                        'install',
                        () =>
                          request('plugins.install', {
                            source: 'bundled',
                            pluginId: candidate.pluginId
                          }),
                        t('plugins.done.installed')
                      )
                    }}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="plugins-installed-title" data-testid="plugins-installed">
            <h2 id="plugins-installed-title">{t('plugins.installed')}</h2>
            {status.value.plugins.length === 0 ? (
              <p className="muted" data-testid="plugins-none">
                {t('plugins.none')}
              </p>
            ) : (
              status.value.plugins.map((plugin) => (
                <PluginCard key={plugin.pluginId} plugin={plugin} busy={busy} act={act} />
              ))
            )}
          </section>
        </>
      )}
    </section>
  )
}

function RuntimeCard({
  status,
  busy,
  onInstall
}: {
  readonly status: PluginsStatus
  readonly busy: boolean
  readonly onInstall: () => void
}) {
  const { t } = useI18n()
  return (
    <section className="card" aria-labelledby="plugins-runtime-title" data-testid="plugins-runtime">
      <h2 id="plugins-runtime-title">{t('plugins.runtime')}</h2>
      <p>
        <span
          className={`badge ${status.runtime.available ? 'badge-success' : 'badge-warning'}`}
          data-testid="plugins-runtime-state"
          data-available={status.runtime.available}
          data-availability={status.runtime.available ? undefined : 'UNAVAILABLE'}
        >
          {status.runtime.available ? t('plugins.runtimeReady') : t('availability.UNAVAILABLE')}
        </span>{' '}
        <span className="muted small">
          {status.runtime.available
            ? t('plugins.runtimeName', {
                name: status.runtime.name,
                version: status.jupiterVersion
              })
            : (status.runtime.reason ?? '')}
        </span>
      </p>
      <ul className="plain-list small" data-testid="plugins-isolation">
        <li>{t('plugins.isolation.process')}</li>
        <li>{t('plugins.isolation.nothing')}</li>
        <li>{t('plugins.isolation.handles')}</li>
        <li>{t('plugins.isolation.integrity')}</li>
      </ul>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-testid="plugins-install-folder"
          disabled={busy || !status.runtime.available}
          onClick={onInstall}
        >
          {t('plugins.installFolder')}
        </button>
      </div>
    </section>
  )
}

function Candidate({
  candidate,
  busy,
  onInstall
}: {
  readonly candidate: PluginCandidate
  readonly busy: boolean
  readonly onInstall: () => void
}) {
  const { t } = useI18n()
  return (
    <li data-testid={`plugin-candidate-${candidate.pluginId}`} data-valid={candidate.valid}>
      <strong>{candidate.name ?? candidate.pluginId}</strong>{' '}
      <span className="muted small">
        {candidate.version ? t('plugins.version', { version: candidate.version }) : ''}{' '}
        {t('plugins.source.bundled')}
      </span>{' '}
      {candidate.valid ? (
        <button
          type="button"
          className="button button-primary"
          data-testid={`plugin-install-${candidate.pluginId}`}
          disabled={busy}
          onClick={onInstall}
        >
          {t('plugins.install')}
        </button>
      ) : (
        <>
          <span className="badge badge-error">{t('plugins.invalid')}</span>
          <ul className="small">
            {candidate.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </>
      )}
    </li>
  )
}

function PluginCard({
  plugin,
  busy,
  act
}: {
  readonly plugin: PluginInfo
  readonly busy: Busy
  readonly act: (
    pluginId: string | null,
    action: string,
    run: () => Promise<unknown>,
    message: string
  ) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso)
    )
  const id = plugin.pluginId
  const running = busy?.pluginId === id ? busy.action : null
  const loaded =
    plugin.state === 'ENABLED' || plugin.state === 'RUNNING' || plugin.state === 'DEGRADED'
  const ref = { pluginId: id }
  return (
    <article
      className="card"
      aria-labelledby={`plugin-${id}-title`}
      data-testid={`plugin-${id}`}
      data-state={plugin.state}
    >
      <header className="card-header">
        <h3 id={`plugin-${id}-title`}>
          {plugin.name}{' '}
          <span className="muted small">{t('plugins.version', { version: plugin.version })}</span>
        </h3>
        <span
          className={`badge ${STATE_TONE[plugin.state]}`}
          data-testid={`plugin-${id}-state`}
          role="status"
        >
          {t(`pluginState.${plugin.state}` as MessageKey)}
        </span>
      </header>
      <p>{plugin.description}</p>
      {plugin.stateReason ? (
        <p className="small" data-testid={`plugin-${id}-reason`}>
          {plugin.stateReason}
        </p>
      ) : null}
      <dl className="facts facts-compact">
        <div>
          <dt>{t('plugins.publisher')}</dt>
          <dd>
            {plugin.publisher.name}{' '}
            <span className="badge badge-warning" data-testid={`plugin-${id}-publisher`}>
              {t('plugins.unverified')}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('plugins.sourceLabel')}</dt>
          <dd>{t(`plugins.source.${plugin.source}` as MessageKey)}</dd>
        </div>
        <div>
          <dt>{t('plugins.integrity')}</dt>
          <dd data-testid={`plugin-${id}-integrity`}>
            {plugin.integrity.verifiedAt
              ? t('plugins.integrityChecked', {
                  files: plugin.integrity.files,
                  time: formatTime(plugin.integrity.verifiedAt)
                })
              : t('plugins.integrityFiles', { files: plugin.integrity.files })}
          </dd>
        </div>
        <div>
          <dt>{t('plugins.minimum')}</dt>
          <dd>{plugin.minimumJupiterVersion}</dd>
        </div>
        {plugin.storage ? (
          <div>
            <dt>{t('plugins.storage')}</dt>
            <dd data-testid={`plugin-${id}-storage`}>
              {t('plugins.storageUse', {
                files: plugin.storage.files,
                used: Math.ceil(plugin.storage.usedBytes / 1024),
                quota: Math.round(plugin.storage.quotaBytes / 1024 / 1024)
              })}
            </dd>
          </div>
        ) : null}
      </dl>
      <h4>{t('plugins.permissions')}</h4>
      {plugin.permissions.length === 0 ? (
        <p className="muted small">{t('plugins.noPermissions')}</p>
      ) : (
        <ul className="plain-list" data-testid={`plugin-${id}-permissions`}>
          {plugin.permissions.map((permission) => (
            <li key={permission.name}>
              <code>{permission.name}</code>{' '}
              <span className="badge badge-muted">
                {t(`risk.${permission.risk}` as MessageKey)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4>{t('plugins.skills')}</h4>
      <ul className="plain-list" data-testid={`plugin-${id}-skills`}>
        {plugin.skills.map((skill) => (
          <li key={skill.skillId} data-skill={skill.skillId} data-registered={skill.registered}>
            <strong>{skill.name}</strong> <code className="small">{skill.skillId}</code>{' '}
            {skill.registered ? (
              <span className={`badge ${HEALTH_TONE[skill.health] ?? 'badge-muted'}`}>
                {t(`skillHealth.${skill.health}` as MessageKey)}
              </span>
            ) : (
              <span className="badge badge-muted">{t('plugins.notRegistered')}</span>
            )}
            {skill.registered && skill.healthDetail ? (
              <span className="muted small"> {skill.healthDetail}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {plugin.lastError && !loaded ? (
        <p className="small" role="alert" data-code={plugin.lastError.code}>
          {plugin.lastError.message}
        </p>
      ) : null}
      <div className="actions">
        {loaded ? (
          <>
            <button
              type="button"
              className="button"
              data-testid={`plugin-${id}-disable`}
              disabled={busy !== null}
              onClick={() => {
                void act(
                  id,
                  'disable',
                  () => request('plugins.disable', ref),
                  t('plugins.done.disabled')
                )
              }}
            >
              {t('plugins.disable')}
            </button>
            <button
              type="button"
              className="button"
              data-testid={`plugin-${id}-health`}
              disabled={busy !== null}
              onClick={() => {
                void act(
                  id,
                  'health',
                  () => request('plugins.health', ref),
                  t('plugins.done.checked')
                )
              }}
            >
              {running === 'health' ? t('plugins.checking') : t('plugins.health')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button-primary"
            data-testid={`plugin-${id}-enable`}
            disabled={busy !== null || plugin.state === 'INCOMPATIBLE'}
            onClick={() => {
              void act(
                id,
                'enable',
                () => request('plugins.enable', ref),
                t('plugins.done.enabled')
              )
            }}
          >
            {running === 'enable' ? t('plugins.loading') : t('plugins.enable')}
          </button>
        )}
        <button
          type="button"
          className="button"
          data-testid={`plugin-${id}-update`}
          disabled={busy !== null}
          onClick={() => {
            void act(id, 'update', () => request('plugins.update', ref), t('plugins.done.updated'))
          }}
        >
          {t('plugins.update')}
        </button>
        <button
          type="button"
          className="button button-danger"
          data-testid={`plugin-${id}-uninstall`}
          disabled={busy !== null}
          onClick={() => {
            setConfirming(true)
          }}
        >
          {t('plugins.uninstall')}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t('plugins.uninstallTitle', { name: plugin.name })}
        description={t('plugins.uninstallDescription')}
        confirmLabel={t('plugins.uninstall')}
        testId={`plugin-${id}-uninstall-dialog`}
        onCancel={() => {
          setConfirming(false)
        }}
        onConfirm={() => {
          setConfirming(false)
          void act(
            id,
            'uninstall',
            () => request('plugins.uninstall', ref),
            t('plugins.done.uninstalled')
          )
        }}
      />
    </article>
  )
}
