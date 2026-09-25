import type { AppInfo, RuntimeStatus } from '@jupiter/contracts'
import { StatusBadge } from '../components/StatusBadge'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import type { Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

interface Props {
  readonly info: Loadable<AppInfo>
  readonly runtime: Loadable<RuntimeStatus>
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

export function DiagnosticsView({ info, runtime }: Props) {
  const { t, locale } = useI18n()
  const formatTime = (iso: string | null) =>
    iso === null
      ? t('diagnostics.none')
      : new Intl.DateTimeFormat(intlLocale(locale), {
          dateStyle: 'medium',
          timeStyle: 'medium'
        }).format(new Date(iso))

  return (
    <section className="view" aria-labelledby="diagnostics-title">
      <h1 id="diagnostics-title">{t('diagnostics.title')}</h1>
      <p className="muted">{t('diagnostics.intro')}</p>

      {info.state === 'error' ? (
        <LoadFailure title={t('load.infoFailed')} error={info.error} />
      ) : null}
      {info.state === 'loading' ? <p>{t('load.loading')}</p> : null}
      {info.state === 'ready' ? (
        <>
          <section className="card" aria-labelledby="diag-build">
            <h2 id="diag-build">{t('diagnostics.build')}</h2>
            {info.value.build ? (
              <table className="facts-table">
                <tbody>
                  <Row label={t('diagnostics.product')} value={info.value.build.productName} />
                  <Row
                    label={t('diagnostics.version')}
                    value={info.value.build.version}
                    testId="diag-version"
                  />
                  <Row
                    label={t('diagnostics.channel')}
                    value={info.value.build.channel}
                    testId="diag-channel"
                  />
                  <Row
                    label={t('diagnostics.buildId')}
                    value={info.value.build.buildId}
                    testId="diag-build-id"
                  />
                  <Row
                    label={t('diagnostics.commit')}
                    testId="diag-commit"
                    value={
                      info.value.build.dirty
                        ? t('diagnostics.commitDirty', { commit: info.value.build.commit })
                        : info.value.build.commit
                    }
                  />
                  <Row
                    label={t('diagnostics.builtAt')}
                    value={`${formatTime(info.value.build.builtAt)} (${info.value.build.builtAt})`}
                  />
                </tbody>
              </table>
            ) : (
              <p className="notice notice-warning">{t('diagnostics.metadataMissing')}</p>
            )}
          </section>

          <section className="card" aria-labelledby="diag-runtime">
            <h2 id="diag-runtime">{t('diagnostics.runtime')}</h2>
            <table className="facts-table">
              <tbody>
                <Row
                  label={t('diagnostics.environment')}
                  value={t(`env.${info.value.environment}`)}
                  testId="diag-environment"
                />
                <Row
                  label={t('diagnostics.platform')}
                  value={`${info.value.platform} ${info.value.arch}`}
                  testId="diag-platform"
                />
                <Row label={t('diagnostics.osRelease')} value={info.value.osRelease} />
                <Row
                  label={t('diagnostics.packaged')}
                  value={info.value.packaged ? t('diagnostics.yes') : t('diagnostics.no')}
                />
                <Row
                  label={t('diagnostics.osSandbox')}
                  value={
                    info.value.osSandbox
                      ? t('diagnostics.enabled')
                      : t('diagnostics.disabledNoSandbox')
                  }
                  testId="diag-os-sandbox"
                />
                <Row
                  label={t('diagnostics.electron')}
                  value={info.value.versions.electron}
                  testId="diag-electron"
                />
                <Row label={t('diagnostics.chromium')} value={info.value.versions.chrome} />
                <Row label={t('diagnostics.node')} value={info.value.versions.node} />
                <Row label={t('diagnostics.v8')} value={info.value.versions.v8} />
              </tbody>
            </table>
          </section>

          <section className="card" aria-labelledby="diag-storage">
            <h2 id="diag-storage">{t('diagnostics.storage')}</h2>
            <table className="facts-table">
              <tbody>
                <Row
                  label={t('diagnostics.userData')}
                  value={info.value.paths.userData}
                  testId="diag-user-data"
                />
                <Row
                  label={t('diagnostics.logs')}
                  value={info.value.paths.logs}
                  testId="diag-logs"
                />
                <Row label={t('diagnostics.logLevel')} value={info.value.logging.level} />
                <Row
                  label={t('diagnostics.logRotation')}
                  value={t('diagnostics.logRotationValue', {
                    files: info.value.logging.maxFiles,
                    size: info.value.logging.maxFileBytes / (1024 * 1024)
                  })}
                />
              </tbody>
            </table>
          </section>
        </>
      ) : null}

      <section className="card" aria-labelledby="diag-services">
        <h2 id="diag-services">{t('diagnostics.services')}</h2>
        {runtime.state === 'error' ? (
          <LoadFailure title={t('load.statusFailed')} error={runtime.error} />
        ) : null}
        {runtime.state === 'loading' ? <p>{t('load.loading')}</p> : null}
        {runtime.state === 'ready' ? (
          <>
            <p className="muted small">
              {t('diagnostics.session')}: <code>{runtime.value.sessionId}</code>
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
                  {runtime.value.services.map((service) => (
                    <tr key={service.serviceId} data-testid={`diag-service-${service.serviceId}`}>
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
          </>
        ) : null}
      </section>
    </section>
  )
}
