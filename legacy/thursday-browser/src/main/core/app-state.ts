import type { BrainState, CommandCenterState, Mission } from '@shared/schemas.js'
import { emit } from './events.js'

/**
 * Live application state behind the Command Center.
 *
 * The brain visual is driven from here, so it always reflects something real
 * that the application is doing — it is never animated for decoration.
 */

interface State {
  brain: BrainState
  activeProvider: string | null
  activeModel: string | null
  activeSkill: string | null
  warnings: Map<string, string>
}

const state: State = {
  brain: 'idle',
  activeProvider: null,
  activeModel: null,
  activeSkill: null,
  warnings: new Map()
}

/** Installed by src/main/index.ts to avoid importing feature modules here. */
interface Sources {
  currentMission(): Mission | null
  pluginHealth(): CommandCenterState['pluginHealth']
  /** The provider/model the user has chosen, whether or not it is in use. */
  selection(): { provider: string | null; model: string | null }
}

let sources: Sources = {
  currentMission: () => null,
  pluginHealth: () => [],
  selection: () => ({ provider: null, model: null })
}

export function setStateSources(next: Sources): void {
  sources = next
}

export function setBrainState(brain: BrainState): void {
  if (state.brain === brain) return
  state.brain = brain
  publishCommandCenter()
}

export function getBrainState(): BrainState {
  return state.brain
}

export function setActiveModel(provider: string | null, model: string | null): void {
  state.activeProvider = provider
  state.activeModel = model
  publishCommandCenter()
}

export function setActiveSkill(skillId: string | null): void {
  if (state.activeSkill === skillId) return
  state.activeSkill = skillId
  publishCommandCenter()
}

export function setWarning(key: string, message: string): void {
  if (state.warnings.get(key) === message) return
  state.warnings.set(key, message)
  publishCommandCenter()
}

export function clearWarning(key: string): void {
  if (state.warnings.delete(key)) publishCommandCenter()
}

export function getCommandCenterState(): CommandCenterState {
  const mission = sources.currentMission()
  const activeStep = mission?.steps.find((step) => step.id === mission.currentStepId) ?? null
  const pluginHealth = sources.pluginHealth()

  const warnings = [...state.warnings.values()]
  for (const plugin of pluginHealth) {
    if (plugin.health === 'error' || plugin.health === 'crashed') {
      warnings.push(`Plugin "${plugin.name}" is ${plugin.health}${plugin.error ? `: ${plugin.error}` : ''}`)
    }
  }

  // Fall back to what the user has selected, so the Command Center shows the
  // model that *would* run before the first request is ever made.
  const selection = sources.selection()

  return {
    brain: deriveBrain(mission),
    mission,
    activeStepTitle: activeStep?.title ?? null,
    activeModel: state.activeModel ?? selection.model,
    activeProvider: state.activeProvider ?? selection.provider,
    activeSkill: state.activeSkill,
    pluginHealth,
    warnings
  }
}

/**
 * A running mission always wins over the ambient state: whatever the chat is
 * doing, the brain shows the mission's phase while one is in flight.
 */
function deriveBrain(mission: Mission | null): BrainState {
  if (!mission) return state.brain
  switch (mission.status) {
    case 'PLANNING':
      return 'planning'
    case 'EXECUTING':
      return 'executing'
    case 'WAITING_APPROVAL':
    case 'PAUSED':
      return 'waiting'
    case 'VERIFYING':
      return 'thinking'
    case 'COMPLETED':
      return 'completed'
    case 'FAILED':
      return 'error'
    default:
      return state.brain
  }
}

export function publishCommandCenter(): void {
  emit('commandcenter:update', getCommandCenterState())
}
