import { z } from 'zod'
import { AppInfo } from './app-info'
import { InvokeChannel, PushChannel } from './channels'
import { ErrorEnvelope } from './errors'
import { DomainEvent, EventFilter } from './events'
import { ServiceId, UtcTimestamp, Uuidv7 } from './primitives'
import { ProgressUpdate } from './progress'
import { CONTRACT_VERSION, RequestEnvelope, ResultEnvelope } from './request'
import { RuntimeStatus } from './service-health'

/**
 * Renderer ↔ host gateway contract (version 1).
 *
 * The gateway answers two things itself — its own status and the recovery of
 * runtime services — because they must keep working when Jupiter Core is
 * down. Every other request is forwarded to the Core capability dispatcher.
 */

export const CoreProcessState = z.enum(['starting', 'running', 'stopping', 'stopped', 'crashed'])
export type CoreProcessState = z.infer<typeof CoreProcessState>

export const CoreProcessInfo = z
  .object({
    state: CoreProcessState,
    pid: z.number().int().nonnegative().nullable(),
    restarts: z.number().int().nonnegative(),
    lastExit: z
      .object({
        exitCode: z.number().int().nullable(),
        reason: z.string().max(500),
        at: UtcTimestamp,
        expected: z.boolean()
      })
      .strict()
      .nullable()
  })
  .strict()
export type CoreProcessInfo = z.infer<typeof CoreProcessInfo>

export const GatewayStatus = z
  .object({
    app: AppInfo,
    runtime: RuntimeStatus,
    core: CoreProcessInfo
  })
  .strict()
export type GatewayStatus = z.infer<typeof GatewayStatus>

export const CancelRequest = z.object({ requestId: Uuidv7 }).strict()
export const CancelReceipt = z.object({ requestId: Uuidv7, cancelled: z.boolean() }).strict()
export type CancelReceipt = z.infer<typeof CancelReceipt>

export const MAX_REPLAY = 500

export const SubscribeRequest = z
  .object({
    subscriptionId: Uuidv7,
    /** Deliver persistent events after this global sequence. Null: the most recent `replayLimit` events. */
    afterSequence: z.number().int().nonnegative().nullable(),
    replayLimit: z.number().int().min(0).max(MAX_REPLAY),
    filter: EventFilter
  })
  .strict()
export type SubscribeRequest = z.infer<typeof SubscribeRequest>

export const SubscribeReceipt = z
  .object({
    subscriptionId: Uuidv7,
    replayed: z.number().int().nonnegative(),
    latestSequence: z.number().int().nonnegative(),
    /** True when more events existed after the cursor than could be replayed: the client must reset its state. */
    truncated: z.boolean()
  })
  .strict()
export type SubscribeReceipt = z.infer<typeof SubscribeReceipt>

export const UnsubscribeRequest = z.object({ subscriptionId: Uuidv7 }).strict()
export const RetryServiceRequest = z.object({ serviceId: ServiceId }).strict()

/** Reply shape of the gateway's own operations. */
export const GatewayReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), correlationId: Uuidv7, data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), correlationId: Uuidv7, error: ErrorEnvelope }).strict()
])
export type GatewayReply = z.infer<typeof GatewayReply>

export const gatewayContract = {
  [InvokeChannel.gatewayStatus]: { input: z.undefined(), output: GatewayStatus },
  [InvokeChannel.retryService]: { input: RetryServiceRequest, output: GatewayStatus },
  [InvokeChannel.request]: { input: RequestEnvelope, output: ResultEnvelope },
  [InvokeChannel.cancel]: { input: CancelRequest, output: CancelReceipt },
  [InvokeChannel.subscribe]: { input: SubscribeRequest, output: SubscribeReceipt },
  [InvokeChannel.unsubscribe]: {
    input: UnsubscribeRequest,
    output: z.object({ subscriptionId: Uuidv7, closed: z.boolean() }).strict()
  }
} as const satisfies Record<InvokeChannel, { input: z.ZodType; output: z.ZodType }>

/** Messages the host pushes to the renderer on `jupiter:v1:message`. */
export const RendererMessage = z.discriminatedUnion('kind', [
  z
    .object({
      v: z.literal(CONTRACT_VERSION),
      kind: z.literal('gateway-status'),
      status: GatewayStatus
    })
    .strict(),
  z
    .object({
      v: z.literal(CONTRACT_VERSION),
      kind: z.literal('event'),
      subscriptionId: Uuidv7,
      event: DomainEvent
    })
    .strict(),
  z
    .object({
      v: z.literal(CONTRACT_VERSION),
      kind: z.literal('progress'),
      progress: ProgressUpdate
    })
    .strict(),
  z
    .object({
      v: z.literal(CONTRACT_VERSION),
      kind: z.literal('subscription-ended'),
      subscriptionId: Uuidv7,
      reason: z.enum(['core-stopped', 'closed-by-core'])
    })
    .strict()
])
export type RendererMessage = z.infer<typeof RendererMessage>

export const RENDERER_MESSAGE_CHANNEL = PushChannel.message

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && Object.hasOwn(gatewayContract, value)
}
