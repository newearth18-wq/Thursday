import type { ReactNode } from 'react'
import type { ErrorEnvelope } from '@jupiter/contracts'
import { errorSummary } from '../errorText'
import { useI18n } from '../i18n'

/** A request to the application core failed: say so, with the real reason and what can be done. */
export function LoadFailure({
  title,
  error,
  children,
  testId = 'load-failure'
}: {
  readonly title: string
  readonly error: ErrorEnvelope
  /** Real recovery actions (for example Retry, or Open AI Models). */
  readonly children?: ReactNode
  readonly testId?: string
}) {
  const { t } = useI18n()
  const summary = errorSummary(error, t)
  return (
    <div className="notice notice-error" role="alert" data-testid={testId} data-code={error.code}>
      <p className="notice-title">{title}</p>
      {summary ? <p className="notice-summary">{summary}</p> : null}
      <p className="notice-message">{error.message}</p>
      {error.userAction ? (
        <p>
          <strong>{t('recovery.whatToDo')}:</strong> {error.userAction}
        </p>
      ) : null}
      <p className="muted small">
        {t('recovery.code')}: <code>{error.code}</code>
      </p>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  )
}
