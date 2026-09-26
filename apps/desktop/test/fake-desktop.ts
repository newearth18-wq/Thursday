import { createHash } from 'node:crypto'
import {
  AutomationCall,
  AutomationOps,
  type ElementInfo,
  type ElementQuery,
  type WindowInfo
} from '@jupiter/contracts'
import { JupiterError } from '@jupiter/core'

/**
 * A TEST DOUBLE of the Windows host for the Computer Agent (SET 8): a small
 * in-memory model of a desktop with Notepad and its Save As dialog, served
 * as `host.computer.call`. It lets the agent's own logic — permissions,
 * verification, cancellation, re-resolution, the coordinate fallback — be
 * tested on any platform, including faults a real desktop cannot produce on
 * demand. It is never used by the application. The real Notepad is tested
 * on Windows (computer-windows.integration.test.ts).
 */

export interface FakeDesktopFaults {
  /** Notepad's editor cannot be found (a missing UI element). */
  noEditor?: boolean
  /** Setting the editor's value is accepted but has no effect. */
  editorIgnoresInput?: boolean
  /** Notepad writes something other than its text to disk. */
  saveWritesWrongContent?: boolean
  /** Each automation call takes this long (to cancel during a task). */
  delayMs?: number
  /** The next call to this operation fails as if the runtime crashed. */
  crashOn?: string | null
  /** Notepad's window gets a new handle after this many listWindows calls. */
  newHandleAfterLists?: number | null
}

interface FakeWindow extends WindowInfo {
  kind: 'notepad' | 'dialog'
  text: string
  fileName: string
}

export const FAKE_DESKTOP_FOLDER = 'C:\\Users\\test\\Desktop'

export class FakeDesktop {
  readonly files = new Map<string, string>()
  readonly calls: string[] = []
  readonly clicks: { x: number; y: number }[] = []
  faults: FakeDesktopFaults = {}
  private windows: FakeWindow[] = []
  private nextHandle = 1000
  private lists = 0

  handler = async (input: unknown): Promise<unknown> => {
    const call = AutomationCall.parse(input)
    this.calls.push(call.op)
    if (this.faults.delayMs)
      await new Promise((resolve) => setTimeout(resolve, this.faults.delayMs))
    if (this.faults.crashOn === call.op) {
      this.faults.crashOn = null
      throw new JupiterError('RUNTIME_CRASHED', 'The agent runtime exited unexpectedly (code 3).', {
        category: 'dependency',
        userAction: 'Try again: Jupiter starts a new agent runtime for the next action.',
        retryable: true
      })
    }
    const params = AutomationOps[call.op].params.parse(call.params) as Record<string, unknown>
    return AutomationOps[call.op].result.parse(this.perform(call.op, params))
  }

  get notepadText(): string | null {
    return this.windows.find((window) => window.kind === 'notepad')?.text ?? null
  }

  get openWindows(): readonly WindowInfo[] {
    return this.windows
  }

