import { useCallback, useEffect, useState } from 'react'
import type {
  BackupInfo,
  DiagnosticsSnapshot,
  GatewayStatus,
  ProgressUpdate
} from '@jupiter/contracts'
import { request } from '../api'
import { StatusBadge } from '../components/StatusBadge'
import { formatBytes, formatDuration } from '../format'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { useEventLog } from '../useEventLog'
import { envelopeOf, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

/**
 * Diagnostics: every value is read from the running application — the host
 * through the gateway, Jupiter Core through `diagnostics.snapshot` — and the
 * event log is a live subscription. Nothing here is estimated or decorative.
 */

interface Props {
  readonly status: Loadable<GatewayStatus>
  readonly coreRunning: boolean
}

function Row({
  label,
  value,
  testId
}: {
  readonly label: string
  readonly value: string
  readonly testId?: string
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td data-testid={testId}>{value}</td>
    </tr>
  )
}

function useSnapshot(coreRunning: boolean) {
  const [snapshot, setSnapshot] = useState<Loadable<DiagnosticsSnapshot>>({ state: 'loading' })
  const refresh = useCallback(() => {
    request('diagnostics.snapshot', {}).then(
      (value) => {
        setSnapshot({ state: 'ready', value })
      },
      (error: unknown) => {
        setSnapshot({ state: 'error', error: envelopeOf(error) })
      }
    )
  }, [])
  useEffect(() => {
    if (coreRunning) refresh()
  }, [coreRunning, refresh])
  return { snapshot, refresh }
}

export function DiagnosticsView({ status, coreRunning }: Props) {
  const { t, locale } = useI18n()
  const { snapshot, refresh } = useSnapshot(coreRunning)
  // Changes on every Core restart, so the live event log resubscribes to the new process.
  const coreSession =
    coreRunning && status.state === 'ready'
      ? `${String(status.value.core.pid)}:${String(status.value.core.restarts)}`
      : null
  const formatTime = (iso: string | null) =>
    iso === null
      ? t('diagnostics.none')
      : new Intl.DateTimeFormat(intlLocale(locale), {
          dateStyle: 'medium',
          timeStyle: 'medium'
        }).format(new Date(iso))

  return (
    <section className="view" aria-labelledby="diagnostics-title">
      <div className="view-header">
        <h1 id="diagnostics-title">{t('diagnostics.title')}</h1>
        <button
          type="button"
          className="button"
          data-testid="diagnostics-refresh"
          onClick={refresh}
          disabled={!coreRunning}
        >
          {t('diagnostics.refresh')}
        </button>
      </div>
      <p className="muted">{t('diagnostics.intro')}</p>

      {status.state === 'error' ? (
        <LoadFailure title={t('load.infoFailed')} error={status.error} />
      ) : null}
      {status.state === 'loading' ? <p>{t('load.loading')}</p> : null}
      {status.state === 'ready' ? (
        <BuildAndRuntime status={status.value} snapshot={snapshot} formatTime={formatTime} />
      ) : null}

      {status.state === 'ready' ? (
        <ServicesTable status={status.value} formatTime={formatTime} />
      ) : null}

      {!coreRunning ? (
        <p className="notice notice-warning" data-testid="core-unavailable">
          {t('diagnostics.coreUnavailable')}
        </p>
      ) : null}
      {coreRunning && snapshot.state === 'error' ? (
        <LoadFailure title={t('diagnostics.loadSnapshotFailed')} error={snapshot.error} />
      ) : null}
      {coreRunning && snapshot.state === 'ready' ? (
        <>
          <DatabasePanel snapshot={snapshot.value} onChanged={refresh} formatTime={formatTime} />
          <ErrorsPanel snapshot={snapshot.value} formatTime={formatTime} />
        </>
      ) : null}

      <EventsPanel coreSession={coreSession} formatTime={formatTime} />
      {status.state === 'ready' ? (
        <LogsPanel status={status.value} coreRunning={coreRunning} />
      ) : null}
      {coreRunning && snapshot.state === 'ready' ? (
        <DispatcherPanel snapshot={snapshot.value} />
      ) : null}
    </section>
  )
}

function BuildAndRuntime({
  status,
  snapshot,
  formatTime
}: {
  readonly status: GatewayStatus
  readonly snapshot: Loadable<DiagnosticsSnapshot>
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const { app, core } = status
  return (
    <>
      <section className="card" aria-labelledby="diag-build">
        <h2 id="diag-build">{t('diagnostics.build')}</h2>
        {app.build ? (
          <table className="facts-table">
            <tbody>
              <Row label={t('diagnostics.product')} value={app.build.productName} />
              <Row
                label={t('diagnostics.version')}
                value={app.build.version}
                testId="diag-version"
              />
              <Row
                label={t('diagnostics.channel')}
                value={app.build.channel}
                testId="diag-channel"
              />
              <Row
                label={t('diagnostics.buildId')}
                value={app.build.buildId}
                testId="diag-build-id"
              />
              <Row
                label={t('diagnostics.commit')}
                testId="diag-commit"
                value={
                  app.build.dirty
                    ? t('diagnostics.commitDirty', { commit: app.build.commit })
                    : app.build.commit
                }
              />
              <Row
                label={t('diagnostics.builtAt')}
                value={`${formatTime(app.build.builtAt)} (${app.build.builtAt})`}
              />
            </tbody>
          </table>
        ) : (
          <p className="notice notice-warning">{t('diagnostics.metadataMissing')}</p>
        )}
      </section>

      <div className="card-grid">
        <section className="card" aria-labelledby="diag-host">
          <h2 id="diag-host">{t('diagnostics.host')}</h2>
          <table className="facts-table">
            <tbody>
              <Row
                label={t('diagnostics.environment')}
                value={t(`env.${app.environment}`)}
                testId="diag-environment"
              />
              <Row
                label={t('diagnostics.platform')}
                value={`${app.platform} ${app.arch}`}
                testId="diag-platform"
              />
              <Row label={t('diagnostics.osRelease')} value={app.osRelease} />
              <Row
                label={t('diagnostics.packaged')}
                value={app.packaged ? t('diagnostics.yes') : t('diagnostics.no')}
              />
              <Row
                label={t('diagnostics.osSandbox')}
                value={
                  app.osSandbox ? t('diagnostics.enabled') : t('diagnostics.disabledNoSandbox')
                }
                testId="diag-os-sandbox"
              />
              <Row
                label={t('diagnostics.electron')}
                value={app.versions.electron}
                testId="diag-electron"
              />
              <Row label={t('diagnostics.chromium')} value={app.versions.chrome} />
              <Row label={t('diagnostics.node')} value={app.versions.node} />
              <Row label={t('diagnostics.v8')} value={app.versions.v8} />
            </tbody>
          </table>
        </section>

        <section className="card" aria-labelledby="diag-core">
          <h2 id="diag-core">{t('diagnostics.core')}</h2>
          <table className="facts-table">
            <tbody>
              <Row
                label={t('diagnostics.coreState')}
                value={t(`coreState.${core.state}`)}
                testId="diag-core-state"
              />
              <Row
                label={t('diagnostics.corePid')}
                value={core.pid === null ? t('diagnostics.none') : String(core.pid)}
                testId="diag-core-pid"
              />
              <Row
                label={t('diagnostics.coreRestarts')}
                value={String(core.restarts)}
                testId="diag-core-restarts"
              />
              <Row
                label={t('diagnostics.coreLastExit')}
                value={
                  core.lastExit
                    ? `${formatTime(core.lastExit.at)} — ${core.lastExit.reason}`
                    : t('diagnostics.none')
                }
                testId="diag-core-last-exit"
              />
              {snapshot.state === 'ready' ? (
                <>
                  <Row
                    label={t('diagnostics.coreUptime')}
                    value={formatDuration(snapshot.value.core.uptimeMs)}
                  />
                  <Row
                    label={t('diagnostics.node')}
                    value={snapshot.value.core.versions.node}
                    testId="diag-core-node"
                  />
                </>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>
    </>
  )
}

function ServicesTable({
  status,
  formatTime
}: {
  readonly status: GatewayStatus
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  return (
    <section className="card" aria-labelledby="diag-services">
      <h2 id="diag-services">{t('diagnostics.services')}</h2>
      <p className="muted small">
        {t('diagnostics.session')}: <code>{status.runtime.sessionId}</code>
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('diagnostics.service')}</th>
              <th scope="col">{t('diagnostics.status')}</th>
              <th scope="col">{t('diagnostics.lastCheck')}</th>
              <th scope="col">{t('diagnostics.latency')}</th>
              <th scope="col">{t('diagnostics.error')}</th>
            </tr>
          </thead>
          <tbody>
            {status.runtime.services.map((service) => (
              <tr
                key={service.serviceId}
                data-testid={`diag-service-${service.serviceId}`}
                data-status={service.status}
              >
                <td>{t(`service.${service.serviceId}` as MessageKey)}</td>
                <td>
                  <StatusBadge status={service.status} />
                </td>
                <td>{formatTime(service.lastCheck)}</td>
                <td>
                  {service.latency === null
                    ? t('diagnostics.none')
                    : `${service.latency.toFixed(1)} ms`}
                </td>
                <td>
                  {service.sanitizedError ? (
                    <code>{service.sanitizedError.code}</code>
                  ) : (
                    t('diagnostics.none')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DatabasePanel({
  snapshot,
  onChanged,
  formatTime
}: {
  readonly snapshot: DiagnosticsSnapshot
  readonly onChanged: () => void
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const [progress, setProgress] = useState<ProgressUpdate | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    { ok: true; backup: BackupInfo } | { ok: false; message: string } | null
  >(null)
  const database = snapshot.database

  const backup = () => {
    setBusy(true)
    setResult(null)
    setProgress(null)
    request('database.backup', {}, { onProgress: setProgress }).then(
      (info) => {
        setResult({ ok: true, backup: info })
        setBusy(false)
        onChanged()
      },
      (error: unknown) => {
        setResult({ ok: false, message: envelopeOf(error).message })
        setBusy(false)
      }
    )
  }

  return (
    <section className="card" aria-labelledby="diag-database" data-testid="diag-database">
      <h2 id="diag-database">{t('diagnostics.database')}</h2>
      {!database ? (
        <div className="notice notice-error" role="alert">
          <p className="notice-title">{t('diagnostics.dbUnavailable')}</p>
          {snapshot.databaseError ? (
            <>
              <p className="notice-message">{snapshot.databaseError.message}</p>
              <p className="muted small">
                {t('recovery.code')}:{' '}
                <code data-testid="diag-database-error">{snapshot.databaseError.code}</code>
              </p>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <table className="facts-table">
            <tbody>
              <Row label={t('diagnostics.dbPath')} value={database.path} testId="diag-db-path" />
              <Row label={t('diagnostics.dbSize')} value={formatBytes(t, database.sizeBytes)} />
              <Row label={t('diagnostics.dbWal')} value={formatBytes(t, database.walBytes)} />
              <Row
                label={t('diagnostics.dbSchema')}
                value={t('diagnostics.dbSchemaValue', {
                  current: database.schemaVersion,
                  latest: database.latestKnownVersion
                })}
                testId="diag-db-schema"
              />
              <Row
                label={t('diagnostics.dbJournal')}
                value={database.journalMode}
                testId="diag-db-journal"
              />
              <Row
                label={t('diagnostics.dbForeignKeys')}
                value={database.foreignKeys ? t('diagnostics.yes') : t('diagnostics.no')}
                testId="diag-db-fk"
              />
              <Row
                label={t('diagnostics.dbIntegrity')}
                value={database.integrity}
                testId="diag-db-integrity"
              />
              <Row label={t('diagnostics.dbSqlite')} value={database.sqliteVersion} />
              <Row
                label={t('diagnostics.dbCounts')}
                value={t('diagnostics.dbCountsValue', {
                  events: database.counts.events,
                  audit: database.counts.auditEntries,
                  settings: database.counts.settings
                })}
                testId="diag-db-counts"
              />
            </tbody>
          </table>

          <h3>{t('diagnostics.migrations')}</h3>
          <ul className="plain-list" data-testid="diag-migrations">
            {database.migrations.map((migration) => (
              <li key={migration.version}>
                <code>{migration.name}</code>{' '}
                <span className="muted small">{formatTime(migration.appliedAt)}</span>
              </li>
            ))}
          </ul>

          <h3>{t('diagnostics.backups')}</h3>
          {database.backups.length === 0 ? (
            <p className="muted small">{t('diagnostics.noBackups')}</p>
          ) : null}
          <ul className="plain-list" data-testid="diag-backups">
            {database.backups.slice(0, 5).map((item) => (
              <li key={item.file}>
                <code>{item.file}</code>{' '}
                <span className="muted small">
                  {formatBytes(t, item.bytes)} · {formatTime(item.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="button"
              data-testid="backup-now"
              disabled={busy}
              onClick={backup}
            >
              {busy ? t('diagnostics.backingUp') : t('diagnostics.backupNow')}
            </button>
          </div>
          {busy ? <BackupProgress progress={progress} /> : null}
          {result?.ok ? (
            <p className="notice notice-info" role="status" data-testid="backup-result">
              {t('diagnostics.backupDone', {
                file: result.backup.file,
                size: formatBytes(t, result.backup.bytes)
              })}
            </p>
          ) : null}
          {result && !result.ok ? (
            <p className="notice notice-error" role="alert" data-testid="backup-result">
              {t('diagnostics.backupFailed', { message: result.message })}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

/** Exact progress only when Core reports a measurable total; otherwise an indeterminate indicator. */
function BackupProgress({ progress }: { readonly progress: ProgressUpdate | null }) {
  const { t } = useI18n()
  // Only a measured step count is shown as a bar with numbers; anything else is indeterminate.
  const completed = progress?.completed ?? null
  const total = progress?.total ?? null
  return (
    <div className="progress" role="status" data-testid="backup-progress">
      {completed !== null && total !== null ? (
        <>
          <progress value={completed} max={total} />
          <span className="muted small">
            {t('diagnostics.backupProgress', { done: completed, total })}
          </span>
        </>
      ) : (
        <>
          <progress />
          <span className="muted small">{t('diagnostics.backupStarting')}</span>
        </>
      )}
    </div>
  )
}

function ErrorsPanel({
  snapshot,
  formatTime
}: {
  readonly snapshot: DiagnosticsSnapshot
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  return (
    <section className="card" aria-labelledby="diag-errors">
      <h2 id="diag-errors">{t('diagnostics.recentErrors')}</h2>
      {snapshot.recentErrors.length === 0 ? (
        <p className="muted small">{t('diagnostics.noErrors')}</p>
      ) : null}
      <ul className="error-list" data-testid="diag-errors">
        {snapshot.recentErrors.map((item) => (
          <li key={item.globalSequence} data-testid="error-row" data-code={item.error.code}>
            <p className="notice-title">
              <code>{item.error.code}</code>{' '}
              <span className="muted small">{formatTime(item.occurredAt)}</span>
            </p>
            <p className="notice-message">{item.error.message}</p>
            {item.error.userAction ? <p className="small">{item.error.userAction}</p> : null}
            <p className="muted small">
              {t('diagnostics.errorSource')}: {item.source} · {t('recovery.reference')}:{' '}
              <code>{item.error.errorId}</code>
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function EventsPanel({
  coreSession,
  formatTime
}: {
  readonly coreSession: string | null
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const { events, state } = useEventLog(50, coreSession)
  const stateLabel: Record<typeof state, MessageKey> = {
    connecting: 'diagnostics.eventsConnecting',
    live: 'diagnostics.eventsLive',
    'waiting-for-core': 'diagnostics.eventsWaiting',
    error: 'diagnostics.eventsError'
  }
  return (
    <section className="card" aria-labelledby="diag-events">
      <div className="view-header">
        <h2 id="diag-events">{t('diagnostics.recentEvents')}</h2>
        <span
          className={`badge ${state === 'live' ? 'badge-success' : state === 'error' ? 'badge-error' : 'badge-muted'}`}
          data-testid="events-state"
          data-state={state}
        >
          {t(stateLabel[state])}
        </span>
      </div>
      {events.length === 0 ? <p className="muted small">{t('diagnostics.noEvents')}</p> : null}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('diagnostics.eventSequence')}</th>
              <th scope="col">{t('diagnostics.eventType')}</th>
              <th scope="col">{t('diagnostics.eventStream')}</th>
              <th scope="col">{t('diagnostics.eventTime')}</th>
            </tr>
          </thead>
          <tbody data-testid="event-log">
            {[...events].reverse().map((event) => (
              <tr
                key={event.eventId}
                data-testid="event-row"
                data-sequence={event.globalSequence ?? ''}
                data-type={event.type}
              >
                <td>{event.globalSequence}</td>
                <td>
                  <code>{event.type}</code>
                </td>
                <td>
                  {event.stream.kind}/{event.stream.id} #{event.streamSequence}
                </td>
                <td>{formatTime(event.occurredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function LogsPanel({
  status,
  coreRunning
}: {
  readonly status: GatewayStatus
  readonly coreRunning: boolean
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const open = () => {
    setBusy(true)
    setMessage(null)
    request('host.logs.reveal', {}).then(
      (result) => {
        setMessage({ ok: true, text: t('diagnostics.openLogsDone', { path: result.path }) })
        setBusy(false)
      },
      (error: unknown) => {
        setMessage({
          ok: false,
          text: t('diagnostics.openLogsFailed', { message: envelopeOf(error).message })
        })
        setBusy(false)
      }
    )
  }
  return (
    <section className="card" aria-labelledby="diag-storage">
      <h2 id="diag-storage">{t('diagnostics.storage')}</h2>
      <table className="facts-table">
        <tbody>
          <Row
            label={t('diagnostics.userData')}
            value={status.app.paths.userData}
            testId="diag-user-data"
          />
          <Row label={t('diagnostics.logs')} value={status.app.paths.logs} testId="diag-logs" />
          <Row label={t('diagnostics.logLevel')} value={status.app.logging.level} />
          <Row
            label={t('diagnostics.logRotation')}
            value={t('diagnostics.logRotationValue', {
              files: status.app.logging.maxFiles,
              size: status.app.logging.maxFileBytes / (1024 * 1024)
            })}
          />
        </tbody>
      </table>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-testid="open-logs"
          disabled={busy || !coreRunning}
          onClick={open}
        >
          {busy ? t('diagnostics.openingLogs') : t('diagnostics.openLogs')}
        </button>
      </div>
      {message ? (
        <p
          className={`notice ${message.ok ? 'notice-info' : 'notice-error'}`}
          role={message.ok ? 'status' : 'alert'}
          data-testid="open-logs-result"
        >
          {message.text}
        </p>
      ) : null}
    </section>
  )
}

function DispatcherPanel({ snapshot }: { readonly snapshot: DiagnosticsSnapshot }) {
  const { t } = useI18n()
  return (
    <section className="card" aria-labelledby="diag-dispatcher">
      <h2 id="diag-dispatcher">{t('diagnostics.dispatcher')}</h2>
      <table className="facts-table">
        <tbody>
          <Row label={t('diagnostics.inFlight')} value={String(snapshot.dispatcher.inFlight)} />
          <Row
            label={t('diagnostics.subscriptions')}
            value={String(snapshot.events.activeSubscriptions)}
            testId="diag-subscriptions"
          />
        </tbody>
      </table>
      <h3>{t('diagnostics.capabilities')}</h3>
      <ul className="plain-list" data-testid="diag-capabilities">
        {snapshot.dispatcher.capabilities.map((capability) => (
          <li key={capability.id}>
            <code>{capability.id}</code>{' '}
            <span className="muted small">
              {capability.kind} · {capability.provider} · {capability.risk} ·{' '}
              {capability.allowedActors.join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
