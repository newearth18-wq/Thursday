import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DomainEvent,
  ErrorEnvelope,
  EventFilter,
  IdentityStatus,
  IdentityVerification,
  MethodStatus,
  VoiceSession
} from '@jupiter/contracts'
import { request } from '../api'
import { Select, Switch } from '../components/FormControls'
import { ConfirmDialog } from '../components/InfoDialogs'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { keyOf, useBump, useQuery } from '../useAi'
import { withPermission } from '../useFiles'
import { useLiveEvents } from '../useLiveEvents'
import { envelopeOf } from '../useRuntime'
import { useCamera } from '../vision/CameraProvider'
import { startCapture, type Capture } from '../voice/capture'
import { CameraPreview } from './VisionPanels'
import { LoadFailure } from './LoadFailure'

/**
 * Identity (SET 14) in Settings: how sure Jupiter is that you are at the
 * computer, until when, and why; Windows Hello, Face Identity and Voice
 * Identity with what each can prove; setting a method up (with consent),
 * turning it off, setting it up again and deleting its data; and identity
 * protection for sensitive actions. Every level, liveness result and
 * lockout shown here comes from Jupiter Core — nothing is decided here, and
 * no image, recording or template ever reaches this page.
 */

const IDENTITY_EVENTS: EventFilter = {
  types: [
    'identity.verification',
    'identity.enrollment',
    'identity.protection_changed',
    'identity.assurance_changed',
    'settings.changed'
  ],
  streams: null,
  missionId: null
}

/** Frames for setting up and for checking, a little apart so each shows real movement. */
const ENROLL_FRAMES = 6
const VERIFY_FRAMES = 4
const FRAME_GAP_MS = 450
const TIMEOUTS = ['1', '5', '10', '15', '30', '60'] as const

type Outcome =
  | { readonly kind: 'verification'; readonly value: IdentityVerification }
  | { readonly kind: 'method'; readonly value: MethodStatus }

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

function useIdentityStatus(coreSession: string | null) {
  const [version, bump] = useBump(50)
  const onEvent = useCallback(
    (_event: DomainEvent) => {
      bump()
    },
    [bump]
  )
  const { opened } = useLiveEvents(IDENTITY_EVENTS, onEvent, coreSession)
  const load = useCallback(async () => request('identity.status', {}), [])
  const [status] = useQuery(keyOf(coreSession, 'identity-status', opened, version), load)
  return { status, reload: bump }
}

export function IdentityPanel({ coreSession }: { readonly coreSession: string | null }) {
  const { t } = useI18n()
  const { status, reload } = useIdentityStatus(coreSession)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState<ErrorEnvelope | null>(null)
  const [busy, setBusy] = useState(false)

  // Every action here: one at a time, its real result or its real error.
  const run = useCallback(
    async (action: () => Promise<Outcome | null>) => {
      setBusy(true)
      setError(null)
      setOutcome(null)
      try {
        setOutcome(await action())
      } catch (failure) {
        setError(envelopeOf(failure))
      } finally {
        setBusy(false)
        reload()
      }
    },
    [reload]
  )

  if (status.state === 'error')
    return <LoadFailure title={t('identity.statusFailed')} error={status.error} />
  if (status.state !== 'ready') return <p className="muted">{t('load.loading')}</p>
  const value = status.value
  const method = (name: MethodStatus['method']) =>
    value.methods.find((item) => item.method === name) ?? null
  const hello = method('windows-hello')
  const face = method('face')
  const voice = method('voice')
  return (
    <div className="identity-panel" data-testid="identity-panel">
      <AssuranceCard status={value} busy={busy} run={run} />
      <ProtectionCard status={value} busy={busy} run={run} />
      {outcome ? <OutcomeNotice outcome={outcome} /> : null}
      {error ? (
        <p
          className="notice notice-error"
          role="alert"
          data-testid="identity-error"
          data-code={error.code}
        >
          {error.message} {error.userAction ?? ''}
        </p>
      ) : null}
      {hello ? <HelloCard method={hello} busy={busy} run={run} /> : null}
      {face ? <FaceCard method={face} protection={value.protection} busy={busy} run={run} /> : null}
      {voice ? (
        <VoiceCard method={voice} protection={value.protection} busy={busy} run={run} />
      ) : null}
    </div>
  )
}

