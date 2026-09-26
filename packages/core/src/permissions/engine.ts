import {
  capabilityInfo,
  offeredDecisions,
  PERMISSION_CATALOGUE,
  type Actor,
  type ActorType,
  type DomainEventType,
  type EventPayload,
  type PermissionAuditEntry,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionRequest,
  type PermissionSubject,
  type RiskLevel
} from '@jupiter/contracts'
import { redactString } from '@jupiter/security'
import { JupiterError } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort } from '../ports'

/**
 * The Permission Engine (SET 7): one place that decides whether an action
 * with an effect may happen.
 *
 * - Deny by default. An action is allowed only by a grant that matches its
 *   capability, requester, exact target (or a prefix ending in `*`),
 *   Mission, session and expiry.
 * - `ALLOW_ONCE` is used up by the first action it allows. `ALLOW_SESSION`
 *   ends with this Core session. `ALWAYS_ALLOW` stays until revoked.
 * - CRITICAL actions ask every time: only a single-use grant can allow
 *   them, and Always allow is never offered.
 * - Automation needs a fresh answer for every HIGH or CRITICAL action (the
 *   checkpoint).
 * - Grants come only from the person (`user-interface`), answering a
 *   request Core made, or from Jupiter's default policy, which is visible
 *   and revocable. Nothing in content — a page, a document, a model's
 *   answer — reaches this code as an actor, so it cannot change policy.
 * - Every evaluation, request, decision and grant change is written to an
 *   append-only audit trail, with targets and reasons redacted.
 */

export interface PermissionCheck {
  readonly capability: string
  readonly subject: PermissionSubject
  /** Who set the work in motion. */
  readonly actor: ActorType
  readonly target: string
  /** Why it is needed (untrusted text: stored redacted, shown as text). */
  readonly reason: string
  readonly missionId?: string | null
  readonly missionTitle?: string | null
  readonly stepId?: string | null
  readonly stepTitle?: string | null
  readonly skillId?: string | null
  /** False: never ask the person. */
  readonly askIfNeeded: boolean
  /** Only look (a health check): a single-use grant is not used up. */
  readonly evaluateOnly?: boolean
}

export type PermissionOutcome =
  | { readonly allowed: true; readonly grantId: string }
  | {
      readonly allowed: false
      readonly code: 'PERMISSION_UNKNOWN' | 'PERMISSION_REQUIRED'
      readonly message: string
      readonly requestId: string | null
    }

export interface DefaultGrant {
  readonly capability: string
  readonly subject: PermissionSubject
  readonly target: string
  readonly reason: string
}

export interface PermissionEngineOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  /** This Core session: session grants end with it. */
  readonly sessionId: string
}

const PERSON: ActorType = 'user-interface'

export class PermissionEngine {
  private readonly listeners = new Set<(request: PermissionRequest) => void>()

  constructor(private readonly options: PermissionEngineOptions) {}

  get sessionId(): string {
    return this.options.sessionId
  }

