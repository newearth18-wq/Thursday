import { z } from 'zod'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Plans (SET 5).
 *
 * A plan is what the Planner turns a Mission's request into, and the only
 * input the Workflow Engine accepts. What a model proposes is first parsed
 * against `PlanDraft` (strict: unknown fields are refused), then checked by
 * Core's plan validator (dependencies, cycles, step types, permissions,
 * timeouts, artifact references, verification). Only a plan that passes
 * both can run. Re-planning adds a new revision; earlier revisions are kept.
 *
 * Plans hold structured steps and a short rationale — never a model's hidden
 * reasoning.
 */

export const PlanId = Uuidv7

/** A step's id inside its plan, e.g. `read-doc`. */
export const PlanStepKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'Expected a short lowercase step id such as "summarise"')
export type PlanStepKey = z.infer<typeof PlanStepKey>

/** What a step does: a step type or Skill Jupiter can run, e.g. `model.generate` or `echo_text`. */
export const SkillId = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/,
    'Expected a skill id such as "model.generate" or "echo_text"'
  )
export type SkillId = z.infer<typeof SkillId>

/** A capability a step needs, e.g. `files.read` (see PERMISSION_CATALOGUE, SET 7). */
export const PermissionName = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*(?:\.[a-z0-9_-]+)+$/,
    'Expected a permission such as "files.read" or "computer.open_app"'
  )

export const RetryPolicy = z
  .object({
    /** Attempts in total, including the first. */
    maxAttempts: z.number().int().min(1).max(5),
    /** Wait before the second attempt; each later wait is multiplied by `multiplier`. */
    backoffMs: z.number().int().min(0).max(60_000),
    multiplier: z.number().min(1).max(4)
  })
  .strict()
export type RetryPolicy = z.infer<typeof RetryPolicy>

/** Run this step only if another step ended this way (conditional branching). */
export const StepCondition = z
  .object({ step: PlanStepKey, outcome: z.enum(['completed', 'failed']) })
  .strict()
export type StepCondition = z.infer<typeof StepCondition>

export const OutputCheck = z.enum(['non-empty', 'contains'])
export type OutputCheck = z.infer<typeof OutputCheck>

export const StepVerification = z
  .object({ check: OutputCheck, value: z.string().min(1).max(200).optional() })
  .strict()
export type StepVerification = z.infer<typeof StepVerification>

/** Input values may use `{{step-id}}` to pass another step's output into this one. */
export const PlanStep = z
  .object({
    id: PlanStepKey,
    title: z.string().min(1).max(120),
    description: z.string().max(500),
    skillId: SkillId,
    dependencies: z.array(PlanStepKey).max(20),
    input: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.string().max(8000)),
    condition: StepCondition.nullable(),
    /** Between 1 second and 10 minutes. */
    timeoutMs: z.number().int().min(1_000).max(600_000),
    retryPolicy: RetryPolicy,
    verification: StepVerification.nullable(),
    /** A required step that does not complete means the Mission cannot be COMPLETED. */
    required: z.boolean()
  })
  .strict()
export type PlanStep = z.infer<typeof PlanStep>

export const VerificationCheck = z
  .object({
    /** The step whose output is checked. */
    step: PlanStepKey,
    check: OutputCheck,
    value: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(200)
  })
  .strict()
export type VerificationCheck = z.infer<typeof VerificationCheck>

/** Exactly what a planning model must return. Anything else is rejected. */
export const PlanDraft = z
  .object({
    goal: z.string().min(1).max(300),
    /** Short, human-readable, and correctable by the person. */
    assumptions: z.array(z.string().min(1).max(200)).max(8),
    /** Why this plan, in at most a few sentences. Not a transcript of reasoning. */
    rationale: z.string().max(500),
    steps: z.array(PlanStep).min(1).max(20),
    requiredSkills: z.array(SkillId).max(20),
    requiredPermissions: z.array(PermissionName).max(20),
    expectedArtifacts: z
      .array(z.object({ step: PlanStepKey, description: z.string().min(1).max(200) }).strict())
      .max(20),
    verificationPlan: z.object({ checks: z.array(VerificationCheck).min(1).max(20) }).strict()
  })
  .strict()
export type PlanDraft = z.infer<typeof PlanDraft>

export const PlanSource = z.enum(['model', 'template'])
export type PlanSource = z.infer<typeof PlanSource>

export const Plan = PlanDraft.extend({
  planId: PlanId,
  missionId: Uuidv7,
  revision: z.number().int().positive(),
  previousPlanId: PlanId.nullable(),
  source: PlanSource,
  /** Why this revision exists: first plan, a correction, or the failure it answers. */
  reason: z.string().min(1).max(500),
  createdAt: UtcTimestamp
}).strict()
export type Plan = z.infer<typeof Plan>

export const PlanIssueCode = z.enum([
  'not-json',
  'schema',
  'duplicate-step',
  'missing-dependency',
  'cycle',
  'unknown-skill',
  'unavailable-skill',
  'skills-not-declared',
  'permissions-not-declared',
  'permission-unavailable',
  'invalid-timeout',
  'missing-input',
  'ambiguous-artifact',
  'invalid-condition',
  'no-verification',
  'invalid-verification'
])
export type PlanIssueCode = z.infer<typeof PlanIssueCode>

export const PlanIssue = z
  .object({
    code: PlanIssueCode,
    message: z.string().min(1).max(300),
    step: PlanStepKey.nullable()
  })
  .strict()
export type PlanIssue = z.infer<typeof PlanIssue>

/** A step type (skill) the Workflow Engine can run in this build. */
export const StepTypeInfo = z
  .object({
    skillId: SkillId,
    name: z.string().max(80),
    description: z.string().max(400),
    inputs: z
      .array(
        z
          .object({
            name: z.string().max(32),
            required: z.boolean(),
            description: z.string().max(200)
          })
          .strict()
      )
      .max(10),
    /** Whether it produces text output other steps can use. */
    producesOutput: z.boolean(),
    permissions: z.array(PermissionName).max(10),
    /** False when the step type exists but cannot run in this build (said why in `description`). */
    available: z.boolean()
  })
  .strict()
export type StepTypeInfo = z.infer<typeof StepTypeInfo>
