import { BrowserWindow, desktopCapturer, screen, type NativeImage } from 'electron'
import type { CapturedWindow, WindowInfo } from '@jupiter/contracts'
import { JupiterError } from '@jupiter/core'
import type { CapturedScreen, ScreenCapturer } from './vision-host'

/**
 * Screen capture with Electron (SET 13). Pixels stay in memory.
 *
 * - The whole screen: the primary display at its full resolution.
 * - The active window: Jupiter's own window when it has the focus; on
 *   Windows, otherwise, the foreground window the Computer Agent's runtime
 *   reports, captured by its handle — the same handle the agent acts on, so
 *   before/after evidence is tied to the right window.
 * - A window by handle (Windows): the window the Computer Agent found.
 */

export interface ScreenCaptureOptions {
  readonly platform: NodeJS.Platform
  /** The windows the Computer Agent's runtime sees (Windows only), or null. */
  readonly windows: (() => Promise<readonly WindowInfo[]>) | null
}

export function electronScreenCapturer(options: ScreenCaptureOptions): ScreenCapturer {
  const png = (image: NativeImage): Buffer => {
    if (image.isEmpty())
      throw new JupiterError(
        'CAPTURE_FAILED',
        'The screen capture came back empty (the display may be off, locked or protected).',
        {
          category: 'dependency',
          userAction: 'Unlock the display, then try again.',
          retryable: true
        }
      )
    return image.toPNG()
  }

  const jupiterWindow = async (window: BrowserWindow): Promise<CapturedScreen> => ({
    png: png(await window.webContents.capturePage()),
    window: { title: window.getTitle().slice(0, 300), owner: 'jupiter', handle: handleOf(window) }
  })

  const systemWindow = async (info: WindowInfo): Promise<CapturedScreen> => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: Math.max(1, info.bounds.width),
        height: Math.max(1, info.bounds.height)
      },
      fetchWindowIcons: false
    })
    const source = sources.find((candidate) =>
      candidate.id.startsWith(`window:${String(info.handle)}:`)
    )
    if (!source)
      throw new JupiterError(
        'CAPTURE_WINDOW_NOT_FOUND',
        `The window "${info.title}" can no longer be captured (it may have closed).`,
        { category: 'validation', userAction: null }
      )
    const window: CapturedWindow = {
      title: info.title.slice(0, 300),
      owner: 'system',
      handle: info.handle
    }
    return { png: png(source.thumbnail), window }
  }

  const listWindows = async (): Promise<readonly WindowInfo[]> => {
    if (!options.windows)
      throw new JupiterError(
        'CAPTURE_UNAVAILABLE',
        'Capturing another application’s window needs the Windows Computer Agent.',
        { category: 'unsupported', userAction: null }
      )
    return options.windows()
  }

  return {
    name: 'Electron screen capture',
    unavailable(source) {
      if (source === 'window' && options.platform !== 'win32')
        return 'Capturing another application’s window by its handle needs Windows.'
      return null
    },
    async desktop() {
      const display = screen.getPrimaryDisplay()
      const size = {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
      const source =
        sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
      if (!source)
        throw new JupiterError('CAPTURE_FAILED', 'The system offered no screen to capture.', {
          category: 'dependency',
          userAction: null,
          retryable: true
        })
      return { png: png(source.thumbnail), window: null }
    },
    async activeWindow() {
      const focused = BrowserWindow.getFocusedWindow()
      if (focused && !focused.isDestroyed()) return jupiterWindow(focused)
      if (options.platform !== 'win32')
        throw new JupiterError(
          'CAPTURE_UNAVAILABLE',
          'The active window belongs to another application; on this system Jupiter can capture only its own windows, the whole screen or a region.',
          { category: 'unsupported', userAction: 'Capture the whole screen or a region instead.' }
        )
      const active = (await listWindows()).find((window) => window.active && !window.minimized)
      if (!active)
        throw new JupiterError('CAPTURE_WINDOW_NOT_FOUND', 'No window is active right now.', {
          category: 'validation',
          userAction: 'Click the window you mean, then try again.'
        })
      return systemWindow(active)
    },
    async window(handle) {
      const own = BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && handleOf(window) === handle
      )
      if (own) return jupiterWindow(own)
      const info = (await listWindows()).find((window) => window.handle === handle)
      if (!info)
        throw new JupiterError(
          'CAPTURE_WINDOW_NOT_FOUND',
          'That window is no longer open, so it cannot be captured.',
          { category: 'validation', userAction: null }
        )
      return systemWindow(info)
    }
  }
}

/** The window's native handle as a number (HWND on Windows, the X11 window id on Linux). */
function handleOf(window: BrowserWindow): number | null {
  const buffer = window.getNativeWindowHandle()
  if (buffer.byteLength >= 8) {
    const value = buffer.readBigUInt64LE(0)
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  }
  if (buffer.byteLength >= 4) return buffer.readUInt32LE(0)
  return null
}
