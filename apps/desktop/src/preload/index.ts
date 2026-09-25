import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EventChannel, InvokeChannel } from '@jupiter/contracts/channels'
import type { JupiterBridge } from '../shared/bridge'

/**
 * Sandboxed preload. Exposes exactly five functions bound to fixed channels —
 * no generic `invoke`, no `ipcRenderer`, no Node.js. Everything passed through
 * is validated by the main process before use.
 */
const bridge: JupiterBridge = {
  getAppInfo: () => ipcRenderer.invoke(InvokeChannel.getAppInfo),
  getRuntimeStatus: () => ipcRenderer.invoke(InvokeChannel.getRuntimeStatus),
  retryService: (serviceId: string) =>
    ipcRenderer.invoke(InvokeChannel.retryService, { serviceId }),
  reportRendererError: (report: unknown) =>
    ipcRenderer.invoke(InvokeChannel.reportRendererError, report),
  onRuntimeStatusChanged: (listener: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      listener(payload)
    }
    ipcRenderer.on(EventChannel.runtimeStatusChanged, handler)
    return () => {
      ipcRenderer.removeListener(EventChannel.runtimeStatusChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('jupiter', Object.freeze(bridge))
