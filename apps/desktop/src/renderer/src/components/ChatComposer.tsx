import { useId, useState, type KeyboardEvent } from 'react'
import {
  MAX_USER_MESSAGE_CHARS,
  type ChatExchange,
  type ErrorEnvelope,
  type RoutePreview
} from '@jupiter/contracts'
import { Icon } from '@jupiter/ui'
import type { ViewId } from '../../../shared/views'
import { request } from '../api'
import { useI18n } from '../i18n'
import { useRoutePreview } from '../useAi'
import { coreSessionOf, envelopeOf, useRuntimeContext, type Loadable } from '../useRuntime'
import { LoadFailure } from '../views/LoadFailure'
import { RouteBadge } from './RouteBadge'

/**
 * The chat composer (SET 3). It can send only when Jupiter Core is running
 * and a configured model can answer; otherwise it is disabled and says why,
 * with the way to fix it. What was typed is kept until Core confirms the
 * message was stored.
 */

type ComposerAvailability = 'available' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'checking'

function availabilityOf(coreRunning: boolean, route: Loadable<RoutePreview>): ComposerAvailability {
  if (!coreRunning) return 'UNAVAILABLE'
  if (route.state === 'loading') return 'checking'
  if (route.state === 'error') return 'UNAVAILABLE'
  if (route.value.route) return 'available'
  return route.value.problem?.code === 'NO_MODEL_AVAILABLE' ? 'NOT_CONFIGURED' : 'UNAVAILABLE'
}

export function ChatComposer({
  testId = 'chat-composer',
  conversationId,
  busy = false,
  onSent,
  onNavigate
}: {
  readonly testId?: string
  readonly conversationId: string | null
  /** An answer is being written in this conversation. */
  readonly busy?: boolean
  readonly onSent: (exchange: ChatExchange) => void
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t } = useI18n()
  const inputId = useId()
  const reasonId = useId()
  const { status } = useRuntimeContext()
  const coreSession = coreSessionOf(status)
  const route = useRoutePreview('chat', conversationId, coreSession)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)

  const availability = availabilityOf(coreSession !== null, route)
  const canType = availability === 'available'
  const trimmed = text.trim()
  const tooLong = text.length > MAX_USER_MESSAGE_CHARS
  const canSend = canType && !busy && !sending && trimmed.length > 0 && !tooLong

  const send = () => {
    if (!canSend) return
    setSending(true)
    setFailure(null)
    request('chat.send', { conversationId, text: trimmed }).then(
      (exchange) => {
        setText('')
        setSending(false)
        onSent(exchange)
      },
      (error: unknown) => {
        setSending(false)
        setFailure(envelopeOf(error))
      }
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  const problem =
    route.state === 'ready' ? route.value.problem : route.state === 'error' ? route.error : null

  return (
    <form
      className="composer"
      data-testid={testId}
      data-availability={availability}
      aria-describedby={reasonId}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">
        {t('composer.label')}
      </label>
      <textarea
        id={inputId}
        className="composer-input"
        rows={2}
        value={text}
        placeholder={canType ? t('composer.placeholder') : t('composer.placeholderUnavailable')}
        disabled={!canType}
        aria-describedby={reasonId}
        aria-invalid={tooLong}
        data-testid={`${testId}-input`}
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <div className="composer-footer">
        <div id={reasonId} className="composer-status small" data-testid={`${testId}-reason`}>
          {availability === 'available' && route.state === 'ready' && route.value.route ? (
            <RouteBadge route={route.value.route} testId={`${testId}-route`} />
          ) : null}
          {availability === 'checking' ? (
            <span className="muted">{t('composer.checking')}</span>
          ) : null}
          {availability === 'UNAVAILABLE' && coreSession === null ? (
            <span>
              <span className="badge badge-muted">{t('availability.UNAVAILABLE')}</span>{' '}
              {t('composer.coreDown')}
            </span>
          ) : null}
          {(availability === 'NOT_CONFIGURED' || availability === 'UNAVAILABLE') &&
          coreSession !== null &&
          problem ? (
            <span>
              <span className="badge badge-muted">{t(`availability.${availability}`)}</span>{' '}
              {problem.message}{' '}
              <button
                type="button"
                className="link-button"
                data-testid={`${testId}-configure`}
                onClick={() => {
                  onNavigate('models')
                }}
              >
                {t('composer.openModels')}
              </button>
            </span>
          ) : null}
          {busy && canType ? <span className="muted"> {t('composer.busy')}</span> : null}
          {tooLong ? (
            <span className="composer-count" role="status">
              {t('composer.tooLong', { max: MAX_USER_MESSAGE_CHARS })}
            </span>
          ) : null}
          <span className="muted composer-attach" data-testid={`${testId}-attach`}>
            <span className="badge badge-muted">{t('availability.COMING_LATER')}</span>{' '}
            {t('composer.attachLater')}
          </span>
        </div>
        <button
          type="submit"
          className="button button-primary"
          disabled={!canSend}
          data-testid={`${testId}-send`}
        >
          <Icon name="send" size={18} />
          <span>{sending ? t('composer.sending') : t('composer.send')}</span>
        </button>
      </div>
      {failure ? (
        <LoadFailure title={t('composer.notSent')} error={failure} testId={`${testId}-error`}>
          {failure.category === 'configuration' ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                onNavigate('models')
              }}
            >
              {t('composer.openModels')}
            </button>
          ) : null}
        </LoadFailure>
      ) : null}
    </form>
  )
}
