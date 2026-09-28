import { useEffect, useState } from 'react'
import { Tabs } from '../components/Tabs'
import type { SettingKey, VoiceEngineInfo, VoiceOption, VoiceStatus } from '@jupiter/contracts'
import { request } from '../api'
import { Select, Switch } from '../components/FormControls'
import { StateMessage } from '../components/StateMessage'
import { PushToTalkButton, StopSpeakingButton } from '../components/VoiceControls'
import { useI18n, type MessageKey } from '../i18n'
import { withPermission } from '../useFiles'
import { coreSessionOf, envelopeOf, useRuntimeContext } from '../useRuntime'
import { audioDevices } from '../voice/capture'
import { useVoice, type VoiceSettingsView } from '../voice/VoiceProvider'
import { LoadFailure } from './LoadFailure'
import { ViewHeader } from './ViewHeader'
import { CameraPanel, VisionPanel } from './VisionPanels'

/**
 * Devices: voice (SET 12) — whether it is on, each engine and where it runs,
 * Push-to-Talk and the wake word, the last exchange and every voice setting;
 * Vision (SET 13) — captures of the screen, what Vision reads in them and how
 * privacy was handled; and the camera (SET 13), with its preview.
 */

type DevicesTab = 'voice' | 'vision' | 'camera'

const RATES = ['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'] as const

export function DevicesView() {
  const { t } = useI18n()
  const { status: runtime } = useRuntimeContext()
  const voice = useVoice()
  const coreSession = coreSessionOf(runtime)
  const [tab, setTab] = useState<DevicesTab>('voice')
  return (
    <section className="view view-devices" aria-labelledby="devices-title">
      <ViewHeader id="devices-title" title={t('nav.devices')} />
      <p className="muted">{t('devices.intro')}</p>
      {coreSession === null ? (
        <StateMessage kind="unavailable" title={t('voice.coreDown')} testId="voice-core-down" />
      ) : null}
      <Tabs<DevicesTab>
        label={t('nav.devices')}
        selected={tab}
        onSelect={setTab}
        testId="devices-tabs"
        tabs={[
          {
            id: 'voice',
            label: t('devices.tab.voice'),
            panel: (
              <>
                <p className="muted">{t('voice.intro')}</p>
                {voice.status.state === 'error' ? (
                  <LoadFailure title={t('voice.statusFailed')} error={voice.status.error} />
                ) : null}
                {voice.status.state === 'ready' && voice.settings.state === 'ready' ? (
                  <>
                    <VoiceStatusCard status={voice.status.value} settings={voice.settings.value} />
                    <TalkCard status={voice.status.value} settings={voice.settings.value} />
                    <VoiceSettingsCard
                      status={voice.status.value}
                      settings={voice.settings.value}
                    />
                  </>
                ) : null}
              </>
            )
          },
          { id: 'vision', label: t('devices.tab.vision'), panel: <VisionPanel /> },
          { id: 'camera', label: t('devices.tab.camera'), panel: <CameraPanel /> }
        ]}
      />
    </section>
  )
}

function saveSetting(key: SettingKey, value: unknown) {
  return request('settings.update', { key, value } as never)
}

function LocalityBadge({ engine }: { readonly engine: VoiceEngineInfo }) {
  const { t } = useI18n()
  if (!engine.available || !engine.locality)
    return <span className="badge badge-warning">{t('availability.UNAVAILABLE')}</span>
  return (
    <span
      className={`badge ${engine.locality === 'cloud' ? 'badge-warning' : 'badge-success'}`}
      data-testid={`voice-locality-${engine.kind}`}
      data-locality={engine.locality}
    >
      {t(engine.locality === 'cloud' ? 'voice.locality.cloud' : 'voice.locality.local')}
    </span>
  )
}

