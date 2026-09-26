import type { ReactNode } from 'react'
import { Icon, type IconName } from '@jupiter/ui'
import { useI18n } from '../i18n'

/**
 * The one way every screen shows a state that is not "content": empty,
 * loading, offline, unavailable (not built, not configured) or failed with a
 * retry. Each kind has its own icon, role and wording, so a state can never
 * be mistaken for a working feature.
 */
export type StateKind = 'empty' | 'loading' | 'offline' | 'unavailable' | 'error'

const ICONS: Record<StateKind, IconName> = {
  empty: 'info',
  loading: 'info',
  offline: 'offline',
  unavailable: 'info',
  error: 'error'
}

export interface StateMessageProps {
  readonly kind: StateKind
  readonly title: string
  readonly children?: ReactNode
  /** A real recovery action (for example Retry). */
  readonly action?: {
    readonly label: string
    readonly onClick: () => void
    readonly busy?: boolean
  }
  readonly testId?: string
}

export function StateMessage({ kind, title, children, action, testId }: StateMessageProps) {
  const { t } = useI18n()
  return (
    <div
      className={`state-message state-${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-busy={kind === 'loading' ? true : undefined}
      data-state={kind}
      data-testid={testId}
    >
      <span className="state-icon">
        {kind === 'loading' ? <progress aria-label={t('load.loading')} /> : null}
        {kind === 'loading' ? null : <Icon name={ICONS[kind]} size={22} />}
      </span>
      <div>
        <p className="state-title">{title}</p>
        {children ? <div className="state-body">{children}</div> : null}
        {action ? (
          <button
            type="button"
            className="button"
            disabled={action.busy}
            data-testid={testId ? `${testId}-action` : undefined}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  )
}
