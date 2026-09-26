import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { InvokeChannel, PushChannel } from '@jupiter/contracts/channels'
import type { JupiterBridge } from '../shared/bridge'

/**
 * Sandboxed preload. Exposes a fixed, frozen set of functions bound to fixed
 * channels — no generic send/invoke, no ipcRenderer, no Node.js. Everything
 * passed through is validated by the host before it is used.
 */
const bridge: JupiterBridge = {
  gatewayStatus: () => ipcRenderer.invoke(InvokeChannel.gatewayStatus),
  retryService: (serviceId: string) =>
    ipcRenderer.invoke(InvokeChannel.retryService, { serviceId }),
  request: (envelope: unknown) => ipcRenderer.invoke(InvokeChannel.request, envelope),
  cancel: (requestId: string) => ipcRenderer.invoke(InvokeChannel.cancel, { requestId }),
  subscribe: (options: unknown) => ipcRenderer.invoke(InvokeChannel.subscribe, options),
  unsubscribe: (subscriptionId: string) =>
    ipcRenderer.invoke(InvokeChannel.unsubscribe, { subscriptionId }),
  onMessage: (listener: (message: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, message: unknown) => {
      listener(message)
    }
    ipcRenderer.on(PushChannel.message, handler)
    return () => {
      ipcRenderer.removeListener(PushChannel.message, handler)
    }
  }
}

contextBridge.exposeInMainWorld('jupiter', Object.freeze(bridge))
