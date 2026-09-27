import { app, type Session } from 'electron'
import type { Logger } from '@jupiter/core'

/**
 * Process-wide Electron hardening. Applied to every WebContents, including
 * any created later, so no future window can opt out by accident.
 */

/** Log only where a blocked URL pointed, never its query string or fragment. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return url.protocol === 'file:' ? 'file:' : `${url.origin}${url.pathname}`
  } catch {
    return '(unparseable URL)'
  }
}

export function hardenWebContents(logger: Logger, isAppUrl: (url: string) => boolean): void {
  const log = logger.child({ component: 'security' })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
      log.warn('security.webview.blocked', 'Blocked an attempt to attach a <webview>')
    })
    contents.setWindowOpenHandler(({ url }) => {
      log.warn('security.window-open.blocked', 'Blocked an attempt to open a new window', {
        target: describeUrl(url)
      })
      return { action: 'deny' }
    })
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (isAppUrl(url)) return
      event.preventDefault()
      log.warn(
        'security.navigation.blocked',
        'Blocked navigation away from the Jupiter interface',
        { target: describeUrl(url) }
      )
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
  })
}

/** Answers the host's microphone questions (SET 12); see `MicrophoneGate`. */
export interface MicrophonePolicy {
  /** A new capture may start (a listening session the person started is open). */
  mayCapture(): boolean
  /** Devices may be named or used (a session, or a short device-naming window, is open). */
  isOpen(): boolean
}

export function hardenSession(
  session: Session,
  logger: Logger,
  microphone: MicrophonePolicy,
  isAppUrl: (url: string) => boolean,
  camera: MicrophonePolicy
): void {
  const log = logger.child({ component: 'security' })
  const only = (kind: 'audio' | 'video', mediaTypes: readonly string[] | undefined) =>
    mediaTypes !== undefined && mediaTypes.length > 0 && mediaTypes.every((type) => type === kind)
  // Deny by default: web pages never get Chromium permissions (camera, microphone, …).
  // Jupiter's own capabilities are decided by the Permission Engine in Core (SET 7). The one
  // exception is the microphone for Jupiter's own interface, and only while Core has opened the
  // gate for a listening session the person started and allowed (SET 12), and the camera, only
  // while Core has opened the camera gate for a session the person started and allowed (SET 13).
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    if (
      permission === 'media' &&
      isAppUrl(details.requestingUrl) &&
      only('audio', mediaTypes) &&
      microphone.mayCapture()
    ) {
      log.info('security.microphone.allowed', 'Allowed the microphone for a listening session')
      callback(true)
      return
    }
    if (
      permission === 'media' &&
      isAppUrl(details.requestingUrl) &&
      only('video', mediaTypes) &&
      camera.mayCapture()
    ) {
      log.info('security.camera.allowed', 'Allowed the camera for a camera session')
      callback(true)
      return
    }
    log.warn('security.permission.denied', `Denied a "${permission}" permission request`, {
      permission
    })
    callback(false)
  })
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const fromApp = isAppUrl(requestingOrigin) || isAppUrl(details.requestingUrl ?? '')
    if (!fromApp) return false
    // Choosing where Jupiter's own speech plays needs no microphone.
    if ((permission as string) === 'speaker-selection') return true
    if (permission !== 'media') return false
    return details.mediaType === 'video' ? camera.isOpen() : microphone.isOpen()
  })
  session.on('will-download', (event) => {
    event.preventDefault()
    log.warn(
      'security.download.blocked',
      'Blocked a download: downloads are not part of this build'
    )
  })
}
