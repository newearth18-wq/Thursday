import {
  AppInfo,
  RendererErrorReceipt,
  RuntimeStatus,
  IpcResponseEnvelope,
  type ErrorEnvelope,
  type RendererErrorReport
} from '@jupiter/contracts'
import { createErrorEnvelope } from '@jupiter/core'
import type { z } from 'zod'
import type { JupiterBridge } from '../../shared/bridge'

/**
 * Typed client for the preload bridge. Every reply is validated against the
 * shared contract before the UI uses it; a reply that does not match is
 * treated as an error, never displayed.
 */

export class BridgeError extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message)
    this.name = 'BridgeError'
  }
}

function bridge(): JupiterBridge {
  const candidate = window.jupiter
  if (!candidate) {
    throw new BridgeError(
      createErrorEnvelope({
        code: 'BRIDGE_UNAVAILABLE',
        category: 'dependency',
        message:
          'The interface is not connected to the Jupiter application core (the preload bridge did not load).',
        userAction: 'Restart Jupiter. If this keeps happening, reinstall it.',
        retryable: false
      })
    )
  }
  return candidate
}

async function request<T extends z.ZodType>(
  call: () => Promise<unknown>,
  schema: T
): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await call()
  } catch (error) {
    throw new BridgeError(
      createErrorEnvelope({
        code: 'BRIDGE_CALL_FAILED',
        category: 'internal',
        message: `The request to the application core failed: ${error instanceof Error ? error.message : String(error)}`,
        userAction: 'Try again. If it keeps failing, restart Jupiter.',
        retryable: true
      })
    )
  }
  const envelope = IpcResponseEnvelope.safeParse(raw)
  if (!envelope.success) throw invalidReply()
  if (!envelope.data.ok) throw new BridgeError(envelope.data.error)
  const data = schema.safeParse(envelope.data.data)
  if (!data.success) throw invalidReply()
  return data.data
}

function invalidReply(): BridgeError {
  return new BridgeError(
    createErrorEnvelope({
      code: 'IPC_INVALID_RESPONSE',
      category: 'internal',
      message:
        'The application core sent a reply that does not match its contract, so it was not used.',
      userAction:
        'Restart Jupiter. If this keeps happening, include the log files in a bug report.',
      retryable: false
    })
  )
}

export function fetchAppInfo(): Promise<AppInfo> {
  return request(() => bridge().getAppInfo(), AppInfo)
}

export function fetchRuntimeStatus(): Promise<RuntimeStatus> {
  return request(() => bridge().getRuntimeStatus(), RuntimeStatus)
}

export function retryService(serviceId: string): Promise<RuntimeStatus> {
  return request(() => bridge().retryService(serviceId), RuntimeStatus)
}

/** Subscribe to status pushes. Invalid payloads are dropped, never rendered. */
export function subscribeRuntimeStatus(listener: (status: RuntimeStatus) => void): () => void {
  const target = window.jupiter
  if (!target) return () => undefined
  return target.onRuntimeStatusChanged((payload) => {
    const parsed = RuntimeStatus.safeParse(payload)
    if (parsed.success) listener(parsed.data)
  })
}

/** Report an interface error to the main-process log. Resolves to the log reference, or null. */
export async function reportRendererError(report: RendererErrorReport): Promise<string | null> {
  try {
    const receipt = await request(() => bridge().reportRendererError(report), RendererErrorReceipt)
    return receipt.correlationId
  } catch {
    return null
  }
}
