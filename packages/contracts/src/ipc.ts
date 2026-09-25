import { z } from 'zod'
import { AppInfo } from './app-info'
import { EventChannel, InvokeChannel } from './channels'
import { ErrorEnvelope } from './errors'
import { ServiceId, Uuidv7 } from './primitives'
import { RuntimeStatus } from './service-health'

/**
 * The complete SET 0 IPC surface: every channel, its input schema and its
 * output schema. The main process rejects anything not listed here, validates
 * every input before a handler runs and every output before it is sent; the
 * renderer validates every response again on arrival.
 */

export const RendererErrorReport = z
  .object({
    source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']),
    message: z.string().min(1).max(2000),
    stack: z.string().max(8000).nullable(),
    componentStack: z.string().max(8000).nullable()
  })
  .strict()
export type RendererErrorReport = z.infer<typeof RendererErrorReport>

export const RendererErrorReceipt = z.object({ correlationId: Uuidv7 }).strict()
export type RendererErrorReceipt = z.infer<typeof RendererErrorReceipt>

export const RetryServiceRequest = z.object({ serviceId: ServiceId }).strict()
export type RetryServiceRequest = z.infer<typeof RetryServiceRequest>

export const ipcInvokeContract = {
  [InvokeChannel.getAppInfo]: { input: z.undefined(), output: AppInfo },
  [InvokeChannel.getRuntimeStatus]: { input: z.undefined(), output: RuntimeStatus },
  [InvokeChannel.retryService]: { input: RetryServiceRequest, output: RuntimeStatus },
  [InvokeChannel.reportRendererError]: { input: RendererErrorReport, output: RendererErrorReceipt }
} as const satisfies Record<InvokeChannel, { input: z.ZodType; output: z.ZodType }>

export const ipcEventContract = {
  [EventChannel.runtimeStatusChanged]: RuntimeStatus
} as const satisfies Record<EventChannel, z.ZodType>

export type IpcInput<C extends InvokeChannel> = z.infer<(typeof ipcInvokeContract)[C]['input']>
export type IpcOutput<C extends InvokeChannel> = z.infer<(typeof ipcInvokeContract)[C]['output']>
export type IpcEventPayload<E extends EventChannel> = z.infer<(typeof ipcEventContract)[E]>

/**
 * Every invoke reply is one of these two shapes, always with a correlation ID.
 * The receiver validates the envelope first, then `data` against the
 * channel's own output schema.
 */
export const IpcResponseEnvelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), correlationId: Uuidv7, data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), correlationId: Uuidv7, error: ErrorEnvelope }).strict()
])

export type IpcResponse<T> =
  | { ok: true; correlationId: Uuidv7; data: T }
  | { ok: false; correlationId: Uuidv7; error: ErrorEnvelope }

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && Object.hasOwn(ipcInvokeContract, value)
}
