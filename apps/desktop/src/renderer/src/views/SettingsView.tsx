import { useEffect, useState } from 'react'
import {
  SettingDefaults,
  type ErrorEnvelope,
  type GatewayStatus,
  type SettingRecord,
  type SettingValue
} from '@jupiter/contracts'
import { request } from '../api'
import { RadioGroup, Select, Switch } from '../components/FormControls'
import { ConfirmDialog } from '../components/InfoDialogs'
import { Tabs } from '../components/Tabs'
import { useNotify } from '../components/Toasts'
import { detectLocale, useI18n, type MessageKey } from '../i18n'
import { PREFERENCE_KEYS, usePreferences, type PreferenceKey } from '../preferences'
import { coreSessionOf, envelopeOf, type Loadable } from '../useRuntime'
import { PermissionsPanel } from './PermissionsPanel'
import { ViewHeader } from './ViewHeader'

/**
 * Settings (SET 2): language, appearance, accessibility, notifications,
 * permissions (SET 7) and Core logging. Changes apply at once and are saved by Jupiter Core; the page
 * says "Saved" only after Core confirms, and says plainly when a change could
 * not be saved and applies to this session only.
 */

type SettingsTab =
  'general' | 'appearance' | 'accessibility' | 'notifications' | 'permissions' | 'advanced'
type SaveState = { readonly kind: 'saved' } | { readonly kind: 'failed'; readonly message: string }

const TEXT_SCALES = ['100', '125', '150', '175', '200'] as const

export function SettingsView({
  status,
  coreRunning
}: {
  readonly status: Loadable<GatewayStatus>
  readonly coreRunning: boolean
}) {
  const { t } = useI18n()
  const prefs = usePreferences()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [saveState, setSaveState] = useState<SaveState | null>(null)

  const change = <K extends PreferenceKey>(key: K, value: SettingValue<K>) => {
    setSaveState(null)
    void prefs.update(key, value).then((error) => {
      setSaveState(error ? { kind: 'failed', message: error.message } : { kind: 'saved' })
    })
  }

  return (
    <section className="view view-settings" aria-labelledby="settings-title">
      <ViewHeader id="settings-title" title={t('settings.title')} />
      {prefs.status === 'unavailable' ? (
        <p className="notice notice-warning" role="status" data-testid="settings-unavailable">
          {t('settings.unavailable', {
            reason: prefs.loadError?.message ?? t('settings.coreNotRunning')
          })}
        </p>
      ) : null}
      {prefs.status === 'loading' ? <p>{t('load.loading')}</p> : null}
      <Tabs<SettingsTab>
        label={t('settings.sections')}
        selected={tab}
        onSelect={setTab}
        testId="settings-tabs"
        tabs={[
          {
            id: 'general',
            label: t('settings.tab.general'),
            panel: (
              <RadioGroup
                legend={t('settings.language')}
                name="language"
                testId="setting-language"
                value={prefs.values['ui.language']}
                onChange={(value) => {
                  change('ui.language', value)
                }}
                choices={[
                  {
                    value: 'system',
                    label: t('settings.languageSystem'),
                    hint: t(`language.${detectLocale(navigator.language)}` as MessageKey)
                  },
                  { value: 'en', label: t('language.en') },
                  { value: 'th', label: t('language.th') }
                ]}
                description={t('settings.languageHint')}
              />
            )
          },
          {
            id: 'appearance',
            label: t('settings.tab.appearance'),
            panel: (
              <>
                <RadioGroup
                  legend={t('settings.theme')}
                  name="theme"
                  testId="setting-theme"
                  value={prefs.values['ui.theme']}
                  onChange={(value) => {
                    change('ui.theme', value)
                  }}
                  choices={[
                    { value: 'standard', label: t('settings.themeStandard') },
                    { value: 'high-contrast', label: t('settings.themeHighContrast') }
                  ]}
                  description={t('settings.themeHint')}
                />
                <Select
                  label={t('settings.textScale')}
                  testId="setting-text-scale"
                  value={prefs.values['ui.textScale']}
                  onChange={(value) => {
                    change('ui.textScale', value)
                  }}
                  choices={TEXT_SCALES.map((value) => ({
                    value,
                    label: t('settings.percent', { value })
                  }))}
                  description={t('settings.textScaleHint')}
                />
                <Switch
                  label={t('settings.compact')}
                  testId="setting-compact"
                  checked={prefs.values['ui.compact']}
                  onChange={(value) => {
                    change('ui.compact', value)
                  }}
                  description={t('settings.compactHint')}
                />
              </>
            )
          },
          {
            id: 'accessibility',
            label: t('settings.tab.accessibility'),
            panel: (
              <>
                <RadioGroup
                  legend={t('settings.reduceMotion')}
                  name="reduce-motion"
                  testId="setting-reduce-motion"
                  value={prefs.values['ui.reduceMotion']}
                  onChange={(value) => {
                    change('ui.reduceMotion', value)
                  }}
                  choices={[
                    { value: 'system', label: t('settings.followSystem') },
                    { value: 'on', label: t('settings.on') },
                    { value: 'off', label: t('settings.off') }
                  ]}
                  description={t('settings.reduceMotionHint')}
                />
                <RadioGroup
                  legend={t('settings.avatar')}
                  name="avatar"
                  testId="setting-avatar"
                  value={prefs.values['ui.avatar']}
                  onChange={(value) => {
                    change('ui.avatar', value)
                  }}
                  choices={[
                    { value: 'animated', label: t('settings.avatarAnimated') },
                    { value: 'static', label: t('settings.avatarStatic') },
                    { value: 'hidden', label: t('settings.avatarHidden') }
                  ]}
                  description={t('settings.avatarHint')}
                />
              </>
            )
          },
          {
            id: 'notifications',
            label: t('settings.tab.notifications'),
            panel: (
              <NotificationsPanel
                coreRunning={coreRunning}
                enabled={prefs.values['notifications.desktop']}
                onChange={(value) => {
                  change('notifications.desktop', value)
                }}
              />
            )
          },
          {
            id: 'permissions',
            label: t('settings.tab.permissions'),
            panel: <PermissionsPanel coreSession={coreSessionOf(status)} />
          },
          {
            id: 'advanced',
            label: t('settings.tab.advanced'),
            panel: <AdvancedPanel coreRunning={coreRunning} status={status} />
          }
        ]}
      />
      <p
        className="save-status"
        role="status"
        data-testid="settings-save-status"
        data-state={saveState?.kind ?? 'none'}
      >
        {saveState?.kind === 'saved' ? t('settings.saved') : null}
        {saveState?.kind === 'failed'
          ? t('settings.notSaved', { reason: saveState.message })
          : null}
      </p>
    </section>
  )
}

