import { join, resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn() } }))
const { isAppProtocolUrl, resolveAppFile } = await import('./app-protocol')

const root = resolve('/opt/jupiter/renderer')

describe('resolveAppFile', () => {
  it('serves files inside the interface folder', () => {
    expect(resolveAppFile(root, 'jupiter://app/index.html')).toBe(join(root, 'index.html'))
    expect(resolveAppFile(root, 'jupiter://app/')).toBe(join(root, 'index.html'))
    expect(resolveAppFile(root, 'jupiter://app/assets/index-abc.js')).toBe(
      join(root, 'assets', 'index-abc.js')
    )
  })

  it('never resolves outside the folder, even when the URL tries to climb out', () => {
    // The URL parser collapses literal and percent-encoded dot segments ("%2e%2e") before
    // the handler sees the path; whatever remains must still resolve inside the root.
    for (const url of [
      'jupiter://app/../main/index.js',
      'jupiter://app/assets/../../../etc/passwd',
      'jupiter://app/%2e%2e/%2e%2e/etc/passwd'
    ]) {
      const file = resolveAppFile(root, url)
      expect(file === null || file.startsWith(root + sep), url).toBe(true)
    }
  })

  it('refuses encoded traversal, NUL bytes, backslashes and other origins', () => {
    for (const url of [
      'jupiter://app/assets/%2e%2e%2f%2e%2e%2fsecret',
      'jupiter://app/..%2f..%2f..%2fpackage.json',
      'jupiter://app/%00index.html',
      'jupiter://app/..%5c..%5cWindows%5cwin.ini',
      'jupiter://other/index.html',
      'file:///etc/passwd',
      'https://app/index.html',
      'not a url',
      'jupiter://app/%E0%A4%A'
    ]) {
      expect(resolveAppFile(root, url), url).toBeNull()
    }
  })
})

describe('isAppProtocolUrl', () => {
  it('matches only the jupiter://app origin', () => {
    expect(isAppProtocolUrl('jupiter://app/index.html')).toBe(true)
    expect(isAppProtocolUrl('jupiter://app.evil/index.html')).toBe(false)
    expect(isAppProtocolUrl('file:///index.html')).toBe(false)
  })
})
