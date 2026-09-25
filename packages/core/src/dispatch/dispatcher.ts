import type { z } from 'zod'
import {
  CONTRACT_VERSION,
  CapabilityId,
  RequestEnvelope,
  type Actor,
  type ActorType,
  type AuditEvent,
  type AuditOutcome,
  type CapabilitySummary,
  type ErrorEnvelope,
  type ProgressUnit,
  type ProgressUpdate,
  type RequestKind,
  type ResultEnvelope,
  type RiskLevel
} from '@jupiter/contracts'
import { redactValue } from '@jupiter/security'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from '../errors'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'

/**
 * The internal capability dispatcher: the only way anything reaches a Core
 * capability or a privileged host function.
 *
 * For every request it establishes the correlation context (requestId,
 * correlationId, missionId, executionId, actor, timestamps, cancellation
 * signal), then in order:
 *   1. validates the versioned envelope;
 *   2. resolves the capability — unknown capabilities are rejected;
 *   3. checks the request kind (command vs query);
 *   4. authorizes the actor against the capability's policy — deny by default;
 *   5. validates the payload against the capability's strict schema;
 *   6. checks the services the capability depends on;
 *   7. runs the handler with a deadline and a cancellation signal;
 *   8. validates the output — an invalid output is never returned;
 *   9. writes the audit record and returns a correlated result.
 * It never throws: every outcome is a ResultEnvelope.
 *
 * SET 7 plugs the Permission Engine into step 4.
 */

export interface RequestContext {
  readonly requestId: string
  readonly correlationId: string
  readonly kind: RequestKind
  readonly capability: string
  readonly missionId: string | null
  readonly executionId: string | null
  readonly actor: Actor
  readonly sentAt: string
  readonly receivedAt: string
  readonly deadline: string
}

export interface ProgressInput {
  readonly stage: string
  readonly completed: number | null
  readonly total: number | null
  readonly unit: ProgressUnit | null
  readonly message: string | null
}

export interface CapabilityContext {
  readonly request: RequestContext
  readonly signal: AbortSignal
  readonly logger: Logger
  progress(update: ProgressInput): void
}

export interface CapabilityDefinition<I, O> {
  readonly id: string
  readonly kind: RequestKind
  readonly input: z.ZodType<I>
  readonly output: z.ZodType<O>
  /** Deny by default: only these actor types may call the capability. */
  readonly allowedActors: readonly ActorType[]
  readonly risk: RiskLevel
  /** Where the work happens. Host capabilities are executed by the host only on the dispatcher's behalf. */
  readonly provider: 'core' | 'host'
  /** Commands that change state are audited on every call; reads only when denied or rejected. */
  readonly audit: 'always' | 'denials-only'
  readonly timeoutMs: number
  /** Services that must be running (HEALTHY or DEGRADED) for the capability to run. */
  readonly requires: readonly string[]
  target?(input: I): string | null
  handle(input: I, context: CapabilityContext): Promise<O> | O
}

export interface AuditSink {
  record(entry: AuditEvent): void
}

export interface DispatcherOptions {
  readonly logger: Logger
  readonly audit: AuditSink
  readonly isServiceAvailable: (serviceId: string) => boolean
  readonly onInternalError?: (error: ErrorEnvelope, context: RequestContext) => void
  readonly now?: () => Date
  /** Upper bound on concurrent requests, a resource limit at the boundary. */
  readonly maxInFlight?: number
}

export interface DispatchHooks {
  readonly onProgress?: (progress: ProgressUpdate) => void
}

interface InFlight {
  readonly controller: AbortController
  readonly actor: Actor
}

type AnyCapability = CapabilityDefinition<unknown, unknown>

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

