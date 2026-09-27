import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DomainEvent,
  EventFilter,
  ImageRef,
  Observation,
  PixelBox,
  VisionEngineInfo,
  VisionStatus,
  VisionTask,
  VisualComparison
} from '@jupiter/contracts'
import { request } from '../api'
import { Select, Switch } from '../components/FormControls'
import { useI18n, type MessageKey } from '../i18n'
import { keyOf, useBump, useQuery } from '../useAi'
import { withPermission } from '../useFiles'
import { useLiveEvents } from '../useLiveEvents'
import { coreSessionOf, envelopeOf, useRuntimeContext } from '../useRuntime'
import { useCamera } from '../vision/CameraProvider'
import { cameraDevices } from '../vision/camera'
import { drawPng, pngOfFile, sendImage } from '../vision/images'
import { LoadFailure } from './LoadFailure'

/**
 * Vision and the camera on the Devices screen (SET 13): each engine and
 * where it runs, captures of the screen, the active window or a region, an
 * image the person chooses, what Vision found (with its confidence and how
 * privacy was handled), before/after comparison, and the camera with its
 * preview. Images are held in Jupiter Core's memory only, never saved.
 */

const VISION_EVENTS: EventFilter = {
  // Model changes in AI Models change which vision model can be used, and where it runs.
  types: [
    'vision.observed',
    'camera.state_changed',
    'camera.session',
    'settings.changed',
    'ai.provider.changed'
  ],
  streams: null,
  missionId: null
}

const TASKS: readonly VisionTask[] = ['text', 'qr', 'describe', 'elements', 'faces']

function useVisionStatus() {
  const { status: runtime } = useRuntimeContext()
  const coreSession = coreSessionOf(runtime)
  const [version, bump] = useBump(50)
  const onEvent = useCallback(
    (_event: DomainEvent) => {
      bump()
    },
    [bump]
  )
  const { opened } = useLiveEvents(VISION_EVENTS, onEvent, coreSession)
  const load = useCallback(async () => request('vision.status', {}), [])
  const [status] = useQuery(keyOf(coreSession, 'vision-status', opened, version), load)
  return { status, reload: bump }
}

function EngineBadge({ engine }: { readonly engine: VisionEngineInfo }) {
  const { t } = useI18n()
  if (engine.kind === 'faces')
    return (
      <span className="badge badge-muted" data-availability="COMING_LATER">
        {t('availability.COMING_LATER')}
      </span>
    )
  if (!engine.available || !engine.locality)
    return (
      <span className="badge badge-warning" data-availability="UNAVAILABLE">
        {t(
          engine.reason?.startsWith('Not configured')
            ? 'availability.NOT_CONFIGURED'
            : 'availability.UNAVAILABLE'
        )}
      </span>
    )
  return (
    <span
      className={`badge ${engine.locality === 'cloud' ? 'badge-warning' : 'badge-success'}`}
      data-testid={`vision-locality-${engine.kind}`}
      data-locality={engine.locality}
    >
      {t(engine.locality === 'cloud' ? 'voice.locality.cloud' : 'voice.locality.local')}
    </span>
  )
}

