import type { ComputerAppId, ElementQuery, WindowInfo } from '@jupiter/contracts'
import { JupiterError } from '../errors'
import type { ComputerDriver } from './driver'

/**
 * Application adapters for the Computer Agent (SET 8).
 *
 * The Generic Windows Adapter knows how to recognise an application's
 * windows. An application adapter adds what only that application knows:
 * Notepad's editor control and how it saves a file, File Explorer's folder
 * windows. Every adapter works through UI Automation queries (automation
 * ids, control types), never through screen positions.
 */

export interface AdapterContext {
  readonly driver: ComputerDriver
  readonly signal: AbortSignal | undefined
  readonly sleep: (ms: number) => Promise<void>
}

export interface SaveOutcome {
  /** How the Save dialog was reached and operated. */
  readonly observation: string
}

export interface AppAdapter {
  readonly app: ComputerAppId
  readonly name: string
  /** Is this window one of the application's main windows? */
  owns(window: WindowInfo): boolean
  /**
   * Where the document's text is, if the application has one: the queries
   * that find it, tried in order (application versions expose it differently).
   */
  readonly editor: readonly ElementQuery[]
  /** Saves the open document under a full path the host chose; null if the app cannot. */
  readonly save:
    ((context: AdapterContext, window: WindowInfo, path: string) => Promise<SaveOutcome>) | null
}

/** The Generic Windows Adapter: an application's windows by process name. */
function genericOwns(processNames: readonly string[]) {
  return (window: WindowInfo) =>
    processNames.includes(window.processName.toLowerCase()) && window.title.trim().length > 0
}

/** Notepad's Save As dialog: the file name box and the Save button of the common file dialog. */
const FILE_NAME_BOX: ElementQuery = { automationId: '1001' }
const FILE_NAME_FALLBACK: ElementQuery = { controlType: 'Edit', name: 'File name:' }
const SAVE_BUTTON: ElementQuery = { automationId: '1', controlType: 'Button' }

const notepad: AppAdapter = {
  app: 'notepad',
  name: 'Notepad',
  owns: genericOwns(['notepad']),
  // Classic Notepad exposes its text as an Edit control; the current Notepad as a Document.
  editor: [
    { controlType: 'Edit', className: 'Edit' },
    { controlType: 'Document' },
    { className: 'RichEditD2DPT' }
  ],
  async save(context, window, path) {
    const { driver } = context
    const before = new Set(
      (await driver.call('listWindows', {})).windows.map((item) => item.handle)
    )
    // Ctrl+S is Notepad's own accelerator for Save; an untitled document opens Save As.
    await driver.call('sendKeys', { handle: window.handle, keys: ['Ctrl+S'] })
    const dialog = await waitFor(context, 10_000, async () => {
      const { windows } = await driver.call('listWindows', {})
      return (
        windows.find(
          (item) =>
            item.processId === window.processId &&
            item.handle !== window.handle &&
            !before.has(item.handle)
        ) ?? null
      )
    })
    if (!dialog)
      throw new JupiterError('SAVE_DIALOG_NOT_SHOWN', 'Notepad did not open its Save As dialog.', {
        category: 'dependency',
        userAction: 'Make sure Notepad is not busy with another dialog, then try again.'
      })
    try {
      await driver.call('setValue', { handle: dialog.handle, query: FILE_NAME_BOX, text: path })
    } catch (error) {
      if (!(error instanceof JupiterError) || error.code !== 'ELEMENT_NOT_FOUND') throw error
      await driver.call('setValue', {
        handle: dialog.handle,
        query: FILE_NAME_FALLBACK,
        text: path
      })
    }
    await driver.call('invoke', { handle: dialog.handle, query: SAVE_BUTTON })
    const closed = await waitFor(context, 10_000, async () => {
      const { windows } = await driver.call('listWindows', {})
      return windows.some((item) => item.handle === dialog.handle) ? null : true
    })
    if (!closed)
      throw new JupiterError(
        'SAVE_NOT_COMPLETED',
        `The Save As dialog ("${dialog.title}") is still open after Save was pressed; Notepad may be asking a question.`,
        {
          category: 'dependency',
          userAction: 'Look at Notepad, answer or cancel its dialog, then try again.'
        }
      )
    return {
      observation: `Opened Save As with Ctrl+S, entered the path in the file name box (automation id 1001) and invoked Save (automation id 1); the dialog "${dialog.title}" closed.`
    }
  }
}

const explorer: AppAdapter = {
  app: 'explorer',
  name: 'File Explorer',
  // The desktop and the taskbar belong to explorer.exe too; they are not folder windows.
  owns: (window) =>
    window.processName.toLowerCase() === 'explorer' &&
    window.title.trim().length > 0 &&
    window.title !== 'Program Manager',
  editor: [],
  save: null
}

export const ADAPTERS: Readonly<Record<ComputerAppId, AppAdapter>> = { notepad, explorer }

/** Polls until `probe` returns something, the deadline passes, or the task is cancelled. */
export async function waitFor<T>(
  context: AdapterContext,
  timeoutMs: number,
  probe: () => Promise<T | null>
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (context.signal?.aborted) return null
    const found = await probe()
    if (found !== null) return found
    if (Date.now() >= deadline) return null
    await context.sleep(250)
  }
}
