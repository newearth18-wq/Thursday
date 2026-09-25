/**
 * IPC channel names, with no dependencies.
 *
 * The sandboxed preload script imports only this module, so it stays a tiny
 * bundle with no schema library inside. `ipc.ts` binds each name to its
 * schemas and a compile-time check keeps the two in sync.
 *
 * Channel names carry the contract version (`v0` = SET 0 foundation surface).
 * SET 1 replaces this with the full versioned command/event contract.
 */

export const IPC_CONTRACT_VERSION = 0

export const InvokeChannel = {
  getAppInfo: 'jupiter:v0:app:get-info',
  getRuntimeStatus: 'jupiter:v0:runtime:get-status',
  retryService: 'jupiter:v0:runtime:retry-service',
  reportRendererError: 'jupiter:v0:renderer:report-error'
} as const
export type InvokeChannel = (typeof InvokeChannel)[keyof typeof InvokeChannel]

export const EventChannel = {
  runtimeStatusChanged: 'jupiter:v0:runtime:status-changed'
} as const
export type EventChannel = (typeof EventChannel)[keyof typeof EventChannel]

export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.values(InvokeChannel)
export const EVENT_CHANNELS: readonly EventChannel[] = Object.values(EventChannel)
