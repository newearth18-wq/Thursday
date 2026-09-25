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
 * Motion never suggests work: nothing here can show "thinking" or "working"
 * until Missions exist (SET 4) and the avatar engine arrives (SET 16).
 * Reduce Motion or Static Avatar stop all motion; Hide Avatar removes the
 * mark but keeps the status text.
 */
export const STAGE_STATES = ['idle', 'attention', 'starting', 'connecting', 'unavailable'] as const
export type StageState = (typeof STAGE_STATES)[number]

export function stageStateOf(status: Loadable<GatewayStatus>): StageState {
  if (status.state === 'loading') return 'connecting'
  if (status.state === 'error') return 'unavailable'
  const core = status.value.core.state
  if (core === 'starting' || core === 'stopping') return 'starting'
  if (core !== 'running') return 'unavailable'
  const overall = status.value.runtime.overall
  if (overall === 'STARTING') return 'starting'
  return overall === 'HEALTHY' ? 'idle' : 'attention'
}

const TONES: Record<StageState, JupiterMarkTone> = {
  idle: 'normal',
  attention: 'concerned',
  starting: 'dim',
  connecting: 'dim',
  unavailable: 'error'
}

export function JupiterStage({ status }: { readonly status: Loadable<GatewayStatus> }) {
  const { t } = useI18n()
  const { values } = usePreferences()
  const reduced = useReducedMotion(values['ui.reduceMotion'])
  const state = stageStateOf(status)
  const avatar = values['ui.avatar']
  const animated = avatar === 'animated' && !reduced && (state === 'idle' || state === 'attention')

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
          {t(`stage.${state}Detail` as MessageKey)}
        </p>
      </div>
    </section>
  )
}
