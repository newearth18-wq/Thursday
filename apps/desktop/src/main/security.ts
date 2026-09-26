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

export function hardenSession(session: Session, logger: Logger): void {
  const log = logger.child({ component: 'security' })
  // Deny by default: web pages never get Chromium permissions (camera, microphone, …).
  // Jupiter's own capabilities are decided by the Permission Engine in Core (SET 7).
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn('security.permission.denied', `Denied a "${permission}" permission request`, {
      permission
    })
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
  session.on('will-download', (event) => {
    event.preventDefault()
    log.warn(
      'security.download.blocked',
      'Blocked a download: downloads are not part of this build'
    )
  })
}
