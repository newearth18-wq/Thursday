import { PlanDraft, PlanStepKey, type PlanIssue, type PlanStep } from '@jupiter/contracts'
import { stepType } from './catalogue'

/**
 * The plan validator (SET 5). A plan reaches the Workflow Engine only if
 * this finds nothing: model output is first parsed against the strict
 * `PlanDraft` schema, then checked for everything a schema cannot express.
 */

/** Longest a single step may take in the worst case, with every retry and wait. */
export const MAX_STEP_BUDGET_MS = 30 * 60_000

const REFERENCE = /\{\{([^{}]*)\}\}/g
const MAX_ISSUES = 50

export type PlanParseResult =
  | { readonly ok: true; readonly draft: PlanDraft }
  | { readonly ok: false; readonly issues: readonly PlanIssue[] }

/**
 * Model output → a draft, or the reasons it is not one. Only a JSON object is
 * accepted (a single fenced ```json block around it is tolerated); the schema
 * is strict, so unknown fields are refused rather than dropped.
 */
export function parsePlanText(text: string): PlanParseResult {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: 'not-json',
          message: 'The planner did not return a JSON object.',
          step: null
        }
      ]
    }
  }
  const parsed = PlanDraft.safeParse(value)
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
        code: 'schema' as const,
        message: `${issue.path.map(String).join('.') || 'plan'}: ${issue.message}`.slice(0, 300),
        step: stepAt(value, issue.path)
      }))
    }
  return { ok: true, draft: parsed.data }
}

/** Every reason the draft cannot run. Empty means it can. */
export function validatePlan(draft: PlanDraft): PlanIssue[] {
  const issues: PlanIssue[] = []
  const add = (code: PlanIssue['code'], message: string, step: string | null = null) => {
    if (issues.length < MAX_ISSUES) issues.push({ code, message: message.slice(0, 300), step })
  }
  const byId = new Map<string, PlanStep>()
  for (const step of draft.steps) {
    if (byId.has(step.id)) add('duplicate-step', `Two steps are called "${step.id}".`, step.id)
    else byId.set(step.id, step)
  }

  // Dependencies exist, and there is no cycle.
  for (const step of draft.steps) {
    for (const dependency of step.dependencies) {
      if (dependency === step.id) add('cycle', `Step "${step.id}" depends on itself.`, step.id)
      else if (!byId.has(dependency))
        add(
          'missing-dependency',
          `Step "${step.id}" depends on "${dependency}", which is not in the plan.`,
          step.id
        )
    }
    if (new Set(step.dependencies).size !== step.dependencies.length)
      add('schema', `Step "${step.id}" lists a dependency twice.`, step.id)
  }
  const cycle = findCycle(draft.steps, byId)
  if (cycle) add('cycle', `Steps depend on each other in a circle: ${cycle.join(' → ')}.`, cycle[0])

  // Step types, inputs, timeouts.
  const usedSkills = new Set<string>()
  const neededPermissions = new Set<string>()
  for (const step of draft.steps) {
    const type = stepType(step.skillId)
    usedSkills.add(step.skillId)
    if (!type) {
      add(
        'unknown-skill',
        `Step "${step.id}" uses "${step.skillId}", which Jupiter does not have.`,
        step.id
      )
      continue
    }
    if (!type.available)
      add(
        'unavailable-skill',
        `Step "${step.id}" uses "${type.name}": ${type.description}`,
        step.id
      )
    for (const permission of type.permissions) neededPermissions.add(permission)
    for (const input of type.inputs)
      if (input.required && !step.input[input.name]?.trim())
        add('missing-input', `Step "${step.id}" needs the input "${input.name}".`, step.id)
    for (const name of Object.keys(step.input))
      if (!type.inputs.some((input) => input.name === name))
        add('schema', `Step "${step.id}": "${type.skillId}" has no input "${name}".`, step.id)
    if (step.timeoutMs < type.minTimeoutMs)
      add(
        'invalid-timeout',
        `Step "${step.id}" allows ${String(step.timeoutMs)} ms; "${type.skillId}" needs at least ${String(type.minTimeoutMs)} ms.`,
        step.id
      )
    if (worstCaseMs(step) > MAX_STEP_BUDGET_MS)
      add(
        'invalid-timeout',
        `Step "${step.id}" could take over ${String(MAX_STEP_BUDGET_MS / 60_000)} minutes with every retry; lower its timeout or attempts.`,
        step.id
      )
    if (step.verification?.check === 'contains' && !step.verification.value)
      add('invalid-verification', `Step "${step.id}": a "contains" check needs a value.`, step.id)
    if (step.verification && !type.producesOutput)
      add('invalid-verification', `Step "${step.id}" produces no output to check.`, step.id)
  }

  // Declarations match what the steps use.
  for (const skill of usedSkills)
    if (!draft.requiredSkills.includes(skill))
      add('skills-not-declared', `The plan uses "${skill}" but does not list it in requiredSkills.`)
  for (const skill of draft.requiredSkills)
    if (!usedSkills.has(skill))
      add('skills-not-declared', `requiredSkills lists "${skill}", which no step uses.`)
  for (const permission of neededPermissions)
    if (!draft.requiredPermissions.includes(permission))
      add(
        'permissions-not-declared',
        `The plan needs the permission "${permission}" but does not declare it.`
      )
  for (const permission of draft.requiredPermissions)
    add(
      'permission-unavailable',
      `The plan asks for the permission "${permission}". Permissions cannot be granted until the Permission Engine arrives (SET 7), so it cannot run.`
    )

  // Artifact passing: {{step-id}} names an earlier step (a dependency, directly or not) that produces output.
  for (const step of draft.steps) {
    const ancestors = ancestorsOf(step, byId)
    for (const value of Object.values(step.input)) {
      for (const match of value.matchAll(REFERENCE)) {
        const key = (match[1] ?? '').trim()
        const source = byId.get(key)
        if (!PlanStepKey.safeParse(key).success || !source)
          add(
            'ambiguous-artifact',
            `Step "${step.id}" refers to "{{${key}}}", which is not a step.`,
            step.id
          )
        else if (!ancestors.has(key))
          add(
            'ambiguous-artifact',
            `Step "${step.id}" uses the output of "${key}" without depending on it, so it may not exist yet.`,
            step.id
          )
        else if (!stepType(source.skillId)?.producesOutput)
          add(
            'ambiguous-artifact',
            `Step "${step.id}" uses the output of "${key}", which produces none.`,
            step.id
          )
      }
    }
    if (step.condition) {
      if (!step.dependencies.includes(step.condition.step))
        add(
          'invalid-condition',
          `Step "${step.id}" runs on the outcome of "${step.condition.step}" but does not depend on it.`,
          step.id
        )
      else if (step.condition.outcome === 'failed' && byId.get(step.condition.step)?.required)
        add(
          'invalid-condition',
          `Step "${step.id}" runs if "${step.condition.step}" fails, but that step is required: its failure ends the Mission.`,
          step.id
        )
    }
  }
  for (const artifact of draft.expectedArtifacts) {
    const source = byId.get(artifact.step)
    if (!source || !stepType(source.skillId)?.producesOutput)
      add(
        'ambiguous-artifact',
        `Expected artifact "${artifact.description}" names "${artifact.step}", which is not a step that produces output.`,
        artifact.step
      )
  }

  // A verification strategy that can actually be carried out.
  let checksRequiredStep = false
  for (const check of draft.verificationPlan.checks) {
    const source = byId.get(check.step)
    if (!source || !stepType(source.skillId)?.producesOutput)
      add(
        'invalid-verification',
        `Check "${check.description}" names "${check.step}", which is not a step that produces output.`,
        check.step
      )
    else if (source.required && !source.condition) checksRequiredStep = true
    if (check.check === 'contains' && !check.value)
      add(
        'invalid-verification',
        `Check "${check.description}" needs a value to look for.`,
        check.step
      )
  }
  if (!checksRequiredStep)
    add(
      'no-verification',
      'The verification plan must check the output of at least one required, unconditional step.'
    )
  return issues
}