function NotificationsPanel({
  coreRunning,
  enabled,
  onChange
}: {
  readonly coreRunning: boolean
  readonly enabled: boolean
  readonly onChange: (value: boolean) => void
}) {
  const { t } = useI18n()
  const notify = useNotify()
  const [supported, setSupported] = useState<Loadable<boolean>>({ state: 'loading' })
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!coreRunning) return
    let active = true
    request('host.notifications.status', {}).then(
      (result) => {
        if (active) setSupported({ state: 'ready', value: result.supported })
      },
      (error: unknown) => {
        if (active) setSupported({ state: 'error', error: envelopeOf(error) })
      }
    )
    return () => {
      active = false
    }
  }, [coreRunning])

  const unsupported = supported.state === 'ready' && !supported.value
  return (
    <>
      <Switch
        label={t('settings.desktopNotifications')}
        testId="setting-desktop-notifications"
        checked={enabled}
        onChange={onChange}
        description={t('settings.desktopNotificationsHint')}
      />
      <p className="muted small" data-testid="notifications-support">
        {supported.state === 'loading' ? t('load.loading') : null}
        {supported.state === 'error'
          ? t('settings.notificationsUnknown', { reason: supported.error.message })
          : null}
        {supported.state === 'ready'
          ? t(
              supported.value
                ? 'settings.notificationsSupported'
                : 'settings.notificationsUnsupported'
            )
          : null}
      </p>
      <button
        type="button"
        className="button"
        data-testid="send-test-notification"
        disabled={sending || unsupported || supported.state !== 'ready'}
        onClick={() => {
          setSending(true)
          request('host.notifications.show', {
            tone: 'info',
            title: t('settings.testNotificationTitle'),
            body: t('settings.testNotificationBody')
          })
            .then(
              () => {
                notify({ tone: 'success', title: t('settings.testNotificationShown') })
              },
              (error: unknown) => {
                notify({
                  tone: 'error',
                  title: t('settings.testNotificationFailed'),
                  message: envelopeOf(error).message
                })
              }
            )
            .finally(() => {
              setSending(false)
            })
        }}
      >
        {t('settings.sendTestNotification')}
      </button>
    </>
  )
}

