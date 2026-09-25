import { useEffect, useState } from 'react'
import type { GatewayStatus, SettingRecord } from '@jupiter/contracts'
import { request } from '../api'
import { useI18n } from '../i18n'
import { envelopeOf, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

/** Read-only: shows the configuration actually in use. Editing arrives in SET 2. */
export function SettingsView({
  status,
  coreRunning
}: {
  readonly status: Loadable<GatewayStatus>
  readonly coreRunning: boolean
}) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<Loadable<SettingRecord[]>>({ state: 'loading' })

  useEffect(() => {
    if (!coreRunning) return
    request('settings.list', {}).then(
      (result) => {
        setSettings({ state: 'ready', value: result.settings })
      },
      (error: unknown) => {
        setSettings({ state: 'error', error: envelopeOf(error) })
      }
    )
  }, [coreRunning])

  // Keyed by string so a setting the Core does not report simply reads as absent.
  const byKey = new Map<string, SettingRecord>(
    settings.state === 'ready' ? settings.value.map((setting) => [setting.key, setting]) : []
  )
  const logLevel = byKey.get('logging.level')

  return (
    <section className="view" aria-labelledby="settings-title">
      <h1 id="settings-title">{t('settings.title')}</h1>
      <p className="notice notice-info" data-testid="settings-read-only">
        {t('settings.readOnly')}
      </p>
      {status.state === 'loading' ? <p>{t('load.loading')}</p> : null}
      {status.state === 'error' ? (
        <LoadFailure title={t('load.infoFailed')} error={status.error} />
      ) : null}
      {settings.state === 'error' ? (
        <LoadFailure title={t('settings.loadFailed')} error={settings.error} />
      ) : null}
      {status.state === 'ready' ? (
        <section className="card">
          <dl className="settings-list">
            <div>
              <dt>{t('settings.language')}</dt>
              <dd>
                {t('settings.languageValue', {
                  language: t('settings.languageName'),
                  locale: status.value.app.systemLocale || navigator.language
                })}
              </dd>
            </div>
            <div>
              <dt>{t('settings.environment')}</dt>
              <dd>{t(`env.${status.value.app.environment}`)}</dd>
            </div>
            <div>
              <dt>{t('settings.dataFolder')}</dt>
              <dd>{status.value.app.paths.userData}</dd>
            </div>
            <div>
              <dt>{t('settings.logLevel')}</dt>
              <dd data-testid="settings-log-level">
                {t('settings.logLevelValue', {
                  value:
                    typeof logLevel?.value === 'string'
                      ? logLevel.value
                      : status.value.app.logging.level,
                  source:
                    logLevel?.source === 'stored'
                      ? t('settings.source.stored')
                      : t('settings.source.default')
                })}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </section>
  )
}
