import type { ErrorEnvelope, Plan, PlanDraft, PlanStep } from '@jupiter/contracts'
import { STEP_TYPES, type StepTypeDefinition } from './catalogue'

/**
 * The Planner's inputs and Jupiter's template plan (SET 5).
 *
 * The model planner asks the configured chat model for a plan as one JSON
 * object; Core parses it against the strict schema and validates it before
 * anything runs (validate.ts). The planner is asked for a short rationale,
 * never for its reasoning, and nothing but the validated plan is stored.
 */

/** Jupiter's standard answer plan, in the SET 5 plan schema. */
export function templatePlanDraft(request: string): PlanDraft {
  const answer: PlanStep = {
    id: 'answer',
    title: 'Answer the request with the chat model',
    description: 'The configured chat model answers the request.',
    skillId: 'model.generate',
    dependencies: [],
    input: { prompt: request },
    condition: null,
    timeoutMs: 180_000,
    retryPolicy: { maxAttempts: 2, backoffMs: 1_000, multiplier: 2 },
    verification: { check: 'non-empty' },
    required: true
  }
  const summary: PlanStep = {
    id: 'summary',
    title: 'Write a one-line summary of the answer',
    description: 'The chat model summarises the answer in one sentence.',
    skillId: 'model.generate',
    dependencies: ['answer'],
    input: { prompt: 'Summarise the following answer in one sentence.\n\n{{answer}}' },
    condition: null,
    timeoutMs: 120_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
    verification: null,
    required: false
  }
  return {
    goal: request.length > 300 ? `${request.slice(0, 297)}…` : request,
    assumptions: [],
    rationale:
      'Jupiter’s standard answer plan: the chat model answers, writes an optional one-line summary, and the answer is checked.',
    steps: [answer, summary],
    requiredSkills: ['model.generate'],
    requiredPermissions: [],
    expectedArtifacts: [
      { step: 'answer', description: 'The answer' },
      { step: 'summary', description: 'A one-line summary' }
    ],
    verificationPlan: {
      checks: [{ step: 'answer', check: 'non-empty', description: 'An answer was produced' }]
    }
  }
}

export interface PlannerInput {
  readonly request: string
  /** The plan this one revises, if any. */
  readonly previous: Plan | null
  /** Why the previous plan did not finish, if it did not. */
  readonly failure: { readonly step: string | null; readonly error: ErrorEnvelope } | null
  /** The person's corrections, e.g. to an assumption. */
  readonly feedback: string | null
}

/** The instructions and request sent to the planning model. */
export function plannerMessages(
  input: PlannerInput,
  types: readonly StepTypeDefinition[] = STEP_TYPES
): { system: string; user: string } {
  const available = types.filter((type) => type.available)
  const catalogue = available
    .map(
      (type) =>
        `- ${type.skillId}: ${type.description}${type.permissions.length > 0 ? ` Permissions: ${type.permissions.join(', ')}.` : ''} Inputs: ${type.inputs
          .map((field) => `${field.name}${field.required ? '' : ' (optional)'}`)
          .join(', ')}. Minimum timeoutMs ${String(type.minTimeoutMs)}.`
    )
    .join('\n')
  const system = [
    'You are the planner of Jupiter, a desktop assistant. Turn the request into a workflow plan.',
    'Reply with exactly one JSON object and nothing else: no prose, no markdown, no reasoning.',
    'The object has exactly these fields:',
    '{"goal": string (≤300 chars), "assumptions": string[] (≤8, each ≤200 chars, short and correctable),',
    ' "rationale": string (≤500 chars: why this plan, in a sentence or two),',
    ' "steps": Step[] (1–20), "requiredSkills": string[] (every skillId the steps use),',
    ' "requiredPermissions": string[] (every permission the used skills list), "expectedArtifacts": [{"step": id, "description": string}],',
    ' "verificationPlan": {"checks": [{"step": id, "check": "non-empty" | "contains", "value"?: string, "description": string}]}}',
    'Step = {"id": lowercase-id, "title": string, "description": string, "skillId": string,',
    ' "dependencies": ids of steps that must finish first, "input": object of strings,',
    ' "condition": null | {"step": id of a dependency, "outcome": "completed" | "failed"},',
    ' "timeoutMs": 1000–600000, "retryPolicy": {"maxAttempts": 1–5, "backoffMs": 0–60000, "multiplier": 1–4},',
    ' "verification": null | {"check": "non-empty" | "contains", "value"?: string}, "required": boolean}',
    'Steps without a dependency between them run in parallel. Use "{{step-id}}" inside an input to pass',
    'the output of a step it depends on. No cycles. Verify the output of at least one required step.',
    'Available skills (use only these):',
    catalogue
  ].join('\n')
  const parts = [`Request:\n${input.request}`]
  if (input.previous)
    parts.push(
      `This revises plan revision ${String(input.previous.revision)}:\n${JSON.stringify({
        goal: input.previous.goal,
        assumptions: input.previous.assumptions,
        steps: input.previous.steps.map((step) => ({
          id: step.id,
          title: step.title,
          skillId: step.skillId,
          dependencies: step.dependencies
        }))
      })}`
    )
  if (input.failure)
    parts.push(
      `It did not finish${input.failure.step ? `: step "${input.failure.step}" failed` : ''} (${input.failure.error.code}: ${input.failure.error.message}).`
    )
  if (input.feedback) parts.push(`Corrections from the person:\n${input.feedback}`)
  return { system, user: parts.join('\n\n') }
}
