import type { StepTypeInfo } from '@jupiter/contracts'

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
}

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
    checkpoint: null
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
    checkpoint: null
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
    checkpoint: 'approval'
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
    checkpoint: 'identity'
  }
]

const BY_ID = new Map(STEP_TYPES.map((type) => [type.skillId, type]))

export function stepType(skillId: string): StepTypeDefinition | null {
  return BY_ID.get(skillId) ?? null
}

/** What the `missions.step-types` query returns. */
export function stepTypeInfo(): StepTypeInfo[] {
  return STEP_TYPES.map((type) => ({
    skillId: type.skillId,
    name: type.name,
    description: type.description,
    inputs: type.inputs.map((input) => ({ ...input })),
    producesOutput: type.producesOutput,
    permissions: [...type.permissions],
    available: type.available
  }))
}