function EnginesCard({ status }: { readonly status: VisionStatus }) {
  const { t } = useI18n()
  const [problem, setProblem] = useState<string | null>(null)
  const engines = [
    status.engines.capture,
    status.engines.ocr,
    status.engines.qr,
    status.engines.model,
    status.engines.camera,
    status.engines.faces
  ]
  return (
    <section className="card" aria-labelledby="vision-engines-title" data-testid="vision-engines">
      <h2 id="vision-engines-title">{t('vision.engines')}</h2>
      <p className="muted small">{t('vision.enginesHint')}</p>
      <ul className="plain-list voice-engines">
        {engines.map((engine) => (
          <li
            key={engine.kind}
            data-testid={`vision-engine-${engine.kind}`}
            data-available={engine.available}
          >
            <strong>{t(`vision.engine.${engine.kind}` as MessageKey)}</strong>{' '}
            <EngineBadge engine={engine} />{' '}
            <span className="muted small">
              {engine.available ? (engine.name ?? '') : (engine.reason ?? '')}
            </span>
          </li>
        ))}
      </ul>
      <Switch
        label={t('vision.redactSecrets')}
        description={t('vision.redactSecretsHint')}
        checked={status.redactSecrets}
        testId="vision-redact-secrets"
        onChange={(next) => {
          setProblem(null)
          request('settings.update', { key: 'vision.redactSecrets', value: next }).catch(
            (error: unknown) => {
              setProblem(envelopeOf(error).message)
            }
          )
        }}
      />
      {problem ? (
        <p className="small" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  )
}

/** An image held in memory, drawn on a canvas (no image URL is ever needed). */
export function ImagePreview({
  image,
  testId = 'vision-preview'
}: {
  readonly image: ImageRef
  readonly testId?: string
}) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'shown' | 'gone'>('loading')
  useEffect(() => {
    const life = { cancelled: false }
    // Read through a function: the flag changes while the image loads.
    const cancelled = () => life.cancelled
    request('vision.image', { imageId: image.imageId })
      .then(async (content) => {
        if (cancelled() || !canvas.current) return
        await drawPng(canvas.current, content.data)
        if (!cancelled()) setState('shown')
      })
      .catch(() => {
        if (!cancelled()) setState('gone')
      })
    return () => {
      life.cancelled = true
    }
  }, [image.imageId])
  return (
    <figure className="vision-preview" data-testid={testId} data-state={state}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={t('vision.previewLabel', {
          source: t(`vision.source.${image.source}` as MessageKey),
          width: image.width,
          height: image.height
        })}
      />
      {state === 'gone' ? (
        <figcaption className="muted small">{t('vision.imageGone')}</figcaption>
      ) : null}
    </figure>
  )
}

function CaptureCard({ onImage }: { readonly onImage: (image: ImageRef) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [delay, setDelay] = useState<'0' | '3' | '5'>('3')
  const [region, setRegion] = useState({ x: '0', y: '0', width: '800', height: '600' })
  const file = useRef<HTMLInputElement>(null)

  const run = async (make: () => Promise<ImageRef>) => {
    setProblem(null)
    setBusy(true)
    try {
      onImage(await withPermission(make, setWaiting))
    } catch (error) {
      setProblem(envelopeOf(error).message)
    } finally {
      setBusy(false)
    }
  }
  const box = (): PixelBox => ({
    x: Math.max(0, Math.round(Number(region.x) || 0)),
    y: Math.max(0, Math.round(Number(region.y) || 0)),
    width: Math.max(1, Math.round(Number(region.width) || 1)),
    height: Math.max(1, Math.round(Number(region.height) || 1))
  })
  return (
    <section className="card" aria-labelledby="vision-capture-title" data-testid="vision-capture">
      <h2 id="vision-capture-title">{t('vision.capture')}</h2>
      <p className="muted small">{t('vision.captureHint')}</p>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="vision-capture-desktop"
          disabled={busy}
          onClick={() => {
            void run(() =>
              request('vision.capture', { source: 'desktop', region: null, delaySeconds: 0 })
            )
          }}
        >
          {t('vision.captureDesktop')}
        </button>
        <button
          type="button"
          className="button"
          data-testid="vision-capture-window"
          disabled={busy}
          onClick={() => {
            void run(() =>
              request('vision.capture', {
                source: 'active-window',
                region: null,
                delaySeconds: Number(delay)
              })
            )
          }}
        >
          {t('vision.captureWindow', { seconds: delay })}
        </button>
      </div>
      <Select<'0' | '3' | '5'>
        label={t('vision.delay')}
        value={delay}
        testId="vision-delay"
        onChange={setDelay}
        choices={(['0', '3', '5'] as const).map((value) => ({
          value,
          label: t('vision.delaySeconds', { seconds: value })
        }))}
      />
      <fieldset className="vision-region" data-testid="vision-region">
        <legend>{t('vision.region')}</legend>
        {(['x', 'y', 'width', 'height'] as const).map((field) => (
          <label key={field} className="field">
            <span>{t(`vision.region.${field}` as MessageKey)}</span>
            <input
              className="input"
              inputMode="numeric"
              value={region[field]}
              data-testid={`vision-region-${field}`}
              onChange={(event) => {
                setRegion((previous) => ({ ...previous, [field]: event.target.value }))
              }}
            />
          </label>
        ))}
        <button
          type="button"
          className="button"
          data-testid="vision-capture-region"
          disabled={busy}
          onClick={() => {
            void run(() =>
              request('vision.capture', { source: 'region', region: box(), delaySeconds: 0 })
            )
          }}
        >
          {t('vision.captureRegion')}
        </button>
      </fieldset>
      <div className="field">
        <label htmlFor="vision-upload">{t('vision.upload')}</label>
        <p className="muted small">{t('vision.uploadHint')}</p>
        <input
          id="vision-upload"
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          data-testid="vision-upload"
          disabled={busy}
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            if (!chosen) return
            void run(async () => sendImage(await pngOfFile(chosen), 'upload', null)).finally(() => {
              if (file.current) file.current.value = ''
            })
          }}
        />
      </div>
      {waiting ? (
        <p className="small" role="status">
          {t('vision.waitingPermission')}
        </p>
      ) : null}
      {busy && !waiting ? (
        <p className="small" role="status" data-testid="vision-capturing">
          {t('vision.working')}
        </p>
      ) : null}
      {problem ? (
        <p className="small" role="alert" data-testid="vision-capture-error">
          {problem}
        </p>
      ) : null}
    </section>
  )
}