  /** Notified after the person answers a request (the Mission Manager resumes or fails a step). */
  onDecided(listener: (request: PermissionRequest) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---- lifecycle --------------------------------------------------------------------------

  /**
   * At Core start: requests and session grants of earlier sessions expire,
   * and Jupiter's default grants are created once. A default the person
   * revoked is not created again.
   */
  start(defaults: readonly DefaultGrant[]): void {
    const database = this.options.database()
    const store = database.permissions
    database.transactions.run(() => {
      for (const request of store.pendingFromOtherSessions(this.sessionId)) {
        store.updateRequest(request.requestId, {
          status: 'EXPIRED',
          decision: null,
          decidedAt: this.now()
        })
        this.audit({
          action: 'request-expired',
          capability: request.capability,
          subject: request.subject,
          target: request.target,
          outcome: 'EXPIRED',
          detail: 'Jupiter Core restarted before it was answered.',
          actor: 'core',
          missionId: request.missionId,
          requestId: request.requestId
        })
      }
      for (const grant of store.sessionGrantsOutside(this.sessionId))
        this.endGrant(grant, 'EXPIRED', 'The session it was given for has ended.', 'core')
      for (const item of defaults) {
        if (!capabilityInfo(item.capability)) continue
        if (store.everGranted(item.capability, item.subject.kind, item.subject.id, 'core')) continue
        const grant: PermissionGrant = {
          grantId: uuidv7(),
          capability: item.capability,
          subject: item.subject,
          target: item.target,
          missionId: null,
          kind: 'ALWAYS_ALLOW',
          sessionId: null,
          state: 'ACTIVE',
          createdBy: 'core',
          requestId: null,
          reason: item.reason.slice(0, 300),
          createdAt: this.now(),
          expiresAt: null,
          usedAt: null,
          endedAt: null
        }
        store.insertGrant(grant)
        this.audit({
          action: 'grant-created',
          capability: grant.capability,
          subject: grant.subject,
          target: grant.target,
          outcome: 'ALWAYS_ALLOW',
          detail: `Default policy: ${grant.reason}`,
          actor: 'core',
          grantId: grant.grantId
        })
      }
    })
  }

  // ---- decisions --------------------------------------------------------------------------

  /**
   * May this action happen now? Allowed only by a matching grant (a
   * single-use grant is used up here). Otherwise it is refused, and, when
   * `askIfNeeded`, a request is put to the person.
   */
  check(check: PermissionCheck): PermissionOutcome {
    const database = this.options.database()
    const info = capabilityInfo(check.capability)
    if (!info) {
      database.transactions.run(() => {
        this.audit({
          action: 'refused',
          capability: check.capability,
          subject: check.subject,
          target: check.target,
          outcome: 'DENIED',
          detail: 'Unknown capability: denied by default.',
          actor: check.actor,
          missionId: check.missionId ?? null
        })
      })
      return {
        allowed: false,
        code: 'PERMISSION_UNKNOWN',
        message: `"${check.capability}" is not a capability Jupiter knows, so it is denied.`,
        requestId: null
      }
    }
    return database.transactions.run((): PermissionOutcome => {
      const store = database.permissions
      const candidates = store
        .activeGrants(check.capability, check.subject.kind, check.subject.id)
        .filter((grant) => this.matches(grant, check, info.risk))
      // Prefer a standing grant; a single-use grant is kept for when it is the only one.
      const grant =
        candidates.find((item) => item.kind !== 'ALLOW_ONCE') ??
        candidates.find((item) => item.kind === 'ALLOW_ONCE')
      if (grant) {
        if (grant.kind === 'ALLOW_ONCE' && !check.evaluateOnly)
          this.endGrant(grant, 'USED', 'Used once.', check.actor)
        this.audit({
          action: 'evaluated',
          capability: check.capability,
          subject: check.subject,
          target: check.target,
          outcome: 'ALLOWED',
          detail: `${check.evaluateOnly ? 'Health check: would be allowed' : 'Allowed'} by a ${grant.kind} grant.`,
          actor: check.actor,
          missionId: check.missionId ?? null,
          grantId: grant.grantId
        })
        return { allowed: true, grantId: grant.grantId }
      }
      let requestId: string | null = null
      if (check.askIfNeeded) requestId = this.ask(check, info.risk).requestId
      this.audit({
        action: 'evaluated',
        capability: check.capability,
        subject: check.subject,
        target: check.target,
        outcome: check.askIfNeeded ? 'ASKED' : 'DENIED',
        detail: 'No grant matches; denied until the person answers.',
        actor: check.actor,
        missionId: check.missionId ?? null,
        requestId
      })
      return {
        allowed: false,
        code: 'PERMISSION_REQUIRED',
        message: `${check.subject.name} needs permission to ${info.summary.toLowerCase()} (${check.capability} on ${check.target}).`,
        requestId
      }
    })
  }

  /** The person's answer. Only a pending request of this session, and only an offered answer. */
  decide(requestId: string, decision: PermissionDecision, actor: Actor): PermissionRequest {
    this.requirePerson(actor, 'answer permission requests')
    const database = this.options.database()
    const store = database.permissions
    const request = store.request(requestId)
    if (!request)
      throw new JupiterError(
        'PERMISSION_REQUEST_NOT_FOUND',
        'That permission request does not exist.',
        {
          category: 'validation',
          userAction: 'Reload the list of requests.'
        }
      )
    if (request.status !== 'PENDING')
      throw new JupiterError(
        'PERMISSION_REQUEST_CLOSED',
        `That permission request is already ${request.status.toLowerCase()}.`,
        { category: 'validation', userAction: 'Reload the list of requests.' }
      )
    if (!request.offered.includes(decision))
      throw new JupiterError(
        'PERMISSION_DECISION_NOT_OFFERED',
        `“${decision}” is not an answer this request offers (${request.offered.join(', ')}).`,
        { category: 'validation', userAction: 'Choose one of the offered answers.' }
      )
    const decidedAt = this.now()
    let grantId: string | null = null
    database.transactions.run(() => {
      store.updateRequest(requestId, {
        status: decision === 'DENY' ? 'DENIED' : 'ALLOWED',
        decision,
        decidedAt
      })
      this.audit({
        action: 'decided',
        capability: request.capability,
        subject: request.subject,
        target: request.target,
        outcome: decision,
        detail: 'Answered by the person.',
        actor: actor.type,
        missionId: request.missionId,
        requestId
      })
      if (decision !== 'DENY') {
        const grant: PermissionGrant = {
          grantId: uuidv7(),
          capability: request.capability,
          subject: request.subject,
          target: request.target,
          // A single-use answer is for this Mission only; standing grants are for the requester.
          missionId: decision === 'ALLOW_ONCE' ? request.missionId : null,
          kind: decision,
          sessionId: decision === 'ALLOW_SESSION' ? this.sessionId : null,
          state: 'ACTIVE',
          createdBy: actor.type,
          requestId,
          reason: redactString(request.reason, 300),
          createdAt: decidedAt,
          expiresAt: null,
          usedAt: null,
          endedAt: null
        }
        store.insertGrant(grant)
        grantId = grant.grantId
        this.audit({
          action: 'grant-created',
          capability: grant.capability,
          subject: grant.subject,
          target: grant.target,
          outcome: grant.kind,
          detail: 'Given by the person in answer to a request.',
          actor: actor.type,
          missionId: grant.missionId,
          requestId,
          grantId
        })
      }
      this.publish(
        'requests',
        'permission.decided',
        { requestId, capability: request.capability, decision, grantId },
        actor
      )
    })
    const answered = store.request(requestId)
    if (!answered) throw new Error('permission request vanished')
    for (const listener of this.listeners) {
      try {
        listener(answered)
      } catch (error) {
        this.options.logger.error(
          'permission.listener.failed',
          `A listener failed after a permission answer: ${String(error)}`
        )
      }
    }
    return answered
  }

  revoke(grantId: string, actor: Actor): PermissionGrant {
    this.requirePerson(actor, 'revoke permissions')
    const database = this.options.database()
    const grant = database.permissions.grant(grantId)
    if (!grant)
      throw new JupiterError('PERMISSION_GRANT_NOT_FOUND', 'That permission does not exist.', {
        category: 'validation',
        userAction: 'Reload the list of permissions.'
      })
    if (grant.state !== 'ACTIVE')
      throw new JupiterError(
        'PERMISSION_GRANT_ENDED',
        `That permission has already ended (${grant.state.toLowerCase()}).`,
        { category: 'validation', userAction: 'Reload the list of permissions.' }
      )
    database.transactions.run(() => {
      this.endGrant(grant, 'REVOKED', 'Revoked by the person.', actor.type)
    })
    const revoked = database.permissions.grant(grantId)
    if (!revoked) throw new Error('permission grant vanished')
    return revoked
  }

  // ---- queries ----------------------------------------------------------------------------

  requests(options: { pendingOnly: boolean; missionId?: string | undefined; limit: number }) {
    return this.options.database().permissions.requests(options)
  }

  grants(options: { includeEnded: boolean; limit: number }) {
    return this.options.database().permissions.grants(options)
  }

  auditTrail(limit: number): PermissionAuditEntry[] {
    return this.options.database().permissions.audit(limit)
  }

  /** A standing (session or always) grant covers this capability for the subject, for some target. */
  hasStandingGrant(capability: string, subject: Pick<PermissionSubject, 'kind' | 'id'>): boolean {
    return this.options
      .database()
      .permissions.activeGrants(capability, subject.kind, subject.id)
      .some(
        (grant) =>
          grant.kind === 'ALWAYS_ALLOW' ||
          (grant.kind === 'ALLOW_SESSION' && grant.sessionId === this.sessionId)
      )
  }

  catalogue() {
    return Object.entries(PERMISSION_CATALOGUE).map(([capability, info]) => ({
      capability,
      risk: info.risk,
      summary: info.summary,
      consequence: info.consequence,
      reversible: info.reversible,
      dataLeavesDevice: info.dataLeavesDevice
    }))
  }

  // ---- internals --------------------------------------------------------------------------

  private matches(grant: PermissionGrant, check: PermissionCheck, risk: RiskLevel): boolean {
    if (grant.state !== 'ACTIVE') return false
    if (!targetMatches(grant.target, check.target)) return false
    if (grant.missionId !== null && grant.missionId !== (check.missionId ?? null)) return false
    if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= this.options.now().getTime())
      return false
    if (grant.kind === 'ALLOW_SESSION' && grant.sessionId !== this.sessionId) return false
    // CRITICAL asks every time; so does anything HIGH or above that an automation starts.
    const everyTime =
      risk === 'CRITICAL' ||
      ((check.actor === 'automation' || check.subject.kind === 'automation') && risk === 'HIGH')
    if (everyTime && grant.kind !== 'ALLOW_ONCE') return false
    return true
  }

