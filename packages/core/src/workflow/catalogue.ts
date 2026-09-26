import { SKILL_PERMISSIONS, type SkillInfo, type StepTypeInfo } from '@jupiter/contracts'

/**
 * The step types (skills) the Workflow Engine can run in this build (SET 5).
 *
 * A plan may use only these. The Skill Framework (SET 6) replaces this fixed
 * list with installed skills, and the Permission Engine (SET 7) grants the
 * permissions a step declares; until then no step type needs a permission,
 * and a plan that asks for one cannot run.
 */

export interface StepTypeDefinition extends StepTypeInfo {
  /** The shortest per-attempt timeout that makes sense for this step type. */
  readonly minTimeoutMs: number
  /** A checkpoint waits for a person instead of running. */
  readonly checkpoint: 'approval' | 'identity' | null
  /** `skill`: run through the Skill Registry (SET 6). */
  readonly runner: 'builtin' | 'skill'
}

/** Finds a step type by id: the built-in ones and, since SET 6, registered Skills. */
export type StepTypeLookup = (skillId: string) => StepTypeDefinition | null

export const STEP_TYPES: readonly StepTypeDefinition[] = [
  {
    skillId: 'model.generate',
    name: 'Ask the chat model',
    description:
      'Sends the prompt to the configured chat model (same routing, privacy and key rules as Chat) and keeps its answer as this step’s output.',
    inputs: [
      {
        name: 'prompt',
        required: true,
        description: 'What to ask. May include the output of earlier steps as {{step-id}}.'
      }
    ],
    producesOutput: true,
    permissions: [],
    available: true,
    minTimeoutMs: 5_000,
    checkpoint: null,
    runner: 'builtin'
  },
  {
    skillId: 'text.compose',
    name: 'Compose text',
    description:
      'Fills a text template with the output of earlier steps ({{step-id}}). Runs locally; nothing is sent anywhere.',
    inputs: [
      {
        name: 'template',
        required: true,
        description: 'The text to produce, with {{step-id}} where an earlier step’s output goes.'
      }
    ],
    producesOutput: true,
    permissions: [],
    available: true,
    minTimeoutMs: 1_000,
    checkpoint: null,
    runner: 'builtin'
  },
  {
    skillId: 'checkpoint.approval',
    name: 'Ask for approval',
    description:
      'Stops the workflow until you approve or reject. Steps that depend on it run only after approval.',
    inputs: [
      {
        name: 'question',
        required: true,
        description: 'What you are asked to approve.'
      }
    ],
    producesOutput: false,
    permissions: [],
    available: true,
    minTimeoutMs: 1_000,
    checkpoint: 'approval',
    runner: 'builtin'
  },
  {
    skillId: 'checkpoint.identity',
    name: 'Confirm identity',
    description:
      'Coming later: identity verification arrives with the Identity and Authorization Engine (SET 14). A plan that needs it cannot run yet.',
    inputs: [
      {
        name: 'reason',
        required: true,
        description: 'Why identity must be confirmed.'
      }
    ],
    producesOutput: false,
    permissions: [],
    available: false,
    minTimeoutMs: 1_000,
    checkpoint: 'identity',
    runner: 'builtin'
  }
]

const BY_ID = new Map(STEP_TYPES.map((type) => [type.skillId, type]))

export function stepType(skillId: string): StepTypeDefinition | null {
  return BY_ID.get(skillId) ?? null
}

/**
 * A registered Skill as a workflow step type. Plan inputs are text, so a
 * Skill whose input fields are not all text cannot be a step (yet).
 */
export function skillStepType(info: SkillInfo): StepTypeDefinition {
  const { definition } = info
  const fields = Object.entries(definition.inputSchema.properties ?? {})
  const textInputs = fields.every(([, schema]) => schema.type === 'string')
  const grantable = definition.permissions.every(
    (permission) =>
      (SKILL_PERMISSIONS as Record<string, { grantable: boolean } | undefined>)[permission]
        ?.grantable === true
  )
  const available =
    info.enabled &&
    info.runtimeCompatible &&
    info.health.status !== 'UNHEALTHY' &&
    grantable &&
    textInputs
  const why = !textInputs
    ? ' Not usable as a workflow step: its inputs are not all text.'
    : info.blockedReason
      ? ` Cannot run now: ${info.blockedReason}`
      : ''
  return {
    skillId: definition.skillId,
    name: definition.name,
    description: `${definition.description}${why}`.slice(0, 400),
    inputs: fields.slice(0, 10).map(([name, schema]) => ({
      name,
      required: definition.inputSchema.required?.includes(name) ?? false,
      description: (schema.description ?? '').slice(0, 200)
    })),
    producesOutput: true,
    permissions: [...definition.permissions],
    available,
    minTimeoutMs: 1_000,
    checkpoint: null,
    runner: 'skill'
  }
}

/** Built-in step types plus the given Skills, without duplicates (built-in ids win). */
export function catalogueWith(skills: readonly StepTypeDefinition[]): {
  readonly types: readonly StepTypeDefinition[]
  readonly lookup: StepTypeLookup
} {
  const types = [...STEP_TYPES, ...skills.filter((skill) => !BY_ID.has(skill.skillId))]
  const byId = new Map(types.map((type) => [type.skillId, type]))
  return { types, lookup: (skillId) => byId.get(skillId) ?? null }
}

/** What the `missions.step-types` query returns. */
export function stepTypeInfo(types: readonly StepTypeDefinition[] = STEP_TYPES): StepTypeInfo[] {
  return types.map((type) => ({
    skillId: type.skillId,
    name: type.name,
    description: type.description,
    inputs: type.inputs.map((input) => ({ ...input })),
    producesOutput: type.producesOutput,
    permissions: [...type.permissions],
    available: type.available
  }))
}