type LogLevelChoice = 'default' | 'debug' | 'info' | 'warn' | 'error'

function logLevelChoice(value: unknown): LogLevelChoice {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : 'default'
}

function AdvancedPanel({
  coreRunning,
  status
}: {
  readonly coreRunning: boolean
  readonly status: Loadable<GatewayStatus>
}) {
  const { t } = useI18n()
  const prefs = usePreferences()
  const notify = useNotify()
  const [logLevel, setLogLevel] = useState<Loadable<SettingRecord>>({ state: 'loading' })
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!coreRunning) return
    let active = true
    request('settings.list', {}).then(
      (result) => {
        const record = result.settings.find((setting) => setting.key === 'logging.level')
        if (active && record) setLogLevel({ state: 'ready', value: record })
      },
      (error: unknown) => {
        if (active) setLogLevel({ state: 'error', error: envelopeOf(error) })
      }
    )
    return () => {
      active = false
    }
  }, [coreRunning])

  const environmentLevel = status.state === 'ready' ? status.value.app.logging.level : null
  const current: LogLevelChoice =
    logLevel.state === 'ready' ? logLevelChoice(logLevel.value.value) : 'default'

  const resetPreferences = async (): Promise<ErrorEnvelope | null> => {
    for (const key of PREFERENCE_KEYS) {
      const failure = await prefs.update(key, SettingDefaults[key])
      if (failure) return failure
    }
    return null
  }

  return (
    <>
      {logLevel.state === 'error' ? (
        <p className="notice notice-warning" role="status">
          {t('settings.logLevelUnavailable', { reason: logLevel.error.message })}
        </p>
      ) : null}
      <Select<LogLevelChoice>
        label={t('settings.logLevel')}
        testId="setting-log-level"
        value={current}
        description={t('settings.logLevelHint')}
        onChange={(value) => {
          request('settings.update', {
            key: 'logging.level',
            value: value === 'default' ? null : value
          }).then(
            (record) => {
              setLogLevel({ state: 'ready', value: record })
              notify({ tone: 'success', title: t('settings.logLevelSaved') })
            },
            (error: unknown) => {
              notify({
                tone: 'error',
                title: t('settings.notSaved', { reason: envelopeOf(error).message })
              })
            }
          )
        }}
        choices={[
          {
            value: 'default',
            label: t('settings.logLevelDefault', { level: environmentLevel ?? '—' })
          },
          { value: 'debug', label: 'debug' },
          { value: 'info', label: 'info' },
          { value: 'warn', label: 'warn' },
          { value: 'error', label: 'error' }
        ]}
      />
      <div className="field">
        <p className="field-label">{t('settings.reset')}</p>
        <p className="muted small">{t('settings.resetHint')}</p>
        <button
          type="button"
          className="button"
          data-testid="reset-preferences"
          onClick={() => {
            setConfirming(true)
          }}
        >
          {t('settings.resetButton')}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t('settings.resetTitle')}
        description={t('settings.resetConfirm')}
        confirmLabel={t('settings.resetButton')}
        testId="reset-dialog"
        onCancel={() => {
          setConfirming(false)
        }}
        onConfirm={() => {
          setConfirming(false)
          void resetPreferences().then((failure) => {
            notify(
              failure
                ? {
                    tone: 'error',
                    title: t('settings.resetFailed'),
                    message: failure.message
                  }
                : { tone: 'success', title: t('settings.resetDone') }
            )
          })
        }}
      />
    </>
  )
}