function VoiceStatusCard({
  status,
  settings
}: {
  readonly status: VoiceStatus
  readonly settings: VoiceSettingsView
}) {
  const { t } = useI18n()
  const [problem, setProblem] = useState<string | null>(null)
  const engines: VoiceEngineInfo[] = [
    status.engines.wakeWord,
    status.engines.vad,
    status.engines.stt,
    status.engines.tts
  ]
  return (
    <section className="card" aria-labelledby="voice-status-title" data-testid="voice-status">
      <h2 id="voice-status-title">{t('voice.title')}</h2>
      <p>
        <span
          className={`badge badge-${stateTone(status.state)}`}
          data-testid="voice-state"
          data-state={status.state}
          role="status"
        >
          {t(`voice.state.${status.state}` as MessageKey)}
        </span>
      </p>
      <Switch
        label={t('voice.enable')}
        description={t('voice.enableHint')}
        checked={settings.enabled}
        testId="voice-enabled"
        onChange={(next) => {
          setProblem(null)
          saveSetting('voice.enabled', next).catch((error: unknown) => {
            setProblem(envelopeOf(error).message)
          })
        }}
      />
      {problem ? (
        <p className="small" role="alert">
          {problem}
        </p>
      ) : null}
      <h3>{t('voice.engines')}</h3>
      <p className="muted small">{t('voice.enginesHint')}</p>
      <ul className="plain-list voice-engines" data-testid="voice-engines">
        {engines.map((engine) => (
          <li
            key={engine.kind}
            data-testid={`voice-engine-${engine.kind}`}
            data-available={engine.available}
          >
            <strong>{t(`voice.engine.${engine.kind}` as MessageKey)}</strong>{' '}
            <LocalityBadge engine={engine} />{' '}
            <span className="muted small">
              {engine.available ? (engine.name ?? '') : (engine.reason ?? '')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TalkCard({
  status,
  settings
}: {
  readonly status: VoiceStatus
  readonly settings: VoiceSettingsView
}) {
  const { t } = useI18n()
  const voice = useVoice()
  const wake = status.engines.wakeWord
  return (
    <section className="card" aria-labelledby="voice-talk-title" data-testid="voice-talk">
      <h2 id="voice-talk-title">{t('voice.talk')}</h2>
      {!status.enabled ? (
        <p className="muted" data-testid="voice-off">
          {t('voice.offHint')}
        </p>
      ) : !status.engines.stt.available ? (
        <p className="muted" data-testid="voice-no-stt">
          {t('voice.noStt', { reason: status.engines.stt.reason ?? '' })}
        </p>
      ) : (
        <p className="muted small" data-testid="voice-privacy-note">
          {t(
            status.engines.stt.locality === 'cloud' ? 'voice.privacy.cloud' : 'voice.privacy.local',
            { engine: status.engines.stt.name ?? '' }
          )}
        </p>
      )}
      <div className="actions">
        <PushToTalkButton />
        <StopSpeakingButton />
        {settings.wakeWordEnabled && status.enabled ? (
          voice.mode === 'wake-word' ? (
            <button
              type="button"
              className="button"
              data-testid="voice-wake-stop"
              onClick={() => {
                void voice.cancelListening()
              }}
            >
              {t('voice.wake.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="button"
              data-testid="voice-wake-start"
              disabled={!wake.available || voice.busy}
              onClick={() => {
                void voice.startWakeWord()
              }}
            >
              {t('voice.wake.start', { phrase: settings.wakeWord })}
            </button>
          )
        ) : null}
      </div>
      <p className="muted small">{t('voice.ptt.shortcut')}</p>
      {settings.wakeWordEnabled && !wake.available ? (
        <p className="small" data-testid="voice-wake-unavailable">
          <span className="badge badge-warning">{t('availability.UNAVAILABLE')}</span> {wake.reason}
        </p>
      ) : null}
      {voice.waitingPermission ? (
        <p className="small" role="status">
          {t('files.waitingPermission')}
        </p>
      ) : null}
      {voice.error ? (
        <LoadFailure
          title={t('voice.actionFailed')}
          error={voice.error}
          testId="voice-action-error"
        />
      ) : null}
      {status.lastError ? (
        <div
          className="notice"
          role="alert"
          data-testid="voice-error"
          data-code={status.lastError.code}
        >
          <LoadFailure title={t('voice.pipelineFailed')} error={status.lastError} />
          {status.state === 'ERROR' ? (
            <button
              type="button"
              className="button"
              data-testid="voice-recover"
              onClick={() => {
                void voice.recover()
              }}
            >
              {t('voice.recover')}
            </button>
          ) : null}
        </div>
      ) : null}
      {status.lastExchange ? (
        <dl className="facts facts-stacked" data-testid="voice-exchange">
          <div>
            <dt>{t('voice.heard')}</dt>
            <dd data-testid="voice-transcript" lang={status.lastExchange.language ?? undefined}>
              {status.lastExchange.transcript || t('voice.nothingHeard')}
            </dd>
          </div>
          {status.lastExchange.reply ? (
            <div>
              <dt>{t('voice.replied')}</dt>
              <dd data-testid="voice-reply" lang={status.lastExchange.language ?? undefined}>
                {status.lastExchange.reply}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <p className="muted small">{t('voice.notKept')}</p>
    </section>
  )
}

function VoiceSettingsCard({
  status,
  settings
}: {
  readonly status: VoiceStatus
  readonly settings: VoiceSettingsView
}) {
  const { t, locale } = useI18n()
  const voice = useVoice()
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [phrase, setPhrase] = useState(settings.wakeWord)

  const listDevices = async () => {
    const found = await audioDevices()
    setInputs(found.inputs)
    setOutputs(found.outputs)
  }
  useEffect(() => {
    audioDevices().then(
      (found) => {
        setInputs(found.inputs)
        setOutputs(found.outputs)
      },
      () => undefined
    )
    request('voice.voices', {}).then(
      (result) => {
        setVoices(result.voices)
      },
      () => undefined
    )
  }, [voice.version])

  const save = (key: SettingKey, value: unknown) => {
    setProblem(null)
    saveSetting(key, value).then(
      () => {
        voice.reload()
      },
      (error: unknown) => {
        setProblem(envelopeOf(error).message)
      }
    )
  }
  const named = inputs.some((device) => device.label)
  const choices = (devices: MediaDeviceInfo[], fallback: MessageKey) => [
    { value: '', label: t('voice.device.default') },
    ...devices
      .filter((device) => device.deviceId && device.deviceId !== 'default')
      .map((device, index) => ({
        value: device.deviceId,
        label: device.label || t(fallback, { number: index + 1 })
      }))
  ]
  const sourceVoices = voices.filter((item) => item.source === settings.speechSource)

  return (
    <section className="card" aria-labelledby="voice-settings-title" data-testid="voice-settings">
      <h2 id="voice-settings-title">{t('voice.settings')}</h2>
      <div className="voice-settings-grid">
        <Select<string>
          label={t('voice.inputDevice')}
          value={settings.inputDevice ?? ''}
          testId="voice-input-device"
          choices={choices(inputs, 'voice.device.microphone')}
          onChange={(next) => {
            save('voice.inputDevice', next || null)
          }}
        />
        <Select<string>
          label={t('voice.outputDevice')}
          value={settings.outputDevice ?? ''}
          testId="voice-output-device"
          choices={choices(outputs, 'voice.device.speaker')}
          onChange={(next) => {
            save('voice.outputDevice', next || null)
          }}
        />
      </div>
      {!named ? (
        <p className="small">
          <span className="muted">{t('voice.device.namesHint')}</span>{' '}
          <button
            type="button"
            className="button"
            disabled={!status.enabled}
            data-testid="voice-reveal-devices"
            onClick={() => {
              setProblem(null)
              withPermission(() => request('voice.devices.reveal', {}))
                .then(listDevices)
                .catch((error: unknown) => {
                  setProblem(envelopeOf(error).message)
                })
            }}
          >
            {t('voice.device.showNames')}
          </button>
        </p>
      ) : null}
      <Switch
        label={t('voice.wake.enable')}
        description={t('voice.wake.enableHint')}
        checked={settings.wakeWordEnabled}
        testId="voice-wake-enabled"
        onChange={(next) => {
          save('voice.wakeWordEnabled', next)
        }}
      />
      <div className="field">
        <label htmlFor="voice-wake-phrase">{t('voice.wake.phrase')}</label>
        <input
          id="voice-wake-phrase"
          className="input"
          value={phrase}
          maxLength={40}
          data-testid="voice-wake-phrase"
          onChange={(event) => {
            setPhrase(event.target.value)
          }}
          onBlur={() => {
            if (phrase.trim() && phrase.trim() !== settings.wakeWord)
              save('voice.wakeWord', phrase.trim())
          }}
        />
      </div>
      <div className="voice-settings-grid">
        <Select<'system' | 'provider'>
          label={t('voice.source')}
          value={settings.speechSource}
          testId="voice-source"
          choices={[
            { value: 'system', label: t('voice.source.system') },
            { value: 'provider', label: t('voice.source.provider') }
          ]}
          onChange={(next) => {
            save('voice.speechSource', next)
            save('voice.voice', null)
          }}
        />
        <Select<string>
          label={t('voice.voice')}
          value={settings.voice ?? ''}
          testId="voice-voice"
          choices={[
            { value: '', label: t('voice.voice.default') },
            ...sourceVoices.map((item) => ({
              value: item.id,
              label: `${item.name} · ${item.language}`
            }))
          ]}
          onChange={(next) => {
            save('voice.voice', next || null)
          }}
        />
        <Select<'auto' | 'en' | 'th'>
          label={t('voice.language')}
          value={settings.language}
          testId="voice-language"
          choices={[
            { value: 'auto', label: t('voice.language.auto') },
            { value: 'en', label: t('language.en') },
            { value: 'th', label: t('language.th') }
          ]}
          onChange={(next) => {
            save('voice.language', next)
          }}
        />
        <Select<(typeof RATES)[number]>
          label={t('voice.rate')}
          value={RATES.find((rate) => Number(rate) === settings.speakingRate) ?? '1'}
          testId="voice-rate"
          choices={RATES.map((rate) => ({
            value: rate,
            label: t('voice.rate.value', { rate: Number(rate).toLocaleString(locale) })
          }))}
          onChange={(next) => {
            save('voice.speakingRate', Number(next))
          }}
        />
        <Select<'low' | 'medium' | 'high'>
          label={t('voice.sensitivity')}
          value={settings.interruptionSensitivity}
          testId="voice-sensitivity"
          choices={(['low', 'medium', 'high'] as const).map((value) => ({
            value,
            label: t(`voice.sensitivity.${value}`)
          }))}
          onChange={(next) => {
            save('voice.interruptionSensitivity', next)
          }}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-testid="voice-test"
          disabled={!status.engines.tts.available}
          onClick={() => {
            void voice.speak(t('voice.testText'))
          }}
        >
          <span>{t('voice.test')}</span>
        </button>
        <span className="muted small">
          {status.engines.tts.available ? status.engines.tts.name : status.engines.tts.reason}
        </span>
      </div>
      {problem ? (
        <p className="small" role="alert" data-testid="voice-settings-problem">
          {problem}
        </p>
      ) : null}
    </section>
  )
}

function stateTone(state: VoiceStatus['state']): string {
  switch (state) {
    case 'ERROR':
      return 'error'
    case 'DISABLED':
      return 'muted'
    case 'IDLE':
      return 'info'
    default:
      return 'success'
  }
}
