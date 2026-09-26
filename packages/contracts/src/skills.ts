import { z } from 'zod'
import { ActorType, RiskLevel } from './actor'
import { ErrorEnvelope } from './errors'
import { PermissionName, SkillId } from './plans'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Skills (SET 6).
 *
 * A Skill is a typed, cancellable, permission-declared capability that Jupiter
 * Core can execute, not a prompt snippet. Its definition is data: input and
 * output are described with a JSON Schema subset (`SkillSchema`), so they can
 * be validated, stored, shown and used to build a test form. What a Skill may
 * touch is decided by the invocation context (the permissions Core grants),
 * never by the Skill.
 */

/** The JSON Schema subset Skills use for input and output. */
export interface SkillSchema {
  readonly type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  readonly description?: string | undefined
  readonly properties?: Readonly<Record<string, SkillSchema>> | undefined
  readonly required?: readonly string[] | undefined
  /** `false`: fields not listed in `properties` are rejected. */
  readonly additionalProperties?: boolean | undefined
  readonly items?: SkillSchema | undefined
  readonly enum?: readonly (string | number)[] | undefined
  readonly minLength?: number | undefined
  readonly maxLength?: number | undefined
  readonly minimum?: number | undefined
  readonly maximum?: number | undefined
  readonly maxItems?: number | undefined
}

export const SkillSchema: z.ZodType<SkillSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(['object', 'string', 'number', 'integer', 'boolean', 'array']),
      description: z.string().max(300).optional(),
      properties: z
        .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), SkillSchema)
        .optional(),
      required: z.array(z.string().max(64)).max(64).optional(),
      additionalProperties: z.boolean().optional(),
      items: SkillSchema.optional(),
      enum: z
        .array(z.union([z.string().max(200), z.number()]))
        .min(1)
        .max(100)
        .optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().max(1_000_000).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      maxItems: z.number().int().nonnegative().max(10_000).optional()
    })
    .strict()
)

export const SkillVersion = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/, 'Expected a version such as "1.0.0"')
export type SkillVersion = z.infer<typeof SkillVersion>

export const SkillCategory = z.enum(['text', 'system', 'information', 'developer'])
export type SkillCategory = z.infer<typeof SkillCategory>

/** Who provides the Skill: built into Jupiter, or registered by a test harness. Plugins arrive in SET 15. */
export const SkillProvider = z.enum(['internal', 'test-fixture'])
export type SkillProvider = z.infer<typeof SkillProvider>

/** The runtime a Skill needs. This build provides `sandbox@1`: an isolated worker per invocation. */
export const SKILL_RUNTIME = 'sandbox@1'
export const SkillRuntime = z.string().regex(/^[a-z][a-z0-9-]*@\d+$/)

export const SkillDefinition = z
  .object({
    skillId: SkillId,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    version: SkillVersion,
    inputSchema: SkillSchema,
    outputSchema: SkillSchema,
    permissions: z.array(PermissionName).max(10),
    /** Upper bound for one invocation; an invocation may ask for less, never more. */
    timeoutMs: z.number().int().min(100).max(600_000),
    category: SkillCategory,
    provider: SkillProvider,
    compatibleRuntime: SkillRuntime
  })
  .strict()
export type SkillDefinition = z.infer<typeof SkillDefinition>

/**
 * Permissions Skills may declare in this build. Core grants a permission to
 * an invocation only when it is `grantable` here: low-risk and read-only.
 * Everything else waits for the Permission Engine (SET 7).
 */
export const SKILL_PERMISSIONS = {
  'app.version.read': { risk: 'LOW', grantable: true },
  'system.time.read': { risk: 'LOW', grantable: true },
  'skills.read': { risk: 'LOW', grantable: true },
  'files.read': { risk: 'MEDIUM', grantable: false },
  'files.write': { risk: 'HIGH', grantable: false },
  'network.request': { risk: 'MEDIUM', grantable: false },
  'shell.execute': { risk: 'CRITICAL', grantable: false }
} as const satisfies Record<string, { risk: RiskLevel; grantable: boolean }>
export type KnownSkillPermission = keyof typeof SKILL_PERMISSIONS

