import {
  SKILL_PERMISSIONS,
  SkillDefinition,
  type Actor,
  type DomainEventType,
  type ErrorCategory,
  type ErrorEnvelope,
  type EventPayload,
  type KnownSkillPermission,
  type SkillFilter,
  type SkillHealth,
  type SkillInfo,
  type SkillResult,
  type SkillResultStatus
} from '@jupiter/contracts'
import { redactString } from '@jupiter/security'
import { JupiterError, createErrorEnvelope, describeError } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort, SkillStateRecord } from '../ports'
import type { SkillImplementation } from './builtin'
import { ResourceDenied, type SkillSandbox } from './sandbox'
import { formatIssues, schemaDefinitionIssues, summarize, validateValue } from './schema-check'

/**
 * The Skill Registry (SET 6): register, unregister, get, search, enable,
 * disable, health check, invoke, cancel and list versions.
 *
 * - The invocation context grants capabilities, never the Skill. Core grants
 *   a declared permission only when it is low-risk and grantable in this
 *   build (`SKILL_PERMISSIONS`). Anything else is refused until the
 *   Permission Engine exists (SET 7).
 * - At run time a Skill reaches a resource only if it declared that
 *   resource's permission and the invocation was granted it. Any other
 *   attempt is denied, and the execution fails with `PERMISSION_DENIED`,
 *   whatever the Skill returns.
 * - Disabled, unhealthy, runtime-incompatible or missing Skills do not run.
 * - Input and output are validated against the Skill's schemas. Output that
 *   does not match fails the execution.
 * - Every invocation runs in the sandbox. Timeout and cancel end its
 *   runtime. A broken Skill returns a structured failure, and Core carries
 *   on.
 * - History keeps the shape and size of input and output, never content.
 */

export interface ResourceContext {
  readonly executionId: string
  readonly skillId: string
  readonly missionId: string | null
}

export interface SkillResource {
  readonly permission: KnownSkillPermission
  readonly handler: (args: unknown, context: ResourceContext) => unknown
}

export interface SkillRegistryOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly sandbox: SkillSandbox
  /** Resources Skills can `use`, each behind a permission. `skills.list` is provided by the registry. */
  readonly resources: Readonly<Record<string, SkillResource>>
}

export interface InvokeRequest {
  readonly executionId: string
  readonly skillId: string
  readonly version?: string | undefined
  readonly input: unknown
  readonly missionId?: string | null
  readonly timeoutMs?: number | undefined
  readonly idempotencyKey?: string | undefined
  readonly actor: Actor
  readonly correlationId: string
  readonly signal?: AbortSignal
}

const HEALTH_TIMEOUT_MS = 5_000
const CORE_ACTOR: Actor = { type: 'core', id: 'core' }

interface Running {
  readonly controller: AbortController
  cancelled: boolean
}

export class SkillRegistry {
  private readonly implementations = new Map<string, SkillImplementation>()
  private readonly running = new Map<string, Running>()

  constructor(private readonly options: SkillRegistryOptions) {}

  get runtime(): string {
    return this.options.sandbox.runtime
  }

  // ---- registration ------------------------------------------------------------------------