  /** A pending request for this exact action, reused if one is already waiting. */
  private ask(check: PermissionCheck, risk: RiskLevel): PermissionRequest {
    const store = this.options.database().permissions
    // A target that contains a secret is stored and shown redacted. A grant for
    // it then never equals the real target, so such an action asks every time.
    const target = redactString(check.target, 500)
    const waiting = store
      .requests({ pendingOnly: true, limit: 200 })
      .find(
        (request) =>
          request.capability === check.capability &&
          request.subject.kind === check.subject.kind &&
          request.subject.id === check.subject.id &&
          request.target === target &&
          request.missionId === (check.missionId ?? null) &&
          request.stepId === (check.stepId ?? null)
      )
    if (waiting) return waiting
    const info = capabilityInfo(check.capability)
    if (!info) throw new Error('unknown capability')
    const request: PermissionRequest = {
      requestId: uuidv7(),
      capability: check.capability,
      subject: check.subject,
      actor: check.actor,
      target,
      reason: redactString(check.reason, 500),
      risk,
      summary: info.summary,
      consequence: info.consequence,
      reversible: info.reversible,
      dataLeavesDevice: info.dataLeavesDevice,
      missionId: check.missionId ?? null,
      missionTitle: check.missionTitle?.slice(0, 120) ?? null,
      stepId: check.stepId ?? null,
      stepTitle: check.stepTitle?.slice(0, 200) ?? null,
      skillId: check.skillId ?? null,
      offered: offeredDecisions(risk),
      status: 'PENDING',
      decision: null,
      createdAt: this.now(),
      decidedAt: null
    }
    store.insertRequest(request, this.sessionId)
    this.audit({
      action: 'requested',
      capability: request.capability,
      subject: request.subject,
      target: request.target,
      outcome: 'ASKED',
      detail: `Asked the person (offered: ${request.offered.join(', ')}).`,
      actor: check.actor,
      missionId: request.missionId,
      requestId: request.requestId
    })
    this.publish(
      'requests',
      'permission.requested',
      { requestId: request.requestId, capability: request.capability, risk },
      { type: 'core', id: 'core' }
    )
    return request
  }

