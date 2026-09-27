import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  CameraStatus,
  DomainEvent,
  ErrorEnvelope,
  EventFilter,
  ImageRef
} from '@jupiter/contracts'
import { request } from '../api'
import { keyOf, useBump, useQuery } from '../useAi'
import { withPermission } from '../useFiles'
import { useLiveEvents } from '../useLiveEvents'
import { envelopeOf, type Loadable } from '../useRuntime'
import { cameraActive, onCameraActivity, startCamera, type CameraHandle } from './camera'
import { sendImage } from './images'

/**
 * The camera controller (SET 13), once for the whole interface, so the
 * camera — and its indicator — are right whatever screen is open. Core owns
 * the camera's state; this reports what the real track does and releases
 * the camera whenever Core ends the session (closed, timed out, Core
 * stopping).
 */

const CAMERA_EVENTS: EventFilter = {
  types: ['camera.state_changed', 'camera.session'],
  streams: null,
  missionId: null
}

export interface CameraData {
  readonly status: Loadable<CameraStatus>
  /** A camera track is live right now. */
  readonly live: boolean
  readonly handle: CameraHandle | null
  readonly busy: boolean
  readonly waitingPermission: boolean
  readonly error: ErrorEnvelope | null
  start(deviceId: string | null): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  capture(): Promise<ImageRef | null>
  close(): Promise<void>
}

const CameraContext = createContext<CameraData | null>(null)

export function useCamera(): CameraData {
  const value = useContext(CameraContext)
  if (!value) throw new Error('useCamera outside CameraProvider')
  return value
}

export function CameraProvider({
  coreSession,
  children
}: {
  readonly coreSession: string | null
  readonly children: ReactNode
}) {
  const [version, bump] = useBump(50)
  const session = useRef<{ sessionId: string; handle: CameraHandle | null } | null>(null)
  /** The last session, so an error it ended with can be cleared once the person has seen it. */
  const lastSessionId = useRef<string | null>(null)
  const [handle, setHandle] = useState<CameraHandle | null>(null)
  const [live, setLive] = useState(cameraActive())
  const [busy, setBusy] = useState(false)
  const [waitingPermission, setWaitingPermission] = useState(false)
  const [error, setError] = useState<ErrorEnvelope | null>(null)

  useEffect(() => onCameraActivity(setLive), [])

  const release = useCallback(() => {
    const current = session.current
    session.current = null
    current?.handle?.stop()
    setHandle(null)
    return current
  }, [])

  const handleEvent = useCallback(
    (event: DomainEvent) => {
      bump()
      // Core ended the session (closed, timed out, stopping): the camera is released here too.
      if (
        event.type === 'camera.session' &&
        event.payload.change === 'ended' &&
        session.current?.sessionId === event.payload.sessionId
      )
        release()
    },
    [bump, release]
  )
  const { opened } = useLiveEvents(CAMERA_EVENTS, handleEvent, coreSession)
  const load = useCallback(async () => request('camera.status', {}), [])
  const [status] = useQuery(keyOf(coreSession, 'camera', opened, version), load)

  const start = useCallback(
    async (deviceId: string | null) => {
      setError(null)
      setBusy(true)
      try {
        const started = await withPermission(
          () => request('camera.start', { deviceId }),
          setWaitingPermission
        )
        const entry = { sessionId: started.sessionId, handle: null as CameraHandle | null }
        session.current = entry
        lastSessionId.current = started.sessionId
        try {
          const camera = await startCamera(deviceId, (reason, detail) => {
            if (session.current === entry) release()
            void request('camera.report', {
              sessionId: entry.sessionId,
              event: reason,
              device: null,
              detail
            })
          })
          entry.handle = camera
          setHandle(camera)
          await request('camera.report', {
            sessionId: entry.sessionId,
            event: 'started',
            device: camera.label.slice(0, 200) || null,
            detail: null
          })
        } catch (failure) {
          if (session.current === entry) release()
          const name = failure instanceof Error ? `${failure.name}: ${failure.message}` : null
          await request('camera.report', {
            sessionId: entry.sessionId,
            event: 'failed',
            device: null,
            detail: name ? name.slice(0, 300) : null
          })
        }
      } catch (failure) {
        setError(envelopeOf(failure))
      } finally {
        setBusy(false)
        bump()
      }
    },
    [bump, release]
  )

  const report = useCallback(
    async (event: 'paused' | 'resumed') => {
      const current = session.current
      if (!current?.handle) return
      if (event === 'paused') current.handle.pause()
      else current.handle.resume()
      try {
        await request('camera.report', {
          sessionId: current.sessionId,
          event,
          device: null,
          detail: null
        })
      } catch (failure) {
        setError(envelopeOf(failure))
      }
      bump()
    },
    [bump]
  )

  const capture = useCallback(async (): Promise<ImageRef | null> => {
    const current = session.current
    if (!current?.handle) return null
    setError(null)
    try {
      const png = await current.handle.capture()
      const image = await sendImage(png, 'camera', current.sessionId)
      bump()
      return image
    } catch (failure) {
      setError(envelopeOf(failure))
      return null
    }
  }, [bump])

  const close = useCallback(async () => {
    const current = release()
    if (!current) {
      // Nothing is on: this only clears an error the person has now seen.
      if (lastSessionId.current)
        await request('camera.stop', { sessionId: lastSessionId.current, reason: 'closed' }).catch(
          (failure: unknown) => {
            setError(envelopeOf(failure))
          }
        )
      bump()
      return
    }
    try {
      await request('camera.stop', { sessionId: current.sessionId, reason: 'closed' })
    } catch (failure) {
      setError(envelopeOf(failure))
    }
    bump()
  }, [bump, release])

  // Nothing is left on when the interface goes away.
  useEffect(
    () => () => {
      session.current?.handle?.stop()
    },
    []
  )

  const value = useMemo<CameraData>(
    () => ({
      status,
      live,
      handle,
      busy,
      waitingPermission,
      error,
      start,
      pause: () => report('paused'),
      resume: () => report('resumed'),
      capture,
      close
    }),
    [status, live, handle, busy, waitingPermission, error, start, report, capture, close]
  )
  return <CameraContext.Provider value={value}>{children}</CameraContext.Provider>
}
