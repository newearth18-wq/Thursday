import { useId } from 'react'
import { Icon } from '@jupiter/ui'
import { useI18n } from '../i18n'

/**
 * The chat composer shell. There is no AI model in this build (providers and
 * chat are SET 3), so the composer is disabled and says why: nothing typed
 * here could be sent anywhere, and the interface does not pretend otherwise.
 */
export function ChatComposer({ testId = 'chat-composer' }: { readonly testId?: string }) {
  const { t } = useI18n()
  const inputId = useId()
  const reasonId = useId()
  return (
    <form
      className="composer"
      data-testid={testId}
      data-availability="COMING_LATER"
      aria-describedby={reasonId}
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">
        {t('composer.label')}
      </label>
      <textarea
        id={inputId}
        className="composer-input"
        rows={2}
        placeholder={t('composer.placeholder')}
        disabled
        aria-describedby={reasonId}
      />
      <div className="composer-footer">
        <p id={reasonId} className="muted small" data-testid={`${testId}-reason`}>
          <span className="badge badge-muted">{t('availability.COMING_LATER')}</span>{' '}
          {t('composer.unavailable')}
        </p>
        <button type="submit" className="button button-primary" disabled>
          <Icon name="chat" size={18} />
          <span>{t('composer.send')}</span>
        </button>
      </div>
    </form>
  )
}