function ObservationView({ observation }: { readonly observation: Observation }) {
  const { t, locale } = useI18n()
  const percent = (value: number | null) =>
    value === null ? '—' : new Intl.NumberFormat(locale, { style: 'percent' }).format(value)
  return (
    <div className="vision-observation" data-testid="vision-observation">
      <p>
        <span className="badge badge-muted" data-testid="vision-untrusted">
          {t('vision.untrusted')}
        </span>{' '}
        <span data-testid="vision-confidence" data-confidence={observation.confidence ?? ''}>
          {t('vision.confidence', { value: percent(observation.confidence) })}
        </span>
      </p>
      <ul className="plain-list" data-testid="vision-tasks">
        {observation.tasks.map((task) => (
          <li key={task.task} data-testid={`vision-task-${task.task}`} data-status={task.status}>
            <strong>{t(`vision.task.${task.task}` as MessageKey)}</strong>{' '}
            <span
              className={`badge badge-${
                task.status === 'done' ? 'success' : task.status === 'failed' ? 'error' : 'muted'
              }`}
            >
              {t(`vision.taskStatus.${task.status}` as MessageKey)}
            </span>{' '}
            {task.reason ? <span className="muted small">{task.reason}</span> : null}
          </li>
        ))}
      </ul>
      {observation.detectedText ? (
        <>
          <h3>{t('vision.text')}</h3>
          <p className="muted small">
            {t('vision.textBy', {
              engine: observation.detectedText.engine,
              confidence: percent(observation.detectedText.confidence)
            })}
          </p>
          {observation.detectedText.lines.length === 0 ? (
            <p className="muted">{t('vision.noText')}</p>
          ) : (
            <ol className="vision-lines" data-testid="vision-text-lines">
              {observation.detectedText.lines.map((line, index) => (
                <li key={index} data-confidence={line.confidence}>
                  <span>{line.text}</span>{' '}
                  <span className="muted small">{percent(line.confidence)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
      {observation.qrCodes.length > 0 ? (
        <>
          <h3>{t('vision.qr')}</h3>
          <ul className="plain-list" data-testid="vision-qr-codes">
            {observation.qrCodes.map((code, index) => (
              <li key={index}>
                <code>{code.value}</code> <span className="muted small">{code.kind}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {observation.analysis ? (
        <>
          <h3>{t('vision.analysis')}</h3>
          <p className="muted small">
            {t('vision.analysisBy', {
              engine: observation.analysis.engine,
              where: t(
                observation.analysis.locality === 'cloud'
                  ? 'voice.locality.cloud'
                  : 'voice.locality.local'
              ),
              confidence: percent(observation.analysis.confidence)
            })}
          </p>
          <p data-testid="vision-summary">{observation.analysis.summary}</p>
          {observation.analysis.answer ? (
            <p data-testid="vision-answer">
              <strong>{t('vision.answer')}</strong> {observation.analysis.answer}
            </p>
          ) : null}
        </>
      ) : null}
      {observation.detectedElements.length > 0 ? (
        <>
          <h3>{t('vision.elements')}</h3>
          <ul className="plain-list" data-testid="vision-elements">
            {observation.detectedElements.map((element, index) => (
              <li key={index}>
                <strong>{t(`vision.kind.${element.kind}` as MessageKey)}</strong> {element.label}{' '}
                <span className="muted small">{percent(element.confidence)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>{t('vision.privacy')}</h3>
      <ul className="plain-list small" data-testid="vision-privacy">
        <li>
          {t('vision.privacyStored', {
            time: new Date(observation.privacyHandling.expiresAt).toLocaleTimeString(locale)
          })}
        </li>
        <li
          data-testid="vision-redactions"
          data-count={observation.privacyHandling.redactedRegions.length}
        >
          {t('vision.privacyRedacted', {
            count: observation.privacyHandling.redactedRegions.length
          })}
        </li>
        {observation.privacyHandling.sentTo.length === 0 ? (
          <li>{t('vision.privacyNothingSent')}</li>
        ) : (
          observation.privacyHandling.sentTo.map((engine, index) => (
            <li key={index} data-testid="vision-sent-to" data-locality={engine.locality}>
              {t('vision.privacySentTo', {
                engine: engine.engine,
                where: t(
                  engine.locality === 'cloud' ? 'voice.locality.cloud' : 'voice.locality.local'
                )
              })}
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

export function AnalyzeCard({
  image,
  status,
  testId = 'vision-analyze',
  onDiscard
}: {
  readonly image: ImageRef
  readonly status: VisionStatus
  readonly testId?: string
  readonly onDiscard?: () => void
}) {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<VisionTask[]>(['text', 'qr'])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [observation, setObservation] = useState<Observation | null>(null)
  const modelLocality = status.engines.model.available ? status.engines.model.locality : null
  return (
    <section
      className="card"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      data-image-id={image.imageId}
    >
      <h2 id={`${testId}-title`}>{t('vision.analyze')}</h2>
      <ImagePreview image={image} />
      <fieldset className="vision-tasks">
        <legend>{t('vision.tasks')}</legend>
        {TASKS.map((task) => {
          const later = task === 'faces'
          return (
            <label key={task} className="field-inline">
              <input
                type="checkbox"
                checked={tasks.includes(task)}
                disabled={later}
                data-testid={`vision-want-${task}`}
                onChange={(event) => {
                  setTasks((previous) =>
                    event.target.checked
                      ? [...previous, task]
                      : previous.filter((item) => item !== task)
                  )
                }}
              />{' '}
              {t(`vision.task.${task}` as MessageKey)}
              {later ? (
                <span className="badge badge-muted" data-availability="COMING_LATER">
                  {t('availability.COMING_LATER')}
                </span>
              ) : null}
            </label>
          )
        })}
      </fieldset>
      <div className="field">
        <label htmlFor={`${testId}-question`}>{t('vision.question')}</label>
        <input
          id={`${testId}-question`}
          className="input"
          value={question}
          maxLength={1000}
          data-testid="vision-question"
          onChange={(event) => {
            setQuestion(event.target.value)
          }}
        />
      </div>
      {tasks.includes('describe') || tasks.includes('elements') || question.trim() ? (
        <p className="muted small" data-testid="vision-model-note">
          {modelLocality === null
            ? t('vision.noModel', { reason: status.engines.model.reason ?? '' })
            : t(modelLocality === 'cloud' ? 'vision.modelCloud' : 'vision.modelLocal', {
                engine: status.engines.model.name ?? ''
              })}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="vision-analyze-run"
          disabled={busy || (tasks.length === 0 && !question.trim())}
          onClick={() => {
            setProblem(null)
            setBusy(true)
            request('vision.analyze', {
              imageId: image.imageId,
              tasks: tasks.length ? tasks : ['describe'],
              question: question.trim() || null,
              redact: []
            })
              .then(setObservation)
              .catch((error: unknown) => {
                setProblem(envelopeOf(error).message)
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          {t('vision.analyzeRun')}
        </button>
        <button
          type="button"
          className="button"
          data-testid="vision-discard"
          onClick={() => {
            void request('vision.image.discard', { imageId: image.imageId })
              .catch(() => undefined)
              .finally(() => {
                onDiscard?.()
              })
          }}
        >
          {t('vision.discard')}
        </button>
      </div>
      {busy ? (
        <p className="small" role="status">
          {t('vision.working')}
        </p>
      ) : null}
      {problem ? (
        <p className="small" role="alert" data-testid="vision-analyze-error">
          {problem}
        </p>
      ) : null}
      {observation ? <ObservationView observation={observation} /> : null}
    </section>
  )
}

function CompareCard({ images }: { readonly images: readonly ImageRef[] }) {
  const { t, locale } = useI18n()
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState<VisualComparison | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const choices = [
    { value: '', label: t('vision.choose') },
    ...images.map((image) => ({
      value: image.imageId,
      label: `${t(`vision.source.${image.source}` as MessageKey)} · ${new Date(image.capturedAt).toLocaleTimeString(locale)}`
    }))
  ]
  return (
    <section className="card" aria-labelledby="vision-compare-title" data-testid="vision-compare">
      <h2 id="vision-compare-title">{t('vision.compare')}</h2>
      <p className="muted small">{t('vision.compareHint')}</p>
      <Select<string>
        label={t('vision.before')}
        value={before}
        choices={choices}
        onChange={setBefore}
        testId="vision-compare-before"
      />
      <Select<string>
        label={t('vision.after')}
        value={after}
        choices={choices}
        onChange={setAfter}
        testId="vision-compare-after"
      />
      <div className="field">
        <label htmlFor="vision-compare-text">{t('vision.expectText')}</label>
        <input
          id="vision-compare-text"
          className="input"
          value={text}
          data-testid="vision-compare-text"
          onChange={(event) => {
            setText(event.target.value)
          }}
        />
      </div>
      <button
        type="button"
        className="button"
        data-testid="vision-compare-run"
        disabled={!before || !after}
        onClick={() => {
          setProblem(null)
          request('vision.compare', {
            beforeId: before,
            afterId: after,
            expectText: text.trim() || null
          })
            .then(setResult)
            .catch((error: unknown) => {
              setProblem(envelopeOf(error).message)
            })
        }}
      >
        {t('vision.compareRun')}
      </button>
      {problem ? (
        <p className="small" role="alert">
          {problem}
        </p>
      ) : null}
      {result ? (
        <p data-testid="vision-compare-result" data-verified={result.verified}>
          <span className={`badge badge-${result.verified ? 'success' : 'warning'}`}>
            {t(result.verified ? 'vision.verified' : 'vision.notVerified')}
          </span>{' '}
          {result.reason}
        </p>
      ) : null}
    </section>
  )
}

export function VisionPanel() {
  const { t, locale } = useI18n()
  const { status, reload } = useVisionStatus()
  const [selected, setSelected] = useState<string | null>(null)
  if (status.state === 'error')
    return <LoadFailure title={t('vision.statusFailed')} error={status.error} />
  if (status.state !== 'ready') return <p className="muted">{t('load.loading')}</p>
  const images = status.value.images
  const image = images.find((item) => item.imageId === selected) ?? images.at(-1) ?? null
  return (
    <div className="vision-panel" data-testid="vision-panel">
      <EnginesCard status={status.value} />
      <CaptureCard
        onImage={(next) => {
          setSelected(next.imageId)
          reload()
        }}
      />
      <section className="card" aria-labelledby="vision-images-title" data-testid="vision-images">
        <h2 id="vision-images-title">{t('vision.images')}</h2>
        <p className="muted small">{t('vision.imagesHint')}</p>
        {images.length === 0 ? (
          <p className="muted" data-testid="vision-images-empty">
            {t('vision.noImages')}
          </p>
        ) : (
          <ul className="plain-list">
            {images.map((item) => (
              <li
                key={item.imageId}
                data-testid="vision-image"
                data-source={item.source}
                data-image-id={item.imageId}
              >
                <button
                  type="button"
                  className="link-button"
                  aria-pressed={item.imageId === image?.imageId}
                  onClick={() => {
                    setSelected(item.imageId)
                  }}
                >
                  {t(`vision.source.${item.source}` as MessageKey)}
                </button>{' '}
                <span className="muted small">
                  {t('vision.imageFacts', {
                    width: item.width,
                    height: item.height,
                    window: item.window?.title ?? '—',
                    until: new Date(item.expiresAt).toLocaleTimeString(locale)
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {image ? (
        <AnalyzeCard key={image.imageId} image={image} status={status.value} onDiscard={reload} />
      ) : null}
      {images.length >= 2 ? <CompareCard images={images} /> : null}
    </div>
  )
}

/** A live preview of the camera, drawn from the real track while it runs. */
function CameraPreview() {
  const { t } = useI18n()
  const camera = useCamera()
  const canvas = useRef<HTMLCanvasElement>(null)
  const handle = camera.handle
  const running = camera.status.state === 'ready' && camera.status.value.state === 'ACTIVE'
  useEffect(() => {
    if (!handle || !running) return
    const loop: { stopped: boolean; timer: ReturnType<typeof setTimeout> | null } = {
      stopped: false,
      timer: null
    }
    // Read through a function: the flag changes while a frame is being grabbed.
    const stopped = () => loop.stopped
    const draw = async () => {
      if (stopped() || handle.paused) return
      try {
        const bitmap = await handle.grab()
        const target = canvas.current
        if (target && !stopped()) {
          target.width = bitmap.width
          target.height = bitmap.height
          target.getContext('2d')?.drawImage(bitmap, 0, 0)
        }
        bitmap.close()
      } catch {
        // A frame that could not be grabbed is simply not drawn.
      }
      if (!stopped()) loop.timer = setTimeout(() => void draw(), 100)
    }
    void draw()
    return () => {
      loop.stopped = true
      if (loop.timer) clearTimeout(loop.timer)
    }
  }, [handle, running])
  return (
    <canvas
      ref={canvas}
      className="camera-preview"
      data-testid="camera-preview"
      role="img"
      aria-label={t('camera.previewLabel')}
    />
  )
}

export function CameraPanel() {
  const { t } = useI18n()
  const camera = useCamera()
  const { status: vision } = useVisionStatus()
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([])
  const [device, setDevice] = useState('')
  const [frame, setFrame] = useState<ImageRef | null>(null)
  const state = camera.status.state === 'ready' ? camera.status.value.state : null
  const on = state === 'ACTIVE' || state === 'PAUSED' || state === 'STARTING'
  useEffect(() => {
    if (!camera.live) return
    void cameraDevices()
      .then(setDevices)
      .catch(() => undefined)
  }, [camera.live])
  return (
    <div className="vision-panel" data-testid="camera-panel">
      <section className="card" aria-labelledby="camera-title" data-testid="devices-camera">
        <h2 id="camera-title">{t('devices.camera')}</h2>
        <p>
          <span
            className={`badge badge-${state === 'ACTIVE' ? 'success' : state === 'ERROR' ? 'error' : 'muted'}`}
            data-testid="camera-state"
            data-state={state ?? ''}
            role="status"
          >
            {state ? t(`camera.state.${state}` as MessageKey) : t('load.loading')}
          </span>
        </p>
        <p className="muted small">{t('camera.hint')}</p>
        {devices.length > 0 ? (
          <Select<string>
            label={t('camera.device')}
            value={device}
            testId="camera-device"
            onChange={setDevice}
            choices={[
              { value: '', label: t('voice.device.default') },
              ...devices.map((item, index) => ({
                value: item.deviceId,
                label: item.label || t('camera.deviceUnnamed', { index: index + 1 })
              }))
            ]}
          />
        ) : null}
        <div className="actions">
          {!on ? (
            <button
              type="button"
              className="button button-primary"
              data-testid="camera-start"
              disabled={camera.busy}
              onClick={() => {
                void camera.start(device || null)
              }}
            >
              {t('camera.start')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button button-primary"
                data-testid="camera-capture"
                disabled={state !== 'ACTIVE'}
                onClick={() => {
                  void camera.capture().then((image) => {
                    if (image) setFrame(image)
                  })
                }}
              >
                {t('camera.capture')}
              </button>
              <button
                type="button"
                className="button"
                data-testid={state === 'PAUSED' ? 'camera-resume' : 'camera-pause'}
                disabled={state === 'STARTING'}
                onClick={() => {
                  void (state === 'PAUSED' ? camera.resume() : camera.pause())
                }}
              >
                {t(state === 'PAUSED' ? 'camera.resume' : 'camera.pause')}
              </button>
              <button
                type="button"
                className="button button-danger"
                data-testid="camera-close"
                onClick={() => {
                  void camera.close()
                }}
              >
                {t('camera.close')}
              </button>
            </>
          )}
          {state === 'ERROR' ? (
            <button
              type="button"
              className="button"
              data-testid="camera-dismiss"
              onClick={() => {
                void camera.close()
              }}
            >
              {t('camera.dismiss')}
            </button>
          ) : null}
        </div>
        {camera.waitingPermission ? (
          <p className="small" role="status">
            {t('vision.waitingPermission')}
          </p>
        ) : null}
        {camera.error ? (
          <p
            className="small"
            role="alert"
            data-testid="camera-error"
            data-code={camera.error.code}
          >
            {camera.error.message}
          </p>
        ) : null}
        {camera.status.state === 'ready' && camera.status.value.lastError && state === 'ERROR' ? (
          <p
            className="small"
            role="alert"
            data-testid="camera-last-error"
            data-code={camera.status.value.lastError.code}
          >
            {camera.status.value.lastError.message} {camera.status.value.lastError.userAction ?? ''}
          </p>
        ) : null}
        {on ? <CameraPreview /> : null}
      </section>
      {frame && on && vision.state === 'ready' ? (
        <AnalyzeCard
          key={frame.imageId}
          image={frame}
          status={vision.value}
          testId="camera-analyze"
        />
      ) : null}
    </div>
  )
}