  private endGrant(
    grant: PermissionGrant,
    state: 'USED' | 'EXPIRED' | 'REVOKED',
    detail: string,
    actor: ActorType
  ): void {
    const at = this.now()
    this.options.database().permissions.updateGrant(grant.grantId, {
      state,
      usedAt: state === 'USED' ? at : grant.usedAt,
      endedAt: at
    })
    this.audit({
      action:
        state === 'USED' ? 'grant-used' : state === 'EXPIRED' ? 'grant-expired' : 'grant-revoked',
      capability: grant.capability,
      subject: grant.subject,
      target: grant.target,
      outcome: state,
      detail,
      actor,
      missionId: grant.missionId,
      requestId: grant.requestId,
      grantId: grant.grantId
    })
    this.publish(
      'grants',
      'permission.grant_ended',
      { grantId: grant.grantId, capability: grant.capability, state },
      { type: actor, id: actor }
    )
  }

  private requirePerson(actor: Actor, what: string): void {
    if (actor.type !== PERSON)
      throw new JupiterError('PERMISSION_POLICY_LOCKED', `Only you can ${what}.`, {
        category: 'permission',
        userAction: null
      })
  }

  private audit(entry: {
    action: PermissionAuditEntry['action']
    capability: string
    subject: PermissionSubject | null
    target: string | null
    outcome: string
    detail: string
    actor: ActorType
    missionId?: string | null
    requestId?: string | null
    grantId?: string | null
  }): void {
    this.options.database().permissions.insertAudit({
      entryId: uuidv7(),
      at: this.now(),
      action: entry.action,
      capability: entry.capability.slice(0, 64),
      subjectKind: entry.subject?.kind ?? null,
      subjectId: entry.subject?.id ?? null,
      target: entry.target === null ? null : redactString(entry.target, 500),
      outcome: entry.outcome,
      detail: redactString(entry.detail, 300),
      actor: entry.actor,
      missionId: entry.missionId ?? null,
      requestId: entry.requestId ?? null,
      grantId: entry.grantId ?? null
    })
  }

  private publish<T extends DomainEventType>(
    stream: 'requests' | 'grants',
    type: T,
    payload: EventPayload<T>,
    actor: Actor
  ): void {
    this.options.bus.publish({
      type,
      stream: { kind: 'permission', id: stream },
      payload,
      persistent: true,
      correlationId: uuidv7(),
      actor,
      missionId: null,
      executionId: null
    })
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}

/** Exact match, or a grant target ending in `*` that is a prefix of the action's target. */
export function targetMatches(grantTarget: string, target: string): boolean {
  if (grantTarget.endsWith('*')) return target.startsWith(grantTarget.slice(0, -1))
  return grantTarget === target
}
