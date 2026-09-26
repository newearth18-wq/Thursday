import type { GatewayStatus } from '@jupiter/contracts'
import { JupiterMark, type JupiterMarkTone } from '@jupiter/ui'
import { useI18n, type MessageKey } from '../i18n'
import { usePreferences, useReducedMotion } from '../preferences'
import type { Loadable } from '../useRuntime'

/**
 * The central stage: Jupiter's mark and a micro-status, both driven only by
 * Jupiter Core's real state as the host reports it.
 *
 * - idle (Core running, all services healthy): slow breathing, very slow orbit;
 * - attention (a service degraded or failed): amber accent, slower motion;
 * - starting / connecting: dim and still;
 * - unavailable (Core stopped or crashed): restrained red accent, still.
 *
 * - working (SET 4): a Mission is really being worked on (analyzing,
 *   planning, running or verifying), and the stage names it.
 *
 * Motion never suggests work that is not happening: "working" appears only
 * while Core reports a Mission in one of those states. The avatar engine
 * with richer states arrives in SET 16.
 * Reduce Motion or Static Avatar stop all motion; Hide Avatar removes the
 * mark but keeps the status text.
 */
export const STAGE_STATES = [
  'idle',
  'working',
  'attention',
  'starting',
  'connecting',
  'unavailable'
] as const
export type StageState = (typeof STAGE_STATES)[number]

export function stageStateOf(status: Loadable<GatewayStatus>, working = false): StageState {
  if (status.state === 'loading') return 'connecting'
  if (status.state === 'error') return 'unavailable'
  const core = status.value.core.state
  if (core === 'starting' || core === 'stopping') return 'starting'
  if (core !== 'running') return 'unavailable'
  const overall = status.value.runtime.overall
  if (overall === 'STARTING') return 'starting'
  if (overall !== 'HEALTHY') return 'attention'
  return working ? 'working' : 'idle'
}

const TONES: Record<StageState, JupiterMarkTone> = {
  idle: 'normal',
  working: 'normal',
  attention: 'concerned',
  starting: 'dim',
  connecting: 'dim',
  unavailable: 'error'
}

export function JupiterStage({
  status,
  workingOn = null
}: {
  readonly status: Loadable<GatewayStatus>
  /** The title of a Mission being worked on right now, if any. */
  readonly workingOn?: string | null
}) {
  const { t } = useI18n()
  const { values } = usePreferences()
  const reduced = useReducedMotion(values['ui.reduceMotion'])
  const state = stageStateOf(status, workingOn !== null)
  const avatar = values['ui.avatar']
  const animated =
    avatar === 'animated' &&
    !reduced &&
    (state === 'idle' || state === 'working' || state === 'attention')

  return (
    <section
      className="stage"
      aria-labelledby="stage-status"
      data-testid="stage"
      data-state={state}
      data-animated={animated}
      data-avatar={avatar}
    >
      {avatar === 'hidden' ? null : (
        <div className="stage-avatar">
          <JupiterMark size={168} tone={TONES[state]} label={t('stage.avatarLabel')} />
        </div>
      )}
      <div className="stage-text">
        <p className="stage-status" id="stage-status" data-testid="stage-status">
          {t(`stage.${state}` as MessageKey)}
        </p>
        <p className="muted small" data-testid="stage-detail">
          {state === 'working'
            ? t('stage.workingDetail', { title: workingOn ?? '' })
            : t(`stage.${state}Detail` as MessageKey)}
        </p>
      </div>
    </section>
  )
}
