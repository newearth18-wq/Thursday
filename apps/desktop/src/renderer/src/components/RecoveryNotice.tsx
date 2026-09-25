import { useState } from 'react'
import type { ErrorEnvelope, ServiceHealth } from '@jupiter/contracts'
import { errorSummary } from '../errorText'
import { useI18n, type MessageKey } from '../i18n'
import { StatusBadge } from './StatusBadge'

interface Props {
  readonly service: ServiceHealth
  readonly onRetry: (serviceId: string) => Promise<ErrorEnvelope | null>
}

/**
 * Shows a failed or degraded service exactly as the main process reported
 * it: a summary in the interface language for errors Jupiter knows, then the
 * real message, the next step, the error code and reference. Retry
 * re-runs the service's real start routine; the result arrives as a new
 * status, never as an optimistic "fixed" message.
 */
export function RecoveryNotice({ service, onRetry }: Props) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [retryError, setRetryError] = useState<ErrorEnvelope | null>(null)
  const error = service.sanitizedError
  const name = t(`service.${service.serviceId}` as MessageKey)
  const canRetry = service.retryable && (error?.retryable ?? true)
  const summary = error ? errorSummary(error, t) : null

  return (
    <div
      className={`notice notice-${service.status === 'FAILED' ? 'error' : 'warning'}`}
      role={service.status === 'FAILED' ? 'alert' : 'status'}
      data-testid={`recovery-${service.serviceId}`}
    >
      <p className="notice-title">
        {name} <StatusBadge status={service.status} />
      </p>
      {error ? (
        <>
          {summary ? (
            <p className="notice-summary" data-testid="recovery-summary">
              {summary}
            </p>
          ) : null}
          <p className="notice-message" data-testid="recovery-message">
            {error.message}
          </p>
          {error.userAction ? (
            <p>
              <strong>{t('recovery.whatToDo')}:</strong>{' '}
              <span data-testid="recovery-action">{error.userAction}</span>
            </p>
          ) : null}
          <p className="muted small">
            {t('recovery.code')}: <code data-testid="recovery-code">{error.code}</code> ·{' '}
            {t('recovery.reference')}: <code>{error.errorId}</code>
          </p>
        </>
      ) : null}
      {canRetry ? (
        <button
          type="button"
          className="button button-primary"
          disabled={pending || service.status === 'STARTING'}
          data-testid={`retry-${service.serviceId}`}
          onClick={() => {
            setPending(true)
            setRetryError(null)
            void onRetry(service.serviceId).then((failure) => {
              setRetryError(failure)
              setPending(false)
            })
          }}
        >
          {pending ? t('recovery.retrying') : t('recovery.retry')}
        </button>
      ) : (
        <p className="muted small">{t('recovery.notRetryable')}</p>
      )}
      {retryError ? (
        <p className="notice-message" role="alert">
          {t('recovery.retryFailed', { message: retryError.message })}
        </p>
      ) : null}
    </div>
  )
}
