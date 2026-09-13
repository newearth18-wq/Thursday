import type { Permission } from '@shared/permissions.js'

/** Messages exchanged between the plugin engine and an isolated plugin host. */

export interface HostInitMessage {
  type: 'init'
  pluginId: string
  entryPath: string
  dataDir: string
  permissions: Permission[]
}

export interface HostInvokeMessage {
  type: 'invoke'
  callId: string
  skillId: string
  input: Record<string, unknown>
}

export interface HostBridgeReply {
  type: 'bridge-reply'
  bridgeId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface HostShutdownMessage {
  type: 'shutdown'
}

export type ParentToHost = HostInitMessage | HostInvokeMessage | HostBridgeReply | HostShutdownMessage

export interface HostReadyMessage {
  type: 'ready'
  skills: { id: string; name: string; description: string; inputSchema: Record<string, unknown> }[]
}

export interface HostFailedMessage {
  type: 'failed'
  error: string
}

export interface HostResultMessage {
  type: 'result'
  callId: string
  ok: boolean
  output?: unknown
  error?: string
}

export interface HostLogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
  data?: Record<string, unknown>
}

export interface HostBridgeRequest {
  type: 'bridge'
  bridgeId: string
  method: 'getActiveTab' | 'writeFile' | 'readFile'
  args: unknown[]
}

export type HostToParent =
  | HostReadyMessage
  | HostFailedMessage
  | HostResultMessage
  | HostLogMessage
  | HostBridgeRequest
