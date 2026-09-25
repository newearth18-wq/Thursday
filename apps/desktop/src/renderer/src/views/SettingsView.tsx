import type { AppInfo } from '@jupiter/contracts'
import { useI18n } from '../i18n'
import type { Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

/** Read-only: shows the configuration actually in use. Editing arrives in SET 2. */
export function SettingsView({ info }: { readonly info: Loadable<AppInfo> }) {
  const { t } = useI18n()
  return (
    <section className="view" aria-labelledby="settings-title">
      <h1 id="settings-title">{t('settings.title')}</h1>
      <p className="notice notice-info" data-testid="settings-read-only">
        {t('settings.readOnly')}
      </p>
      {info.state === 'loading' ? <p>{t('load.loading')}</p> : null}
      {info.state === 'error' ? (
        <LoadFailure title={t('load.infoFailed')} error={info.error} />
      ) : null}
      {info.state === 'ready' ? (
        <section className="card">
          <dl className="settings-list">
            <div>
              <dt>{t('settings.language')}</dt>
              <dd>
                {t('settings.languageValue', {
                  language: t('settings.languageName'),
                  locale: info.value.systemLocale || navigator.language
                })}
              </dd>
            </div>
            <div>
              <dt>{t('settings.environment')}</dt>
              <dd>{t(`env.${info.value.environment}`)}</dd>
            </div>
            <div>
              <dt>{t('settings.dataFolder')}</dt>
              <dd>{info.value.paths.userData}</dd>
            </div>
            <div>
              <dt>{t('settings.logLevel')}</dt>
              <dd>{info.value.logging.level}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </section>
  )
}
