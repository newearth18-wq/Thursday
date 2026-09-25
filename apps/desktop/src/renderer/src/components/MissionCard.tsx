import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { ProgressIndicator } from './Progress'

/**
 * Current Mission card (Visual Design Lock v1): current action, progress when
 * measurable, elapsed time, agent, skill, model, Pause, Cancel and Details.
 *
 * SET 2 builds the shell. There is no Mission system yet (SET 4), so the
 * interface always passes `mission={null}` and the card says so; the
 * populated layout exists for SET 4 and is exercised by unit tests only.
 */
export interface MissionCardData {
  readonly title: string
  readonly currentAction: string
  readonly completed: number | null
  readonly total: number | null
  readonly startedAt: string
  readonly agent: string | null
  readonly skill: string | null
  readonly model: string | null
}

export interface MissionCardProps {
  readonly mission: MissionCardData | null
  readonly onPause?: () => void
  readonly onCancel?: () => void
  readonly onDetails?: () => void
}

function elapsedSeconds(startedAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
}

export function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`
}

export function MissionCard({ mission, onPause, onCancel, onDetails }: MissionCardProps) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!mission) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [mission])

  if (!mission) {
    return (
      <section
        className="card mission-card"
        aria-labelledby="mission-card-title"
        data-testid="mission-card"
        data-state="empty"
      >
        <div className="card-header">
          <h2 id="mission-card-title">{t('mission.title')}</h2>
          <span className="badge badge-muted" data-testid="mission-card-availability">
            {t('availability.COMING_LATER')}
          </span>
        </div>
        <p>{t('mission.none')}</p>
        <p className="muted small">{t('mission.plannedFor', { set: 4 })}</p>
      </section>
    )
  }

  const unknown = t('mission.unknown')
  return (
    <section
      className="card mission-card"
      aria-labelledby="mission-card-title"
      data-testid="mission-card"
      data-state="active"
    >
      <div className="card-header">
        <h2 id="mission-card-title">{mission.title}</h2>
      </div>
      <p data-testid="mission-action">{mission.currentAction}</p>
      <ProgressIndicator
        label={t('mission.progress')}
        completed={mission.completed}
        total={mission.total}
        testId="mission-progress"
      />
      <dl className="facts facts-compact">
        <div>
          <dt>{t('mission.elapsed')}</dt>
          <dd data-testid="mission-elapsed">
            {formatElapsed(elapsedSeconds(mission.startedAt, now))}
          </dd>
        </div>
        <div>
          <dt>{t('mission.agent')}</dt>
          <dd>{mission.agent ?? unknown}</dd>
        </div>
        <div>
          <dt>{t('mission.skill')}</dt>
          <dd>{mission.skill ?? unknown}</dd>
        </div>
        <div>
          <dt>{t('mission.model')}</dt>
          <dd>{mission.model ?? unknown}</dd>
        </div>
      </dl>
      <div className="actions">
        <button type="button" className="button" disabled={!onPause} onClick={onPause}>
          {t('mission.pause')}
        </button>
        <button type="button" className="button" disabled={!onCancel} onClick={onCancel}>
          {t('mission.cancel')}
        </button>
        <button type="button" className="button" disabled={!onDetails} onClick={onDetails}>
          {t('mission.details')}
        </button>
      </div>
    </section>
  )
}
