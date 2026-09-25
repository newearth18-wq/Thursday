import type { ErrorEnvelope, GatewayStatus, RuntimeStatus, ServiceHealth } from '@jupiter/contracts'
import type { ViewId } from '../../../shared/views'
import { ActivityTimeline } from '../components/ActivityTimeline'
import { ChatComposer } from '../components/ChatComposer'
import { JupiterStage } from '../components/JupiterStage'
import { MissionCard } from '../components/MissionCard'
import { RecoveryNotice } from '../components/RecoveryNotice'
import { StatusBadge } from '../components/StatusBadge'
import { useI18n, type MessageKey } from '../i18n'
import { coreSessionOf, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

/**
 * Home — the Command Center (Visual Design Lock v1): Jupiter's stage driven
 * by Core state, the chat composer, the current Mission, what happened, and
 * the real health of every service.
 */
interface Props {
  readonly status: Loadable<GatewayStatus>
  readonly onRetry: (serviceId: string) => Promise<ErrorEnvelope | null>
  readonly onNavigate: (view: ViewId) => void
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
  const info = status.state === 'ready' ? status.value.app : null
  const build = info?.build ?? null

  return (
    <section className="view view-home" aria-labelledby="home-title">
      <header className="home-header">
        <div>
          <h1 id="home-title" data-testid="app-name" tabIndex={-1}>
            {build?.productName ?? t('app.name')}
          </h1>
          <p className="tagline">{t('home.commandCenter')}</p>
        </div>
        <dl className="facts">
          <div>
            <dt>{t('home.version')}</dt>
            <dd data-testid="app-version">
              {status.state === 'loading'
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
              {info ? t(`env.${info.environment}`) : t('diagnostics.none')}
            </dd>
          </div>
        </dl>
      </header>
      {status.state === 'error' ? (
        <LoadFailure title={t('load.infoFailed')} error={status.error} />
      ) : null}

      <div className="home-grid">
        <div className="home-main">
          <JupiterStage status={status} />
          <ChatComposer />
        </div>
        <div className="home-side">
          <MissionCard mission={null} />
          <ActivityTimeline coreSession={coreSessionOf(status)} />
        </div>
      </div>

      <section className="card" aria-labelledby="runtime-title">
        <div className="card-header">
          <h2 id="runtime-title">{t('home.runtimeTitle')}</h2>
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
        {status.state === 'loading' ? <p>{t('load.loading')}</p> : null}
        {status.state === 'error' ? (
          <LoadFailure title={t('load.statusFailed')} error={status.error} />
        ) : null}
        {status.state === 'ready' ? (
          <RuntimeDetails status={status.value.runtime} onRetry={onRetry} />
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

      <div className="service-columns">
        <div>
          <h3>{t('home.servicesTitle')}</h3>
          <ul className="service-list">
            {running.map((service) => (
              <li
                key={service.serviceId}
                data-testid={`service-${service.serviceId}`}
                data-status={service.status}
              >
                <span className="service-name">
                  {t(`service.${service.serviceId}` as MessageKey)}
                </span>
                {service.latency === null ? null : (
                  <span className="muted small">
                    {t('home.latency', { ms: service.latency.toFixed(1) })}
                  </span>
                )}
                <StatusBadge status={service.status} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{t('home.plannedTitle')}</h3>
          <p className="muted small">{t('home.plannedNote')}</p>
          <ul className="service-list">
            {planned.map((service) => (
              <li
                key={service.serviceId}
                data-testid={`service-${service.serviceId}`}
                data-status={service.status}
              >
                <span className="service-name">
                  {t(`service.${service.serviceId}` as MessageKey)}
                </span>
                {service.plannedSet === null ? null : (
                  <span className="muted small">
                    {t('nav.plannedFor', { set: service.plannedSet })}
                  </span>
                )}
                <StatusBadge status={service.status} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}