  /** Check a Skill's metadata; empty when it can be registered. */
  static definitionIssues(input: unknown): string[] {
    const parsed = SkillDefinition.safeParse(input)
    if (!parsed.success)
      return parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.map(String).join('.') || 'definition'}: ${issue.message}`)
    const definition = parsed.data
    const issues: string[] = []
    for (const [label, schema] of [
      ['inputSchema', definition.inputSchema],
      ['outputSchema', definition.outputSchema]
    ] as const) {
      if (schema.type !== 'object') issues.push(`${label} must describe an object`)
      for (const issue of schemaDefinitionIssues(schema, label))
        issues.push(`${issue.path}: ${issue.message}`)
    }
    for (const permission of definition.permissions)
      if (!(permission in SKILL_PERMISSIONS))
        issues.push(`permissions: "${permission}" is not a permission Jupiter knows`)
    if (new Set(definition.permissions).size !== definition.permissions.length)
      issues.push('permissions: a permission is listed twice')
    return issues
  }

  /** Register a Skill version. Invalid metadata or code is refused with the reasons. */
  register(implementation: SkillImplementation): SkillInfo {
    const issues = SkillRegistry.definitionIssues(implementation.definition)
    if (typeof implementation.source !== 'string' || !implementation.source.trim())
      issues.push('source: the Skill has no code')
    if (issues.length > 0)
      throw new JupiterError(
        'SKILL_INVALID',
        `The Skill was not registered: ${issues.join('; ')}`.slice(0, 1900),
        { category: 'validation', userAction: 'Correct the Skill definition.' }
      )
    const definition = SkillDefinition.parse(implementation.definition)
    const database = this.options.database()
    database.transactions.run(() => {
      database.skills.upsertSkill(definition, this.now())
      this.publish(
        definition.skillId,
        'skill.registered',
        { skillId: definition.skillId, version: definition.version },
        CORE_ACTOR,
        null
      )
    })
    this.implementations.set(key(definition.skillId, definition.version), {
      ...implementation,
      definition
    })
    return this.info(definition.skillId, definition.version)
  }

  unregister(skillId: string, version?: string): void {
    const versions = version ? [version] : this.registeredVersions(skillId)
    for (const item of versions) {
      this.implementations.delete(key(skillId, item))
      this.options.database().skills.markUnregistered(skillId, item, this.now())
    }
  }

  // ---- queries -----------------------------------------------------------------------------

  get(skillId: string, version?: string): SkillInfo {
    const resolved = this.resolveVersion(skillId, version)
    return this.info(skillId, resolved)
  }

  /** Latest registered version of each Skill, filtered and sorted by name. */
  search(filter: SkillFilter = {}): SkillInfo[] {
    const ids = [
      ...new Set([...this.implementations.values()].map((item) => item.definition.skillId))
    ]
    const query = filter.query?.toLowerCase() ?? ''
    return ids
      .map((skillId) => this.get(skillId))
      .filter((info) => {
        const { definition } = info
        if (filter.category && definition.category !== filter.category) return false
        if (filter.provider && definition.provider !== filter.provider) return false
        if (filter.enabled !== undefined && info.enabled !== filter.enabled) return false
        if (filter.health && info.health.status !== filter.health) return false
        if (!query) return true
        return [definition.skillId, definition.name, definition.description, definition.category]
          .join(' ')
          .toLowerCase()
          .includes(query)
      })
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
  }

  listVersions(skillId: string): SkillInfo[] {
    const versions = this.registeredVersions(skillId)
    if (versions.length === 0) throw notFound(skillId)
    return versions.map((version) => this.info(skillId, version))
  }

  executions(options: { skillId?: string | undefined; limit: number }) {
    return this.options.database().skills.executions(options)
  }

  // ---- state -------------------------------------------------------------------------------

  setEnabled(
    skillId: string,
    version: string | undefined,
    enabled: boolean,
    actor: Actor
  ): SkillInfo {
    const resolved = this.resolveVersion(skillId, version)
    const database = this.options.database()
    database.transactions.run(() => {
      database.skills.setEnabled(skillId, resolved, enabled)
      this.publish(
        skillId,
        'skill.state_changed',
        { skillId, version: resolved, enabled },
        actor,
        null
      )
    })
    return this.info(skillId, resolved)
  }

  /**
   * Check that a Skill can work: its runtime is this one, its permissions
   * are known and grantable, and a real run with its health input returns
   * valid output (the expected output, if it has one).
   */
  async healthCheck(
    skillId: string,
    version: string | undefined,
    actor: Actor
  ): Promise<SkillInfo> {
    const resolved = this.resolveVersion(skillId, version)
    const implementation = this.implementation(skillId, resolved)
    const started = performance.now()
    const health = await this.probe(implementation)
    const recorded: SkillHealth = {
      ...health,
      checkedAt: this.now(),
      durationMs: Math.round(performance.now() - started)
    }
    const database = this.options.database()
    database.transactions.run(() => {
      database.skills.setHealth(skillId, resolved, recorded)
      this.publish(
        skillId,
        'skill.health_checked',
        { skillId, version: resolved, status: recorded.status, detail: recorded.detail },
        actor,
        null
      )
    })
    return this.info(skillId, resolved)
  }

  // ---- execution ---------------------------------------------------------------------------

  /** Run a Skill. Always returns a result; only a missing Skill or a repeated key is refused. */
  async invoke(request: InvokeRequest): Promise<SkillResult> {
    const database = this.options.database()
    const version = this.resolveVersion(request.skillId, request.version)
    const implementation = this.implementation(request.skillId, version)
    const { definition } = implementation
    if (request.idempotencyKey) {
      const previous = database.skills.executionByKey(request.skillId, request.idempotencyKey)
      if (previous)
        throw new JupiterError(
          'SKILL_DUPLICATE_INVOCATION',
          `This invocation was already made (execution ${previous.executionId}, ${previous.status}); it is not run twice.`,
          { category: 'validation', userAction: 'Use a new idempotency key to run it again.' }
        )
    }
    if (this.running.has(request.executionId) || database.skills.execution(request.executionId))
      throw new JupiterError('SKILL_EXECUTION_EXISTS', 'That execution id is already used.', {
        category: 'validation',
        userAction: 'Start the invocation with a new execution id.'
      })

    const startedAt = this.now()
    const granted = definition.permissions.filter((permission) => grantable(permission))
    const record = {
      executionId: request.executionId,
      skillId: definition.skillId,
      version,
      missionId: request.missionId ?? null,
      actor: request.actor.type,
      permissionsGranted: granted,
      inputSummary: summarize(request.input),
      idempotencyKey: request.idempotencyKey ?? null,
      startedAt
    }

    // Checks before anything runs. A refused invocation is still recorded.
    const refusal = this.refusalFor(implementation, request.input)
    if (refusal) {
      database.transactions.run(() => {
        database.skills.insertExecution({
          ...record,
          status: 'FAILED',
          outputSummary: null,
          errorCode: refusal.code,
          completedAt: startedAt
        })
        this.publish(
          definition.skillId,
          'skill.execution_finished',
          {
            executionId: request.executionId,
            skillId: definition.skillId,
            version,
            status: 'FAILED',
            errorCode: refusal.code
          },
          request.actor,
          request.missionId ?? null,
          request.correlationId
        )
      })
      return this.result(implementation, request.executionId, startedAt, 'FAILED', null, refusal)
    }

    database.transactions.run(() => {
      database.skills.insertExecution({
        ...record,
        status: 'RUNNING',
        outputSummary: null,
        errorCode: null,
        completedAt: null
      })
      this.publish(
        definition.skillId,
        'skill.execution_started',
        { executionId: request.executionId, skillId: definition.skillId, version },
        request.actor,
        request.missionId ?? null,
        request.correlationId
      )
    })

    const running: Running = { controller: new AbortController(), cancelled: false }
    this.running.set(request.executionId, running)
    const forward = () => {
      running.cancelled = true
      running.controller.abort()
    }
    request.signal?.addEventListener('abort', forward, { once: true })
    if (request.signal?.aborted) forward()
    const violations: string[] = []
    const timeoutMs = Math.min(request.timeoutMs ?? definition.timeoutMs, definition.timeoutMs)
    let status: SkillResultStatus
    let output: unknown = null
    let error: ErrorEnvelope | null = null
    try {
      const outcome = await this.options.sandbox.run({
        source: implementation.source,
        input: request.input,
        timeoutMs,
        signal: running.controller.signal,
        useResource: (resource, args) =>
          this.useResource(resource, args, definition, granted, violations, {
            executionId: request.executionId,
            skillId: definition.skillId,
            missionId: request.missionId ?? null
          })
      })
      switch (outcome.kind) {
        case 'completed': {
          const issues = validateValue(definition.outputSchema, outcome.output, 'output')
          if (violations.length > 0) {
            status = 'FAILED'
            error = this.error(
              'PERMISSION_DENIED',
              'permission',
              `${definition.name} tried to use ${violations.join(', ')} without permission, so its result is not used.`,
              'Report this Skill; it asks for access it did not declare.',
              false,
              request
            )
          } else if (issues.length > 0) {
            status = 'FAILED'
            error = this.error(
              'SKILL_OUTPUT_INVALID',
              'internal',
              `${definition.name} returned output that does not match its output schema: ${formatIssues(issues)}`,
              'Report this Skill; its output is not what it promises.',
              false,
              request
            )
          } else {
            status = 'SUCCESS'
            output = outcome.output
          }
          break
        }
        case 'failed':
          status = 'FAILED'
          error = this.error(
            violations.length > 0
              ? 'PERMISSION_DENIED'
              : outcome.code && /^[A-Z][A-Z0-9_]{1,63}$/.test(outcome.code)
                ? outcome.code
                : 'SKILL_FAILED',
            violations.length > 0 ? 'permission' : 'internal',
            `${definition.name} failed: ${redactString(outcome.message, 500)}`,
            'Try again. If it keeps failing, disable the Skill.',
            true,
            request
          )
          break
        case 'timed-out':
          status = 'TIMEOUT'
          error = this.error(
            'SKILL_TIMEOUT',
            'timeout',
            `${definition.name} did not finish within ${String(timeoutMs)} ms and was stopped.`,
            'Try again, or with less input.',
            true,
            request
          )
          break
        case 'cancelled':
          status = 'CANCELLED'
          error = this.error(
            'CANCELLED',
            'cancellation',
            `${definition.name} was cancelled and stopped.`,
            null,
            true,
            request
          )
          break
        case 'crashed':
          status = 'FAILED'
          error = this.error(
            'SKILL_CRASHED',
            'internal',
            `${definition.name} stopped unexpectedly: ${redactString(outcome.message, 400)}`,
            'Try again. If it keeps failing, disable the Skill.',
            true,
            request
          )
          break
      }
    } catch (failure) {
      // The sandbox itself failed; Core stays up and says so.
      this.options.logger.error('skill.sandbox.failed', describeError(failure))
      status = 'FAILED'
      error = this.error(
        'SKILL_RUNTIME_UNAVAILABLE',
        'internal',
        `The Skill runtime could not run ${definition.name}: ${redactString(describeError(failure), 400)}`,
        'Restart Jupiter.',
        true,
        request
      )
    } finally {
      this.running.delete(request.executionId)
      request.signal?.removeEventListener('abort', forward)
    }

    const completedAt = this.now()
    database.transactions.run(() => {
      database.skills.finishExecution(request.executionId, {
        status,
        outputSummary: status === 'SUCCESS' ? summarize(output) : null,
        errorCode: error?.code ?? null,
        completedAt
      })
      this.publish(
        definition.skillId,
        'skill.execution_finished',
        {
          executionId: request.executionId,
          skillId: definition.skillId,
          version,
          status,
          errorCode: error?.code ?? null
        },
        request.actor,
        request.missionId ?? null,
        request.correlationId
      )
    })
    return this.result(
      implementation,
      request.executionId,
      startedAt,
      status,
      output,
      error,
      completedAt
    )
  }

  /** Cancel a running invocation: its runtime is ended. False when it is not running. */
  cancel(executionId: string): boolean {
    const running = this.running.get(executionId)
    if (!running) return false
    running.cancelled = true
    running.controller.abort()
    return true
  }

  get activeCount(): number {
    return this.running.size
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Register Skills, record executions a Core stop cut off, and check every Skill's health. */
  async start(implementations: readonly SkillImplementation[]): Promise<void> {
    const database = this.options.database()
    for (const record of database.skills.running())
      database.skills.finishExecution(record.executionId, {
        status: 'FAILED',
        outputSummary: null,
        errorCode: 'SKILL_INTERRUPTED',
        completedAt: this.now()
      })
    for (const implementation of implementations) this.register(implementation)
    for (const implementation of this.implementations.values())
      await this.healthCheck(
        implementation.definition.skillId,
        implementation.definition.version,
        CORE_ACTOR
      )
  }

  stopAll(): void {
    for (const running of this.running.values()) {
      running.cancelled = true
      running.controller.abort()
    }
  }

  // ---- internals ---------------------------------------------------------------------------

  private refusalFor(implementation: SkillImplementation, input: unknown): ErrorEnvelope | null {
    const { definition } = implementation
    const state = this.state(definition.skillId, definition.version)
    const fail = (code: string, category: ErrorCategory, message: string, action: string | null) =>
      createErrorEnvelope({
        code,
        category,
        message,
        userAction: action,
        retryable: false,
        now: this.options.now()
      })
    if (!state.enabled)
      return fail(
        'SKILL_DISABLED',
        'configuration',
        `${definition.name} is disabled.`,
        'Enable it in Skills.'
      )
    if (definition.compatibleRuntime !== this.runtime)
      return fail(
        'SKILL_INCOMPATIBLE',
        'unsupported',
        `${definition.name} needs the runtime ${definition.compatibleRuntime}; this build provides ${this.runtime}.`,
        'Use a version of the Skill made for this runtime.'
      )
    if (state.health.status === 'UNHEALTHY')
      return fail(
        'SKILL_UNHEALTHY',
        'dependency',
        `${definition.name} failed its last health check: ${state.health.detail}`,
        'Run the health check again in Skills.'
      )
    const refused = definition.permissions.filter((permission) => !grantable(permission))
    if (refused.length > 0)
      return fail(
        'PERMISSION_NOT_GRANTED',
        'permission',
        `${definition.name} needs ${refused.join(', ')}, which cannot be granted until the Permission Engine arrives (SET 7).`,
        null
      )
    const issues = validateValue(definition.inputSchema, input, 'input')
    if (issues.length > 0)
      return fail(
        'SKILL_INPUT_INVALID',
        'validation',
        `The input does not match what ${definition.name} accepts: ${formatIssues(issues)}`,
        'Correct the input.'
      )
    return null
  }

  private async useResource(
    resource: string,
    args: unknown,
    definition: SkillDefinition,
    granted: readonly string[],
    violations: string[],
    context: ResourceContext
  ): Promise<unknown> {
    const provided =
      resource === 'skills.list'
        ? ({ permission: 'skills.read', handler: () => this.skillSummaries() } as const)
        : this.options.resources[resource]
    if (!provided) {
      violations.push(`the unknown resource "${resource}"`)
      throw new ResourceDenied('RESOURCE_UNKNOWN', `There is no resource "${resource}".`)
    }
    if (!definition.permissions.includes(provided.permission)) {
      violations.push(`"${resource}" (needs ${provided.permission})`)
      throw new ResourceDenied(
        'PERMISSION_NOT_DECLARED',
        `"${resource}" needs the permission ${provided.permission}, which this Skill did not declare.`
      )
    }
    if (!granted.includes(provided.permission)) {
      violations.push(`"${resource}" (${provided.permission} not granted)`)
      throw new ResourceDenied(
        'PERMISSION_NOT_GRANTED',
        `${provided.permission} was not granted to this invocation.`
      )
    }
    return await Promise.resolve(provided.handler(args, context))
  }

  private skillSummaries() {
    return this.search().map((info) => ({
      skillId: info.definition.skillId,
      name: info.definition.name,
      version: info.definition.version,
      enabled: info.enabled,
      health: info.health.status
    }))
  }

  private async probe(
    implementation: SkillImplementation
  ): Promise<Pick<SkillHealth, 'status' | 'detail'>> {
    const { definition } = implementation
    if (definition.compatibleRuntime !== this.runtime)
      return {
        status: 'UNHEALTHY',
        detail: `Needs the runtime ${definition.compatibleRuntime}; this build provides ${this.runtime}.`
      }
    const refused = definition.permissions.filter((permission) => !grantable(permission))
    if (refused.length > 0)
      return {
        status: 'UNKNOWN',
        detail: `Cannot be checked: it needs ${refused.join(', ')}, which cannot be granted before SET 7.`
      }
    if (implementation.healthInput === null)
      return {
        status: 'HEALTHY',
        detail: 'Definition and runtime checked; this Skill has no test run.'
      }
    const violations: string[] = []
    try {
      const outcome = await this.options.sandbox.run({
        source: implementation.source,
        input: implementation.healthInput,
        timeoutMs: Math.min(definition.timeoutMs, HEALTH_TIMEOUT_MS),
        signal: new AbortController().signal,
        useResource: (resource, args) =>
          this.useResource(resource, args, definition, definition.permissions, violations, {
            executionId: 'health-check',
            skillId: definition.skillId,
            missionId: null
          })
      })
      if (outcome.kind === 'timed-out')
        return { status: 'UNHEALTHY', detail: 'The test run did not finish in time.' }
      if (outcome.kind === 'crashed')
        return { status: 'UNHEALTHY', detail: `The test run crashed: ${outcome.message}` }
      if (outcome.kind === 'cancelled')
        return { status: 'UNKNOWN', detail: 'The test run was stopped.' }
      if (outcome.kind === 'failed')
        return {
          status: 'UNHEALTHY',
          detail: `The test run failed${outcome.code ? ` (${outcome.code})` : ''}: ${redactString(outcome.message, 300)}`
        }
      if (violations.length > 0)
        return {
          status: 'UNHEALTHY',
          detail: `It used ${violations.join(', ')} without permission.`
        }
      const issues = validateValue(definition.outputSchema, outcome.output, 'output')
      if (issues.length > 0)
        return {
          status: 'UNHEALTHY',
          detail: `Its output does not match its schema: ${formatIssues(issues)}`
        }
      if (
        implementation.healthExpect !== undefined &&
        JSON.stringify(outcome.output) !== JSON.stringify(implementation.healthExpect)
      )
        return {
          status: 'UNHEALTHY',
          detail: 'The test run returned a different result than expected.'
        }
      return { status: 'HEALTHY', detail: 'A test run returned valid output.' }
    } catch (failure) {
      return {
        status: 'UNHEALTHY',
        detail: `The runtime failed: ${describeError(failure)}`.slice(0, 500)
      }
    }
  }

  private info(skillId: string, version: string): SkillInfo {
    const implementation = this.implementation(skillId, version)
    const state = this.state(skillId, version)
    const { definition } = implementation
    const permissions = definition.permissions.map((name) => {
      const known = SKILL_PERMISSIONS[name as KnownSkillPermission] as
        (typeof SKILL_PERMISSIONS)[KnownSkillPermission] | undefined
      return { name, risk: known?.risk ?? 'CRITICAL', grantable: known?.grantable ?? false }
    })
    const runtimeCompatible = definition.compatibleRuntime === this.runtime
    const allGrantable = permissions.every((permission) => permission.grantable)
    const blockedReason = !state.enabled
      ? 'Disabled.'
      : !runtimeCompatible
        ? `Needs the runtime ${definition.compatibleRuntime}.`
        : state.health.status === 'UNHEALTHY'
          ? 'Its last health check failed.'
          : !allGrantable
            ? 'Needs permissions that cannot be granted before SET 7.'
            : null
    return {
      definition,
      enabled: state.enabled,
      health: state.health,
      runtime: this.runtime,
      runtimeCompatible,
      permissions,
      versions: this.registeredVersions(skillId),
      testable:
        definition.provider === 'internal' &&
        allGrantable &&
        permissions.every((permission) => permission.risk === 'LOW'),
      blockedReason,
      registeredAt: state.registeredAt
    }
  }

  private state(skillId: string, version: string): SkillStateRecord {
    const state = this.options.database().skills.skill(skillId, version)
    if (!state) throw notFound(skillId)
    return state
  }

  private implementation(skillId: string, version: string): SkillImplementation {
    const implementation = this.implementations.get(key(skillId, version))
    if (!implementation) throw notFound(skillId, version)
    return implementation
  }

  private registeredVersions(skillId: string): string[] {
    return this.options
      .database()
      .skills.versions(skillId)
      .map((state) => state.definition.version)
      .filter((version) => this.implementations.has(key(skillId, version)))
  }

  private resolveVersion(skillId: string, version: string | undefined): string {
    if (version) {
      if (!this.implementations.has(key(skillId, version))) throw notFound(skillId, version)
      return version
    }
    const latest = this.registeredVersions(skillId)[0]
    if (!latest) throw notFound(skillId)
    return latest
  }

  private result(
    implementation: SkillImplementation,
    executionId: string,
    startedAt: string,
    status: SkillResultStatus,
    output: unknown,
    error: ErrorEnvelope | null,
    completedAt = startedAt
  ): SkillResult {
    return {
      executionId,
      skillId: implementation.definition.skillId,
      version: implementation.definition.version,
      status,
      output: status === 'SUCCESS' ? output : null,
      error,
      artifacts: [],
      startedAt,
      completedAt,
      verificationHints: status === 'SUCCESS' ? [...implementation.verificationHints] : []
    }
  }

  private error(
    code: string,
    category: ErrorCategory,
    message: string,
    userAction: string | null,
    retryable: boolean,
    request: InvokeRequest
  ): ErrorEnvelope {
    return createErrorEnvelope({
      code,
      category,
      message,
      userAction,
      retryable,
      missionId: request.missionId ?? null,
      now: this.options.now()
    })
  }

  private publish<T extends DomainEventType>(
    skillId: string,
    type: T,
    payload: EventPayload<T>,
    actor: Actor,
    missionId: string | null,
    correlationId: string = uuidv7()
  ): void {
    this.options.bus.publish({
      type,
      stream: { kind: 'skill', id: skillId },
      payload,
      persistent: true,
      correlationId,
      actor,
      missionId,
      executionId: null
    })
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}

function grantable(permission: string): boolean {
  const known = SKILL_PERMISSIONS[permission as KnownSkillPermission] as
    (typeof SKILL_PERMISSIONS)[KnownSkillPermission] | undefined
  return known?.grantable ?? false
}

function key(skillId: string, version: string): string {
  return `${skillId}@${version}`
}

function notFound(skillId: string, version?: string): JupiterError {
  return new JupiterError(
    'SKILL_NOT_FOUND',
    `There is no Skill "${skillId}"${version ? ` version ${version}` : ''}.`,
    { category: 'validation', userAction: 'Choose a Skill from the Skills list.' }
  )
}
