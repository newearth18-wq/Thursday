import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENT_NAMES, isErrorEnvelope } from '../shared/channels.js'

/**
 * The preload bridge.
 *
 * Runs sandboxed with context isolation on. It exposes exactly the channels
 * listed in the contract and nothing else — no `ipcRenderer`, no `require`,
 * no Node globals reach the renderer.
 */

const api: Record<string, unknown> = {}

for (const channel of IPC_CHANNELS) {
  api[channel] = async (input?: unknown): Promise<unknown> => {
    const result: unknown = await ipcRenderer.invoke(channel, input)
    if (isErrorEnvelope(result)) {
      // Rethrow as a real Error so callers can use try/catch normally.
      const error = new Error(result.__thursdayError.message)
      error.name = result.__thursdayError.code
      throw error
    }
    return result
  }
}

api.on = (event: string, listener: (payload: unknown) => void): (() => void) => {
  if (!(IPC_EVENT_NAMES as readonly string[]).includes(event)) {
    throw new Error(`"${event}" is not a Thursday event`)
  }
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
  ipcRenderer.on(event, wrapped)
  return () => ipcRenderer.removeListener(event, wrapped)
}

contextBridge.exposeInMainWorld('thursday', api)