  private perform(op: string, p: Record<string, unknown>): unknown {
    switch (op) {
      case 'status':
        return {
          available: true,
          platform: 'win32',
          reason: null,
          runtime: { state: 'running', pid: 4242, restarts: 0, lastError: null },
          screen: { width: 1920, height: 1080 },
          saveFolder: FAKE_DESKTOP_FOLDER,
          apps: ['notepad', 'explorer']
        }
      case 'listWindows': {
        this.lists += 1
        const after = this.faults.newHandleAfterLists
        if (after !== null && after !== undefined && this.lists === after) {
          const notepad = this.windows.find((window) => window.kind === 'notepad')
          if (notepad) notepad.handle = this.nextHandle++
        }
        return { windows: this.windows.map(info) }
      }
      case 'launch': {
        const pid = 7000 + this.windows.length
        this.windows.forEach((window) => (window.active = false))
        this.windows.push({
          kind: 'notepad',
          handle: this.nextHandle++,
          processId: pid,
          processName: 'notepad',
          title: 'Untitled - Notepad',
          bounds: { x: 100, y: 100, width: 800, height: 600 },
          active: true,
          minimized: false,
          text: '',
          fileName: ''
        })
        return { processId: pid }
      }
      case 'windowOp': {
        const window = this.window(p.handle as number)
        const operation = p.operation as string
        if (operation === 'close') {
          this.windows = this.windows.filter((item) => item !== window)
          return { window: null }
        }
        if (operation === 'focus') for (const item of this.windows) item.active = item === window
        if (operation === 'minimize') window.minimized = true
        if (operation === 'restore' || operation === 'maximize') window.minimized = false
        if (operation === 'move')
          window.bounds = { ...window.bounds, x: p.x as number, y: p.y as number }
        if (operation === 'resize')
          window.bounds = { ...window.bounds, width: p.width as number, height: p.height as number }
        return { window: info(window) }
      }
      case 'findElement':
      case 'readText':
      case 'setValue':
      case 'invoke': {
        const window = this.window(p.handle as number)
        const element = this.element(window, p.query as ElementQuery)
        if (op === 'findElement') return { element }
        if (op === 'readText') return { text: window.text }
        if (op === 'setValue') {
          if (window.kind === 'notepad' && !this.faults.editorIgnoresInput)
            window.text = p.text as string
          if (window.kind === 'dialog') window.fileName = p.text as string
          return { element }
        }
        // Invoking Save in the dialog.
        const notepad = this.windows.find(
          (item) => item.kind === 'notepad' && item.processId === window.processId
        )
        if (window.kind === 'dialog' && notepad) {
          this.files.set(
            window.fileName,
            this.faults.saveWritesWrongContent ? `${notepad.text} (changed)` : notepad.text
          )
          notepad.title = `${window.fileName.split('\\').pop() ?? ''} - Notepad`
          this.windows = this.windows.filter((item) => item !== window)
        }
        return { element }
      }
      case 'sendKeys': {
        const window = this.window(p.handle as number)
        const keys = p.keys as string[]
        if (window.kind === 'notepad' && keys.includes('Ctrl+S')) {
          for (const item of this.windows) item.active = false
          this.windows.push({
            kind: 'dialog',
            handle: this.nextHandle++,
            processId: window.processId,
            processName: 'notepad',
            title: 'Save As',
            bounds: { x: 150, y: 150, width: 600, height: 400 },
            active: true,
            minimized: false,
            text: '',
            fileName: ''
          })
        }
        return { window: info(window) }
      }
      case 'readTree': {
        const window = this.window(p.handle as number)
        return {
          nodes: [
            {
              depth: 0,
              controlType: 'Window',
              name: window.title,
              automationId: '',
              className: 'Notepad',
              enabled: true
            },
            {
              depth: 1,
              controlType: 'Document',
              name: 'Text Editor',
              automationId: '15',
              className: 'Edit',
              enabled: true
            }
          ],
          truncated: false
        }
      }
      case 'clickPoint': {
        const window = this.window(p.handle as number)
        this.clicks.push({ x: p.x as number, y: p.y as number })
        return {
          screenX: window.bounds.x + (p.x as number),
          screenY: window.bounds.y + (p.y as number)
        }
      }
      case 'screenshot':
        return { file: 'screenshot-test.png', width: 800, height: 600, bytes: 1234 }
      case 'resolveSavePath': {
        const path = `${FAKE_DESKTOP_FOLDER}\\${p.fileName as string}`
        return { path, exists: this.files.has(path) }
      }
      case 'verifyFile': {
        const path = `${FAKE_DESKTOP_FOLDER}\\${p.fileName as string}`
        const content = this.files.get(path)
        if (content === undefined)
          return { path, exists: false, bytes: 0, sha256: null, matches: false }
        const bytes = Buffer.from(content, 'utf8')
        return {
          path,
          exists: true,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          matches: content.replace(/\r\n/g, '\n') === (p.expected as string).replace(/\r\n/g, '\n')
        }
      }
      default:
        throw new JupiterError('UNKNOWN_OPERATION', `The test double has no ${op}.`, {
          category: 'internal',
          userAction: null
        })
    }
  }

  private window(handle: number): FakeWindow {
    const window = this.windows.find((item) => item.handle === handle)
    if (!window)
      throw new JupiterError('WINDOW_NOT_FOUND', `The window ${String(handle)} no longer exists.`, {
        category: 'dependency',
        userAction: null
      })
    return window
  }

  private element(window: FakeWindow, query: ElementQuery): ElementInfo {
    const base = { bounds: { x: 0, y: 0, width: 100, height: 20 }, enabled: true, className: '' }
    if (window.kind === 'notepad' && query.controlType === 'Document' && !this.faults.noEditor)
      return {
        ...base,
        automationId: '15',
        name: 'Text Editor',
        controlType: 'Document',
        patterns: ['Value', 'Text']
      }
    if (window.kind === 'dialog' && query.automationId === '1001')
      return {
        ...base,
        automationId: '1001',
        name: 'File name:',
        controlType: 'Edit',
        patterns: ['Value']
      }
    if (window.kind === 'dialog' && query.automationId === '1')
      return {
        ...base,
        automationId: '1',
        name: 'Save',
        controlType: 'Button',
        patterns: ['Invoke']
      }
    throw new JupiterError(
      'ELEMENT_NOT_FOUND',
      `No control matches (${JSON.stringify(query)}) in window ${String(window.handle)}.`,
      {
        category: 'dependency',
        userAction: null
      }
    )
  }
}

function info(window: FakeWindow): WindowInfo {
  return {
    handle: window.handle,
    processId: window.processId,
    processName: window.processName,
    title: window.title,
    bounds: window.bounds,
    active: window.active,
    minimized: window.minimized
  }
}
