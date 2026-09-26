import { useI18n } from '../i18n'

/**
 * Progress that never invents numbers: a bar with a count only when both
 * the completed and total amounts are known; otherwise an indeterminate
 * indicator that only says work is under way.
 */
export interface ProgressIndicatorProps {
  readonly label: string
  readonly completed: number | null
  readonly total: number | null
  readonly testId?: string
}

export function isMeasurable(completed: number | null, total: number | null): boolean {
  return completed !== null && total !== null && total > 0 && completed >= 0 && completed <= total
}

export function ProgressIndicator({ label, completed, total, testId }: ProgressIndicatorProps) {
  const { t } = useI18n()
  const measurable = isMeasurable(completed, total)
  return (
    <div
      className="progress"
      role="status"
      data-testid={testId}
      data-measurable={measurable}
      aria-busy="true"
    >
      {measurable ? (
        <>
          <progress value={completed ?? 0} max={total ?? 1} aria-label={label} />
          <span className="muted small">
            {t('progress.measured', {
              label,
              done: completed ?? 0,
              total: total ?? 0,
              percent: Math.round(((completed ?? 0) / (total ?? 1)) * 100)
            })}
          </span>
        </>
      ) : (
        <>
          <progress aria-label={label} />
          <span className="muted small">{t('progress.indeterminate', { label })}</span>
        </>
      )}
    </div>
  )
}
