/**
 * IPC channel names between the renderer and the host gateway, with no
 * dependencies: the sandboxed preload imports only this module.
 *
 * Contract version 1 (SET 1). The gateway registers handlers for exactly
 * these channels; nothing else is reachable from the renderer.
 */

export const IPC_CONTRACT_VERSION = 1

export const InvokeChannel = {
  gatewayStatus: 'jupiter:v1:gateway-status',
  retryService: 'jupiter:v1:retry-service',
  request: 'jupiter:v1:request',
  cancel: 'jupiter:v1:cancel',
  subscribe: 'jupiter:v1:subscribe',
  unsubscribe: 'jupiter:v1:unsubscribe'
} as const
export type InvokeChannel = (typeof InvokeChannel)[keyof typeof InvokeChannel]

export const PushChannel = {
  message: 'jupiter:v1:message'
} as const
export type PushChannel = (typeof PushChannel)[keyof typeof PushChannel]

export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.values(InvokeChannel)
export const PUSH_CHANNELS: readonly PushChannel[] = Object.values(PushChannel)
