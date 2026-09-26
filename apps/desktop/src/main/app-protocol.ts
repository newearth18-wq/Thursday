import { lstat, readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { protocol, type Session } from 'electron'
import type { Logger } from '@jupiter/core'

/**
 * The interface is served from `jupiter://app/…` instead of `file://`.
 *
 * A `file://` page has an opaque origin and can reference any local file; a
 * privileged custom scheme has a real origin that sender validation and the
 * CSP can name, and this handler serves only the files of the built renderer
 * — nothing outside that folder, no symlinks, GET only — with the CSP sent as
 * a response header.
 */

export const APP_SCHEME = 'jupiter'
export const APP_HOST = 'app'
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** Must run before the `ready` event. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

export function isAppProtocolUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST
  } catch {
    return false
  }
}

/**
 * Map a `jupiter://app/...` URL to a file inside `rootDirectory`, or null if it
 * points anywhere else (other hosts, traversal, encoded traversal, NUL bytes).
 */
export function resolveAppFile(rootDirectory: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null
  if (pathname === '/' || pathname === '') pathname = '/index.html'
  const root = resolve(rootDirectory)
  const file = resolve(root, `.${pathname}`)
  const inside = relative(root, file)
  if (
    inside === '' ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    inside.split(sep).includes('..')
  )
    return null
  return file
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

export function handleAppProtocol(
  session: Session,
  rootDirectory: string,
  csp: string,
  logger: Logger
): void {
  const log = logger.child({ component: 'app-protocol' })
  session.protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    const file = resolveAppFile(rootDirectory, request.url)
    if (!file) {
      log.warn('app-protocol.refused', 'Refused a request outside the interface folder')
      return new Response('Not found', { status: 404 })
    }
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) return new Response('Not found', { status: 404 })
      const body = await readFile(file)
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
          'cross-origin-opener-policy': 'same-origin',
          'cache-control': 'no-store'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
