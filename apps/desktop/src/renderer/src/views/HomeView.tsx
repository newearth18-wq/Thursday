import type { ErrorEnvelope, GatewayStatus, RuntimeStatus, ServiceHealth } from '@jupiter/contracts'
import { JupiterMark } from '@jupiter/ui'
import { RecoveryNotice } from '../components/RecoveryNotice'
import { StatusBadge } from '../components/StatusBadge'
import { useI18n, type MessageKey } from '../i18n'
import type { View } from '../components/Sidebar'
import type { Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

interface Props {
  readonly status: Loadable<GatewayStatus>
  readonly onRetry: (serviceId: string) => Promise<ErrorEnvelope | null>
  readonly onNavigate: (view: View) => void
}

const RUNNING = new Set<ServiceHealth['status']>([
  'NOT_STARTED',
  'STARTING',
  'HEALTHY',
  'DEGRADED',
  'FAILED',
  'STOPPED'
])

export function HomeView({ status, onRetry, onNavigate }: Props) {
  const { t } = useI18n()
  const info: Loadable<GatewayStatus['app']> =
    status.state === 'ready' ? { state: 'ready', value: status.value.app } : status
  const runtime: Loadable<RuntimeStatus> =
    status.state === 'ready' ? { state: 'ready', value: status.value.runtime } : status
  const build = info.state === 'ready' ? info.value.build : null

  return (
    <section className="view" aria-labelledby="home-title">
      <header className="hero">
        <JupiterMark size={112} label={t('app.name')} />
        <div>
          <h1 id="home-title" data-testid="app-name">
            {build?.productName ?? t('app.name')}
          </h1>
          <p className="tagline">{t('app.tagline')}</p>
          {info.state === 'error' ? (
            <LoadFailure title={t('load.infoFailed')} error={info.error} />
          ) : null}
          <dl className="facts">
            <div>
              <dt>{t('home.version')}</dt>
              <dd data-testid="app-version">
                {info.state === 'loading'
                  ? t('load.loading')
                  : (build?.version ?? t('home.versionUnavailable'))}
              </dd>
            </div>
            <div>
              <dt>{t('home.channel')}</dt>
              <dd data-testid="app-channel">{build?.channel ?? t('diagnostics.none')}</dd>
            </div>
            <div>
              <dt>{t('home.environment')}</dt>
              <dd data-testid="app-environment">
                {info.state === 'ready'
                  ? t(`env.${info.value.environment}`)
                  : t('diagnostics.none')}
              </dd>
            </div>
          </dl>
          <div className="actions">
            <button
              type="button"
              className="button"
              data-testid="open-diagnostics"
              onClick={() => {
                onNavigate('diagnostics')
              }}
            >
              {t('home.openDiagnostics')}
            </button>
            <button
              type="button"
              className="button"
              data-testid="open-settings"
              onClick={() => {
                onNavigate('settings')
              }}
            >
              {t('home.openSettings')}
            </button>
          </div>
        </div>
      </header>

      <section className="card" aria-labelledby="runtime-title">
        <h2 id="runtime-title">{t('home.runtimeTitle')}</h2>
        {runtime.state === 'loading' ? <p>{t('load.loading')}</p> : null}
        {runtime.state === 'error' ? (
          <LoadFailure title={t('load.statusFailed')} error={runtime.error} />
        ) : null}
        {runtime.state === 'ready' ? (
          <RuntimeDetails status={runtime.value} onRetry={onRetry} />
        ) : null}
      </section>
    </section>
  )
}

function RuntimeDetails({
  status,
  onRetry
}: {
  readonly status: RuntimeStatus
  readonly onRetry: (serviceId: string) => Promise<ErrorEnvelope | null>
}) {
  const { t } = useI18n()
  const running = status.services.filter((service) => RUNNING.has(service.status))
  const planned = status.services.filter((service) => !RUNNING.has(service.status))
  const problems = running.filter(
    (service) => service.status === 'FAILED' || service.status === 'DEGRADED'
  )

  return (
    <>
      <p className="overall" data-testid="overall-status" data-status={status.overall}>
        <StatusBadge status={status.overall} /> <span>{t(`overall.${status.overall}`)}</span>
      </p>
      {problems.map((service) => (
        <RecoveryNotice key={service.serviceId} service={service} onRetry={onRetry} />
      ))}

      <h3>{t('home.servicesTitle')}</h3>
      <ul className="service-list">
        {running.map((service) => (
          <li
            key={service.serviceId}
            data-testid={`service-${service.serviceId}`}
            data-status={service.status}
          >
            <span className="service-name">{t(`service.${service.serviceId}` as MessageKey)}</span>
            {service.latency === null ? null : (
              <span className="muted small">
                {t('home.latency', { ms: service.latency.toFixed(1) })}
              </span>
            )}
            <StatusBadge status={service.status} />
          </li>
        ))}
      </ul>

      <h3>{t('home.plannedTitle')}</h3>
      <p className="muted small">{t('home.plannedNote')}</p>
      <ul className="service-list">
        {planned.map((service) => (
          <li
            key={service.serviceId}
            data-testid={`service-${service.serviceId}`}
            data-status={service.status}
          >
            <span className="service-name">{t(`service.${service.serviceId}` as MessageKey)}</span>
            {service.plannedSet === null ? null : (
              <span className="muted small">
                {t('nav.plannedFor', { set: service.plannedSet })}
              </span>
            )}
            <StatusBadge status={service.status} />
          </li>
        ))}
      </ul>
    </>
  )
}