export const SkillResultStatus = z.enum([
  'SUCCESS',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'WAITING_APPROVAL',
  'WAITING_IDENTITY'
])
export type SkillResultStatus = z.infer<typeof SkillResultStatus>

/** A stored execution is RUNNING until it ends with one of the result statuses. */
export const SkillExecutionStatus = z.enum(['RUNNING', ...SkillResultStatus.options])
export type SkillExecutionStatus = z.infer<typeof SkillExecutionStatus>

export const SkillArtifact = z
  .object({ title: z.string().min(1).max(200), text: z.string().max(200_000) })
  .strict()

export const SkillResult = z
  .object({
    executionId: Uuidv7,
    skillId: SkillId,
    version: SkillVersion,
    status: SkillResultStatus,
    output: z.unknown(),
    error: ErrorEnvelope.nullable(),
    artifacts: z.array(SkillArtifact).max(20),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp,
    /** What a caller can check about the output, e.g. "output.text equals input.text". */
    verificationHints: z.array(z.string().max(200)).max(10)
  })
  .strict()
export type SkillResult = z.infer<typeof SkillResult>

/**
 * What is kept about a value: its shape and size, never its content, so
 * execution history cannot hold a secret someone typed.
 */
export const ValueSummary = z
  .object({
    type: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null', 'other']),
    /** String length, array length, or number of fields. */
    size: z.number().int().nonnegative().nullable(),
    /** Field names of an object (never their values). */
    fields: z.array(z.string().max(64)).max(32)
  })
  .strict()
export type ValueSummary = z.infer<typeof ValueSummary>

export const SkillExecutionRecord = z
  .object({
    executionId: Uuidv7,
    skillId: SkillId,
    version: SkillVersion,
    missionId: Uuidv7.nullable(),
    actor: ActorType,
    status: SkillExecutionStatus,
    permissionsGranted: z.array(PermissionName).max(10),
    inputSummary: ValueSummary,
    outputSummary: ValueSummary.nullable(),
    errorCode: z.string().max(64).nullable(),
    idempotencyKey: z.string().max(128).nullable(),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp.nullable()
  })
  .strict()
export type SkillExecutionRecord = z.infer<typeof SkillExecutionRecord>

export const SkillHealthStatus = z.enum(['HEALTHY', 'UNHEALTHY', 'UNKNOWN'])
export type SkillHealthStatus = z.infer<typeof SkillHealthStatus>

export const SkillHealth = z
  .object({
    status: SkillHealthStatus,
    detail: z.string().max(500),
    checkedAt: UtcTimestamp.nullable(),
    durationMs: z.number().int().nonnegative().nullable()
  })
  .strict()
export type SkillHealth = z.infer<typeof SkillHealth>

export const SkillPermissionInfo = z
  .object({ name: PermissionName, risk: RiskLevel, grantable: z.boolean() })
  .strict()

/** A registered Skill as the Skill Center shows it. */
export const SkillInfo = z
  .object({
    definition: SkillDefinition,
    enabled: z.boolean(),
    health: SkillHealth,
    /** The runtime this build provides, and whether the Skill can run on it. */
    runtime: z.string().max(40),
    runtimeCompatible: z.boolean(),
    permissions: z.array(SkillPermissionInfo).max(10),
    /** Every registered version, newest first. */
    versions: z.array(SkillVersion).max(50),
    /** Low-risk internal Skill whose permissions Core can grant: the safe test form is offered. */
    testable: z.boolean(),
    /** Why it cannot run now, if it cannot (disabled, unhealthy, incompatible, permission). */
    blockedReason: z.string().max(300).nullable(),
    registeredAt: UtcTimestamp
  })
  .strict()
export type SkillInfo = z.infer<typeof SkillInfo>

export const SkillFilter = z
  .object({
    query: z.string().trim().max(100).optional(),
    category: SkillCategory.optional(),
    provider: SkillProvider.optional(),
    enabled: z.boolean().optional(),
    health: SkillHealthStatus.optional()
  })
  .strict()
export type SkillFilter = z.infer<typeof SkillFilter>