/** The `{{step-id}}` references in a text, in order. */
export function referencesIn(value: string): string[] {
  return [...value.matchAll(REFERENCE)].map((match) => (match[1] ?? '').trim())
}

/** Replace every `{{step-id}}` with that step's output. */
export function substitute(value: string, outputs: ReadonlyMap<string, string>): string {
  return value.replace(REFERENCE, (_whole, key: string) => outputs.get(key.trim()) ?? '')
}

/** How long the step may wait before attempt `attempt` (2, 3, …). */
export function backoffBefore(step: Pick<PlanStep, 'retryPolicy'>, attempt: number): number {
  const { backoffMs, multiplier } = step.retryPolicy
  return Math.round(backoffMs * multiplier ** Math.max(0, attempt - 2))
}

function worstCaseMs(step: PlanStep): number {
  let total = step.timeoutMs * step.retryPolicy.maxAttempts
  for (let attempt = 2; attempt <= step.retryPolicy.maxAttempts; attempt += 1)
    total += backoffBefore(step, attempt)
  return total
}

function ancestorsOf(step: PlanStep, byId: ReadonlyMap<string, PlanStep>): Set<string> {
  const seen = new Set<string>()
  const queue = [...step.dependencies]
  while (queue.length > 0) {
    const key = queue.pop()
    if (key === undefined || seen.has(key) || key === step.id) continue
    seen.add(key)
    queue.push(...(byId.get(key)?.dependencies ?? []))
  }
  return seen
}

/** One cycle through dependencies, as step ids (first repeated last), or null. */
function findCycle(
  steps: readonly PlanStep[],
  byId: ReadonlyMap<string, PlanStep>
): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    const mark = state.get(id)
    if (mark === 'done') return null
    if (mark === 'visiting') return [...path.slice(path.indexOf(id)), id]
    state.set(id, 'visiting')
    path.push(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (dependency === id || !byId.has(dependency)) continue
      const found = visit(dependency)
      if (found) return found
    }
    path.pop()
    state.set(id, 'done')
    return null
  }
  for (const step of steps) {
    const found = visit(step.id)
    if (found) return found
  }
  return null
}

function stepAt(value: unknown, path: readonly PropertyKey[]): string | null {
  if (path[0] !== 'steps' || typeof path[1] !== 'number') return null
  const steps = (value as { steps?: unknown }).steps
  if (!Array.isArray(steps)) return null
  const id = (steps[path[1]] as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && PlanStepKey.safeParse(id).success ? id : null
}
