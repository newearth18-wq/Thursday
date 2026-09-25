import type { ErrorEnvelope } from '@jupiter/contracts'
import { useI18n } from '../i18n'

/** A request to the application core failed: say so, with the real reason. */
export function LoadFailure({
  title,
  error
}: {
  readonly title: string
  readonly error: ErrorEnvelope
}) {
  const { t } = useI18n()
  return (
    <div className="notice notice-error" role="alert" data-testid="load-failure">
      <p className="notice-title">{title}</p>
      <p className="notice-message">{error.message}</p>
      {error.userAction ? (
        <p>
          <strong>{t('recovery.whatToDo')}:</strong> {error.userAction}
        </p>
      ) : null}
      <p className="muted small">
        {t('recovery.code')}: <code>{error.code}</code>
      </p>
    </div>
  )
}