type Run = (action: () => Promise<Outcome | null>) => Promise<void>

function levelTone(level: IdentityStatus['assurance']['level']): string {
  switch (level) {
    case 'STRONG_VERIFIED':
    case 'VERIFIED':
      return 'badge-success'
    case 'RECOGNIZED':
      return 'badge-warning'
    case 'UNKNOWN':
      return 'badge-muted'
  }
}

function useTime() {
  const { locale } = useI18n()
  return (iso: string) =>
    new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: 'medium' }).format(new Date(iso))
}

function AssuranceCard({
  status,
  busy,
  run
}: {
  readonly status: IdentityStatus
  readonly busy: boolean
  readonly run: Run
}) {
  const { t } = useI18n()
  const time = useTime()
  const assurance = status.assurance
  const liveness = assurance.liveness
  return (
    <section className="card" aria-labelledby="identity-title" data-testid="identity-assurance">
      <h2 id="identity-title">{t('identity.title')}</h2>
      <p className="muted small">{t('identity.hint')}</p>
      <p>
        <span
          className={`badge ${levelTone(assurance.level)}`}
          data-testid="identity-level"
          data-level={assurance.level}
          role="status"
        >
          {t(`identity.level.${assurance.level}` as MessageKey)}
        </span>{' '}
        <span className="muted small">
          {t(`identity.levelHint.${assurance.level}` as MessageKey)}
        </span>
      </p>
      <dl className="facts facts-compact">
        {assurance.method ? (
          <div>
            <dt>{t('identity.by')}</dt>
            <dd data-testid="identity-method">
              {t(`identity.method.${assurance.method}` as MessageKey)}
            </dd>
          </div>
        ) : null}
        {assurance.expiresAt ? (
          <div>
            <dt>{t('identity.until')}</dt>
            <dd data-testid="identity-expires">{time(assurance.expiresAt)}</dd>
          </div>
        ) : null}
        {assurance.reason ? (
          <div>
            <dt>{t('identity.why')}</dt>
            <dd data-testid="identity-reason">{assurance.reason}</dd>
          </div>
        ) : null}
      </dl>
      {liveness ? (
        <div data-testid="identity-liveness" data-state={liveness.state}>
          <h3>
            {t('identity.liveness')}{' '}
            <span className="badge badge-muted" data-availability="EXPERIMENTAL">
              {t('availability.EXPERIMENTAL')}
            </span>{' '}
            <span
              className={`badge ${liveness.state === 'passed' ? 'badge-success' : 'badge-warning'}`}
              data-testid="identity-liveness-state"
            >
              {t(`identity.livenessState.${liveness.state}` as MessageKey)}
            </span>
          </h3>
          <ul className="plain-list">
            {liveness.checks.map((check) => (
              <li
                key={check.name}
                data-testid={`identity-check-${check.name}`}
                data-passed={check.passed}
              >
                <strong>{t(`identity.check.${check.name}` as MessageKey)}</strong>{' '}
                <span className={`badge ${check.passed ? 'badge-success' : 'badge-warning'}`}>
                  {t(check.passed ? 'identity.checkPassed' : 'identity.checkFailed')}
                </span>{' '}
                <span className="muted small">{check.detail}</span>
              </li>
            ))}
          </ul>
          <p className="small" data-testid="identity-liveness-limitation">
            {t('identity.livenessLimitation')}
          </p>
        </div>
      ) : null}
      {assurance.level !== 'UNKNOWN' ? (
        <div className="actions">
          <button
            type="button"
            className="button"
            data-testid="identity-forget"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                await request('identity.forget', {})
                return null
              })
            }}
          >
            {t('identity.forget')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function ProtectionCard({
  status,
  busy,
  run
}: {
  readonly status: IdentityStatus
  readonly busy: boolean
  readonly run: Run
}) {
  const { t } = useI18n()
  const [problem, setProblem] = useState<string | null>(null)
  const timeout = String(status.timeoutMinutes)
  return (
    <section
      className="card"
      aria-labelledby="identity-protection-title"
      data-testid="identity-protection-card"
    >
      <h2 id="identity-protection-title">{t('identity.protection')}</h2>
      <Switch
        label={t('identity.protectionSwitch')}
        description={t('identity.protectionHint')}
        checked={status.protection}
        disabled={busy}
        testId="identity-protection"
        onChange={(next) => {
          void run(async () => {
            await request('identity.protection.set', { enabled: next })
            return null
          })
        }}
      />
      <Select<string>
        label={t('settingName.identity.timeoutMinutes')}
        description={t('identity.timeoutHint')}
        value={(TIMEOUTS as readonly string[]).includes(timeout) ? timeout : '10'}
        testId="identity-timeout"
        onChange={(next) => {
          setProblem(null)
          request('settings.update', { key: 'identity.timeoutMinutes', value: Number(next) }).catch(
            (failure: unknown) => {
              setProblem(envelopeOf(failure).message)
            }
          )
        }}
        choices={TIMEOUTS.map((minutes) => ({
          value: minutes,
          label: t('identity.minutes', { minutes })
        }))}
      />
      {problem ? (
        <p className="small" role="alert">
          {problem}
        </p>
      ) : null}
      <h3>{t('identity.requirements')}</h3>
      <ul className="plain-list" data-testid="identity-requirements">
        <li>
          <strong>{t('identity.requirementCritical')}</strong>{' '}
          <span className="badge badge-success">{t('identity.level.STRONG_VERIFIED')}</span>
        </li>
        {status.requirements.map((item) => (
          <li key={item.capability}>
            <code>{item.capability}</code>{' '}
            <span className="badge badge-muted">
              {t(`identity.level.${item.level}` as MessageKey)}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted small">{t('identity.permissionStill')}</p>
    </section>
  )
}

function OutcomeNotice({ outcome }: { readonly outcome: Outcome }) {
  const { t } = useI18n()
  if (outcome.kind === 'method')
    return (
      <p
        className="notice notice-info"
        role="status"
        data-testid="identity-result"
        data-outcome="enrolled"
      >
        {t('identity.enrolled', {
          method: t(`identity.method.${outcome.value.method}` as MessageKey)
        })}
      </p>
    )
  const verification = outcome.value
  const good = verification.outcome === 'verified' || verification.outcome === 'recognized'
  return (
    <p
      className={`notice ${good ? 'notice-info' : 'notice-warning'}`}
      role="status"
      data-testid="identity-result"
      data-outcome={verification.outcome}
    >
      {t(`identity.outcome.${verification.outcome}` as MessageKey, {
        method: t(`identity.method.${verification.method}` as MessageKey),
        level: t(`identity.level.${verification.assurance.level}` as MessageKey)
      })}
    </p>
  )
}

function MethodHeader({ method }: { readonly method: MethodStatus }) {
  const { t } = useI18n()
  const time = useTime()
  return (
    <>
      <h2 id={`identity-${method.method}-title`}>
        {t(`identity.method.${method.method}` as MessageKey)}{' '}
        {method.experimental ? (
          <span className="badge badge-muted" data-availability="EXPERIMENTAL">
            {t('availability.EXPERIMENTAL')}
          </span>
        ) : null}{' '}
        {!method.available ? (
          <span
            className="badge badge-warning"
            data-availability={
              method.reason?.startsWith('Not configured') ? 'NOT_CONFIGURED' : 'UNAVAILABLE'
            }
            data-testid={`identity-${method.method}-availability`}
          >
            {t(
              method.reason?.startsWith('Not configured')
                ? 'availability.NOT_CONFIGURED'
                : 'availability.UNAVAILABLE'
            )}
          </span>
        ) : null}
      </h2>
      <p className="muted small">{t(`identity.methodHint.${method.method}` as MessageKey)}</p>
      <dl className="facts facts-compact">
        <div>
          <dt>{t('identity.maxLevel')}</dt>
          <dd>{t(`identity.level.${method.maxLevel}` as MessageKey)}</dd>
        </div>
        <div>
          <dt>{t('identity.engine')}</dt>
          <dd>{method.available ? (method.engine ?? '') : (method.reason ?? '')}</dd>
        </div>
        {method.method !== 'windows-hello' ? (
          <div>
            <dt>{t('identity.setUp')}</dt>
            <dd data-testid={`identity-${method.method}-enrolled`} data-enrolled={method.enrolled}>
              {method.enrolled && method.enrolledAt
                ? t(method.enabled ? 'identity.enrolledAt' : 'identity.enrolledOff', {
                    time: time(method.enrolledAt),
                    samples: method.samples
                  })
                : t('identity.notEnrolled')}
            </dd>
          </div>
        ) : null}
      </dl>
      {method.lockedUntil ? (
        <p
          className="notice notice-warning"
          role="status"
          data-testid={`identity-${method.method}-locked`}
        >
          {t('identity.lockedOut', { time: time(method.lockedUntil) })}
        </p>
      ) : null}
    </>
  )
}

function HelloCard({
  method,
  busy,
  run
}: {
  readonly method: MethodStatus
  readonly busy: boolean
  readonly run: Run
}) {
  const { t } = useI18n()
  return (
    <section
      className="card"
      aria-labelledby="identity-windows-hello-title"
      data-testid="identity-hello"
    >
      <MethodHeader method={method} />
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="identity-hello-verify"
          disabled={busy || !method.available}
          onClick={() => {
            void run(async () => ({
              kind: 'verification',
              value: await request('identity.hello.verify', { reason: t('identity.helloReason') })
            }))
          }}
        >
          {t('identity.helloVerify')}
        </button>
      </div>
    </section>
  )
}

/** Turn off / on, and delete (with confirmation), for a method Jupiter keeps a template for. */
function MethodControls({
  method,
  protection,
  busy,
  run
}: {
  readonly method: MethodStatus
  readonly protection: boolean
  readonly busy: boolean
  readonly run: Run
}) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  if (method.method === 'windows-hello' || !method.enrolled) return null
  const name = method.method
  return (
    <>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-testid={`identity-${name}-toggle`}
          data-enabled={method.enabled}
          disabled={busy}
          onClick={() => {
            void run(async () => ({
              kind: 'method',
              value: await request('identity.method.enable', {
                method: name,
                enabled: !method.enabled
              })
            }))
          }}
        >
          {t(method.enabled ? 'identity.disable' : 'identity.enable')}
        </button>
        <button
          type="button"
          className="button button-danger"
          data-testid={`identity-${name}-delete`}
          disabled={busy}
          onClick={() => {
            setConfirming(true)
          }}
        >
          {t('identity.delete')}
        </button>
      </div>
      {protection ? <p className="muted small">{t('identity.changeNeedsVerified')}</p> : null}
      <ConfirmDialog
        open={confirming}
        title={t('identity.deleteTitle', { method: t(`identity.method.${name}` as MessageKey) })}
        description={t('identity.deleteDescription')}
        confirmLabel={t('identity.delete')}
        testId={`identity-${name}-delete-dialog`}
        onCancel={() => {
          setConfirming(false)
        }}
        onConfirm={() => {
          setConfirming(false)
          void run(async () => {
            await withPermission(() => request('identity.method.delete', { method: name }))
            return null
          })
        }}
      />
    </>
  )
}

function FaceCard({
  method,
  protection,
  busy,
  run
}: {
  readonly method: MethodStatus
  readonly protection: boolean
  readonly busy: boolean
  readonly run: Run
}) {
  const { t } = useI18n()
  const camera = useCamera()
  const [consent, setConsent] = useState(false)
  const [capturing, setCapturing] = useState<{ index: number; count: number } | null>(null)
  const state = camera.status.state === 'ready' ? camera.status.value.state : null
  const on = state === 'ACTIVE' || state === 'PAUSED' || state === 'STARTING'

  // Frames a little apart, then the check; the camera is released afterwards either way.
  const withFrames = (count: number, check: (frames: string[]) => Promise<Outcome>) =>
    run(async () => {
      const frames: string[] = []
      try {
        for (let index = 0; index < count; index++) {
          if (index > 0) await sleep(FRAME_GAP_MS)
          setCapturing({ index: index + 1, count })
          const image = await camera.capture()
          if (!image) break
          frames.push(image.imageId)
        }
        setCapturing(null)
        // A frame that could not be captured shows the camera's own error below.
        if (frames.length < count) return null
        return await check(frames)
      } finally {
        setCapturing(null)
        await camera.close()
      }
    })

  return (
    <section className="card" aria-labelledby="identity-face-title" data-testid="identity-face">
      <MethodHeader method={method} />
      {method.available ? (
        <>
          {!method.enrolled || !on ? (
            <Switch
              label={t('identity.consent')}
              description={t('identity.faceConsent')}
              checked={consent}
              testId="identity-face-consent"
              onChange={setConsent}
            />
          ) : null}
          <p className="muted small">{t('identity.faceHowTo')}</p>
          <div className="actions">
            {!on ? (
              <button
                type="button"
                className="button"
                data-testid="identity-face-camera"
                disabled={busy || camera.busy}
                onClick={() => {
                  void camera.start(null)
                }}
              >
                {t('camera.start')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-primary"
                  data-testid="identity-face-enroll"
                  disabled={busy || !consent || state !== 'ACTIVE'}
                  onClick={() => {
                    void withFrames(ENROLL_FRAMES, async (frames) => ({
                      kind: 'method',
                      value: await request('identity.face.enroll', { consent: true, frames })
                    }))
                  }}
                >
                  {t(method.enrolled ? 'identity.reenroll' : 'identity.enroll')}
                </button>
                {method.enrolled && method.enabled ? (
                  <button
                    type="button"
                    className="button button-primary"
                    data-testid="identity-face-verify"
                    disabled={busy || state !== 'ACTIVE'}
                    onClick={() => {
                      void withFrames(VERIFY_FRAMES, async (frames) => ({
                        kind: 'verification',
                        value: await request('identity.face.verify', { frames })
                      }))
                    }}
                  >
                    {t('identity.faceVerify')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button"
                  data-testid="identity-face-close"
                  disabled={busy}
                  onClick={() => {
                    void camera.close()
                  }}
                >
                  {t('camera.close')}
                </button>
              </>
            )}
          </div>
          {camera.waitingPermission ? (
            <p className="small" role="status">
              {t('vision.waitingPermission')}
            </p>
          ) : null}
          {capturing !== null ? (
            <p className="small" role="status" data-testid="identity-face-capturing">
              {t('identity.capturing', capturing)}
            </p>
          ) : null}
          {camera.error ? (
            <p className="small" role="alert" data-code={camera.error.code}>
              {camera.error.message}
            </p>
          ) : null}
          {on ? <CameraPreview /> : null}
        </>
      ) : null}
      <MethodControls method={method} protection={protection} busy={busy} run={run} />
    </section>
  )
}

type Recording = {
  readonly session: VoiceSession
  readonly phrase: number
  readonly recording: boolean
  readonly seconds: number
}

function VoiceCard({
  method,
  protection,
  busy,
  run
}: {
  readonly method: MethodStatus
  readonly protection: boolean
  readonly busy: boolean
  readonly run: Run
}) {
  const { t } = useI18n()
  const [consent, setConsent] = useState(false)
  const [recording, setRecording] = useState<Recording | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [problem, setProblem] = useState<ErrorEnvelope | null>(null)
  const capture = useRef<Capture | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())

  // Nothing is left recording when the page goes away.
  useEffect(
    () => () => {
      capture.current?.stop()
      capture.current = null
    },
    []
  )

  const begin = async (purpose: 'enroll' | 'verify') => {
    setProblem(null)
    try {
      const session = await withPermission(
        () =>
          request('identity.voice.start', { purpose, consent: purpose === 'enroll' && consent }),
        setWaiting
      )
      setRecording({ session, phrase: 0, recording: false, seconds: 0 })
    } catch (failure) {
      setProblem(envelopeOf(failure))
    }
  }

  const record = async (current: Recording) => {
    setProblem(null)
    queue.current = Promise.resolve()
    try {
      capture.current = await startCapture(null, {
        onChunk: (pcm) => {
          queue.current = queue.current.then(async () => {
            try {
              const { seconds } = await request('identity.voice.sample', {
                sessionId: current.session.sessionId,
                phrase: current.phrase,
                pcm
              })
              setRecording((previous) => (previous ? { ...previous, seconds } : previous))
            } catch (failure) {
              capture.current?.stop()
              capture.current = null
              setProblem(envelopeOf(failure))
            }
          })
        },
        onEnded: () => {
          capture.current = null
          setRecording((previous) => (previous ? { ...previous, recording: false } : previous))
        }
      })
      setRecording({ ...current, recording: true, seconds: 0 })
    } catch (failure) {
      setProblem(envelopeOf(failure))
    }
  }

  const stop = async (current: Recording) => {
    capture.current?.stop()
    capture.current = null
    await queue.current
    const next = current.phrase + 1
    if (next < current.session.phrases.length) {
      setRecording({ ...current, phrase: next, recording: false, seconds: 0 })
      return
    }
    setRecording(null)
    await run(async () => {
      const result = await request('identity.voice.finish', {
        sessionId: current.session.sessionId,
        outcome: 'done'
      })
      if (result.verification) return { kind: 'verification', value: result.verification }
      return result.method ? { kind: 'method', value: result.method } : null
    })
  }

  const cancel = async (current: Recording) => {
    capture.current?.stop()
    capture.current = null
    await queue.current
    setRecording(null)
    await request('identity.voice.finish', {
      sessionId: current.session.sessionId,
      outcome: 'cancelled'
    }).catch((failure: unknown) => {
      setProblem(envelopeOf(failure))
    })
  }

  return (
    <section className="card" aria-labelledby="identity-voice-title" data-testid="identity-voice">
      <MethodHeader method={method} />
      <p className="small">{t('identity.voiceLimit')}</p>
      {method.available ? (
        recording ? (
          <div data-testid="identity-voice-recording" data-phrase={recording.phrase}>
            <p>
              {t('identity.voicePhrase', {
                index: recording.phrase + 1,
                count: recording.session.phrases.length
              })}
            </p>
            <blockquote data-testid="identity-voice-text">
              {recording.session.phrases[recording.phrase] ?? ''}
            </blockquote>
            <p className="muted small" role="status">
              {recording.recording
                ? t('identity.voiceRecording', { seconds: recording.seconds.toFixed(1) })
                : t('identity.voiceReady')}
            </p>
            <div className="actions">
              {recording.recording ? (
                <button
                  type="button"
                  className="button button-primary"
                  data-testid="identity-voice-stop"
                  onClick={() => {
                    void stop(recording)
                  }}
                >
                  {t('identity.voiceStop')}
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  data-testid="identity-voice-record"
                  onClick={() => {
                    void record(recording)
                  }}
                >
                  {t('identity.voiceRecord')}
                </button>
              )}
              <button
                type="button"
                className="button"
                data-testid="identity-voice-cancel"
                onClick={() => {
                  void cancel(recording)
                }}
              >
                {t('identity.voiceCancel')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <Switch
              label={t('identity.consent')}
              description={t('identity.voiceConsent')}
              checked={consent}
              testId="identity-voice-consent"
              onChange={setConsent}
            />
            <div className="actions">
              <button
                type="button"
                className="button"
                data-testid="identity-voice-enroll"
                disabled={busy || !consent}
                onClick={() => {
                  void begin('enroll')
                }}
              >
                {t(method.enrolled ? 'identity.reenroll' : 'identity.enroll')}
              </button>
              {method.enrolled && method.enabled ? (
                <button
                  type="button"
                  className="button"
                  data-testid="identity-voice-verify"
                  disabled={busy}
                  onClick={() => {
                    void begin('verify')
                  }}
                >
                  {t('identity.voiceVerify')}
                </button>
              ) : null}
            </div>
          </>
        )
      ) : null}
      {waiting ? (
        <p className="small" role="status">
          {t('vision.waitingPermission')}
        </p>
      ) : null}
      {problem ? (
        <p
          className="small"
          role="alert"
          data-testid="identity-voice-error"
          data-code={problem.code}
        >
          {problem.message} {problem.userAction ?? ''}
        </p>
      ) : null}
      <MethodControls method={method} protection={protection} busy={busy} run={run} />
    </section>
  )
}