export class CapabilityDispatcher {
  private readonly capabilities = new Map<string, AnyCapability>()
  private readonly inFlight = new Map<string, InFlight>()
  private readonly now: () => Date
  private readonly maxInFlight: number

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? (() => new Date())
    this.maxInFlight = options.maxInFlight ?? 128
  }

  register<I, O>(definition: CapabilityDefinition<I, O>): void {
    if (!CapabilityId.safeParse(definition.id).success)
      throw new Error(`Invalid capability id "${definition.id}"`)
    if (this.capabilities.has(definition.id))
      throw new Error(`Capability "${definition.id}" is registered twice`)
    if (definition.allowedActors.length === 0)
      throw new Error(`Capability "${definition.id}" allows no actor`)
    this.capabilities.set(definition.id, definition)
  }

  has(id: string): boolean {
    return this.capabilities.has(id)
  }

  catalogue(): CapabilitySummary[] {
    return [...this.capabilities.values()]
      .map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        allowedActors: [...capability.allowedActors],
        risk: capability.risk,
        provider: capability.provider
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  /** Cancel a running request. Only the actor that sent it may cancel it. */
  cancel(requestId: string, actor: Actor): boolean {
    const entry = this.inFlight.get(requestId)
    if (entry?.actor.type !== actor.type || entry.actor.id !== actor.id) return false
    entry.controller.abort()
    return true
  }

  /** Cancel everything in flight (shutdown). */
  cancelAll(): void {
    for (const entry of this.inFlight.values()) entry.controller.abort()
  }

  async dispatch(raw: unknown, actor: Actor, hooks: DispatchHooks = {}): Promise<ResultEnvelope> {
    const receivedAt = this.now()
    const parsed = RequestEnvelope.safeParse(raw)
    if (!parsed.success) {
      const requestId = extractRequestId(raw) ?? uuidv7()
      return this.reject(
        requestId,
        actor,
        null,
        'INVALID_REQUEST',
        'validation',
        `The request is malformed — ${issues(parsed.error)}`
      )
    }
    const request = parsed.data
    const log = this.options.logger.child({
      component: 'dispatcher',
      correlationId: request.requestId
    })
    const capability = this.capabilities.get(request.type)
    if (!capability) {
      return this.reject(
        request.requestId,
        actor,
        request,
        'UNKNOWN_CAPABILITY',
        'validation',
        `There is no capability called "${request.type}".`
      )
    }
    if (capability.kind !== request.kind) {
      return this.reject(
        request.requestId,
        actor,
        request,
        'REQUEST_KIND_MISMATCH',
        'validation',
        `"${request.type}" is a ${capability.kind}, but it was sent as a ${request.kind}.`
      )
    }

    const deadline = new Date(receivedAt.getTime() + capability.timeoutMs)
    const context: RequestContext = {
      requestId: request.requestId,
      correlationId: request.requestId,
      kind: request.kind,
      capability: capability.id,
      missionId: request.missionId,
      executionId: request.executionId,
      actor,
      sentAt: request.sentAt,
      receivedAt: receivedAt.toISOString(),
      deadline: deadline.toISOString()
    }

    if (!capability.allowedActors.includes(actor.type)) {
      const error = createErrorEnvelope({
        code: 'PERMISSION_DENIED',
        category: 'permission',
        message: `${describeActor(actor)} is not allowed to use "${capability.id}".`,
        userAction: null,
        retryable: false,
        missionId: request.missionId,
        executionId: request.executionId
      })
      this.writeAudit('capability.denied', 'DENIED', null, capability, context, null, {
        reason: 'actor-not-allowed'
      })
      log.warn('capability.denied', error.message, { capability: capability.id, actor })
      return this.failure(context, error)
    }

    if (this.inFlight.has(request.requestId)) {
      return this.reject(
        request.requestId,
        actor,
        request,
        'DUPLICATE_REQUEST',
        'validation',
        `Request ${request.requestId} is already running.`
      )
    }
    if (this.inFlight.size >= this.maxInFlight) {
      return this.failure(
        context,
        createErrorEnvelope({
          code: 'TOO_MANY_REQUESTS',
          category: 'dependency',
          message: `Jupiter Core is already handling ${String(this.maxInFlight)} requests.`,
          userAction: 'Wait a moment and try again.',
          retryable: true
        })
      )
    }

    const input = capability.input.safeParse(request.payload)
    if (!input.success) {
      return this.reject(
        request.requestId,
        actor,
        request,
        'INVALID_PAYLOAD',
        'validation',
        `Invalid payload for "${capability.id}" — ${issues(input.error)}`,
        capability
      )
    }
    const target = capability.target?.(input.data) ?? null

    const missing = capability.requires.filter(
      (serviceId) => !this.options.isServiceAvailable(serviceId)
    )
    if (missing.length > 0) {
      const error = createErrorEnvelope({
        code: 'DEPENDENCY_UNAVAILABLE',
        category: 'dependency',
        message: `"${capability.id}" needs ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not running.`,
        userAction: 'Open Diagnostics, fix the failed service and press Retry.',
        retryable: true,
        missionId: request.missionId,
        executionId: request.executionId
      })
      if (capability.audit === 'always')
        this.writeAudit('capability.dispatched', 'ALLOWED', 'FAILED', capability, context, target, {
          error: error.code
        })
      return this.failure(context, error)
    }

    const controller = new AbortController()
    this.inFlight.set(request.requestId, { controller, actor })
    const started = performance.now()
    log.debug('capability.start', `${capability.id} started`, {
      capability: capability.id,
      actor,
      kind: capability.kind
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let outcome: AuditOutcome = 'SUCCEEDED'
    try {
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(
            timedOut
              ? new JupiterError(
                  'TIMEOUT',
                  `"${capability.id}" did not finish within ${String(capability.timeoutMs)} ms and was stopped.`,
                  {
                    category: 'timeout',
                    userAction: 'Try again. If it keeps timing out, check Diagnostics.',
                    retryable: true
                  }
                )
              : new JupiterError('CANCELLED', `"${capability.id}" was cancelled.`, {
                  category: 'cancellation',
                  userAction: null
                })
          )
        }
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, capability.timeoutMs)

      const handlerContext: CapabilityContext = {
        request: context,
        signal: controller.signal,
        logger: log.child({ component: capability.id }),
        progress: (update) => {
          if (controller.signal.aborted) return
          hooks.onProgress?.({
            v: CONTRACT_VERSION,
            requestId: request.requestId,
            ...update,
            at: this.now().toISOString()
          })
        }
      }
      const result = await Promise.race([
        Promise.resolve().then(() => capability.handle(input.data, handlerContext)),
        aborted
      ])
      const output = capability.output.safeParse(result)
      if (!output.success) {
        outcome = 'FAILED'
        const error = createErrorEnvelope({
          code: 'INVALID_CAPABILITY_OUTPUT',
          category: 'internal',
          message: `"${capability.id}" produced a result that breaks its contract, so it was not returned.`,
          userAction:
            'Restart Jupiter. If this keeps happening, include the log files in a bug report.',
          retryable: false
        })
        log.error('capability.output.invalid', error.message, {
          capability: capability.id,
          issues: issues(output.error)
        })
        this.options.onInternalError?.(error, context)
        return this.failure(context, error)
      }
      log.info('capability.succeeded', `${capability.id} succeeded`, {
        capability: capability.id,
        durationMs: Math.round(performance.now() - started)
      })
      return {
        v: CONTRACT_VERSION,
        requestId: request.requestId,
        correlationId: context.correlationId,
        ok: true,
        data: output.data,
        completedAt: this.now().toISOString()
      }
    } catch (error) {
      const envelope = toErrorEnvelope(error, {
        code: 'INTERNAL_ERROR',
        category: 'internal',
        userAction: 'Try again. If it keeps failing, restart Jupiter.',
        retryable: true
      })
      outcome =
        envelope.category === 'cancellation'
          ? 'CANCELLED'
          : envelope.category === 'timeout'
            ? 'TIMED_OUT'
            : 'FAILED'
      const level = envelope.category === 'cancellation' ? 'info' : 'error'
      log[level](
        'capability.failed',
        `${capability.id} ${outcome.toLowerCase().replace('_', ' ')}: ${envelope.message}`,
        {
          capability: capability.id,
          code: envelope.code,
          errorId: envelope.errorId,
          durationMs: Math.round(performance.now() - started)
        }
      )
      if (!(error instanceof JupiterError)) this.options.onInternalError?.(envelope, context)
      return this.failure(context, {
        ...envelope,
        missionId: request.missionId,
        executionId: request.executionId
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.inFlight.delete(request.requestId)
      if (capability.audit === 'always')
        this.writeAudit(
          'capability.dispatched',
          'ALLOWED',
          outcome,
          capability,
          context,
          target,
          {}
        )
    }
  }

  private reject(
    requestId: string,
    actor: Actor,
    request: RequestEnvelope | null,
    code: string,
    category: 'validation',
    message: string,
    capability?: AnyCapability
  ): ResultEnvelope {
    const now = this.now().toISOString()
    const context: RequestContext = {
      requestId,
      correlationId: requestId,
      kind: request?.kind ?? 'query',
      capability: request?.type ?? 'unknown',
      missionId: request?.missionId ?? null,
      executionId: request?.executionId ?? null,
      actor,
      sentAt: request?.sentAt ?? now,
      receivedAt: now,
      deadline: now
    }
    const error = createErrorEnvelope({
      code,
      category,
      message,
      userAction: null,
      retryable: false,
      missionId: context.missionId,
      executionId: context.executionId
    })
    this.options.logger.warn('capability.rejected', message, {
      code,
      actor,
      capability: request?.type ?? null
    })
    this.writeAudit('capability.rejected', 'REJECTED', null, capability ?? null, context, null, {
      code,
      requestedCapability: request?.type ?? null
    })
    return this.failure(context, error)
  }

  private failure(context: RequestContext, error: ErrorEnvelope): ResultEnvelope {
    return {
      v: CONTRACT_VERSION,
      requestId: context.requestId,
      correlationId: context.correlationId,
      ok: false,
      error,
      completedAt: this.now().toISOString()
    }
  }

  private writeAudit(
    eventType: AuditEvent['eventType'],
    decision: AuditEvent['decision'],
    outcome: AuditOutcome | null,
    capability: AnyCapability | null,
    context: RequestContext,
    target: string | null,
    metadata: Record<string, string | number | boolean | null>
  ): void {
    const redacted = redactValue(metadata) as Record<string, string | number | boolean | null>
    const entry: AuditEvent = {
      auditId: uuidv7(),
      eventType,
      actor: context.actor,
      capability:
        capability?.id ??
        (CapabilityId.safeParse(context.capability).success ? context.capability : null),
      target,
      decision,
      riskLevel: capability?.risk ?? 'LOW',
      missionId: context.missionId,
      executionId: context.executionId,
      timestamp: this.now().toISOString(),
      metadataRedacted: redacted,
      correlationId: context.correlationId,
      outcome
    }
    try {
      this.options.audit.record(entry)
    } catch (error) {
      this.options.logger.error(
        'audit.write.failed',
        `Writing an audit record failed: ${describeError(error)}`,
        { auditId: entry.auditId }
      )
    }
  }
}

function extractRequestId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = (raw as { requestId?: unknown }).requestId
  return typeof candidate === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : null
}

function describeActor(actor: Actor): string {
  switch (actor.type) {
    case 'user-interface':
      return 'The Jupiter window'
    case 'host':
      return 'The host process'
    case 'core':
      return 'Jupiter Core'
    default:
      return `A ${actor.type}`
  }
}
