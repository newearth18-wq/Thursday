import type { ReactNode } from 'react'
import { useI18n } from '../i18n'

/** The heading of a screen, with its availability when the feature is not built yet. */
export function ViewHeader({
  id,
  title,
  plannedSet,
  children
}: {
  readonly id: string
  readonly title: string
  readonly plannedSet?: string | null
  readonly children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="view-header">
      <div className="view-title">
        <h1 id={id} tabIndex={-1}>
          {title}
        </h1>
        {plannedSet ? (
          <span className="badge badge-muted" data-testid="view-availability">
            {t('availability.COMING_LATER')}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}
