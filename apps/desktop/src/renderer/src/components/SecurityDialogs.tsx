import { useRef } from 'react'
import type { PermissionDecision, PermissionRequest } from '@jupiter/contracts'
import { useI18n, type MessageKey } from '../i18n'
import { RISK_TONE, subjectText } from '../permissionText'
import { Dialog } from './Dialog'

/**
 * The permission request (SET 7) and identity (SET 14) dialogs.
 *
 * A permission request shows everything the person needs to decide: what,
 * why, the exact target, the risk, who asks and for which Mission and step,
 * what leaves the computer, the consequence and whether it can be undone.
 * Only the answers the request offers are shown (a critical request never
 * offers "Always allow"), there is no close button, Escape does not answer,
 * and Deny has the first focus. The identity dialog states truthfully that
 * verification is unavailable.
 */

export function PermissionRequestDialog({
  request,
  busy,
  error,
  waiting,
  onAnswer
}: {
  readonly request: PermissionRequest | null
  readonly busy: boolean
  /** Why the last answer was not saved, if it was not. */
  readonly error: string | null
  /** Further requests waiting after this one. */
  readonly waiting: number
  readonly onAnswer: (decision: PermissionDecision) => void
}) {
  const { t } = useI18n()
  const denyRef = useRef<HTMLButtonElement>(null)
  const none = t('permission.none')
  const allows = request ? request.offered.filter((decision) => decision !== 'DENY') : []
  return (
    <Dialog
      open={request !== null}
      onClose={() => undefined}
      title={t('permission.title')}
      description={t('permission.description')}
      dismissible={false}
      role="alertdialog"
      initialFocus={denyRef}
      testId="permission-dialog"
      footer={
        <>
          <button
            ref={denyRef}
            type="button"
            className="button"
            data-testid="permission-deny"
            disabled={busy}
            onClick={() => {
              onAnswer('DENY')
            }}
          >
            {t('permission.decision.DENY')}
          </button>
          {allows.map((decision, index) => (
            <button
              key={decision}
              type="button"
              className={index === 0 ? 'button button-primary' : 'button'}
              data-testid={`permission-${decision.toLowerCase().replace('_', '-')}`}
              disabled={busy}
              onClick={() => {
                onAnswer(decision)
              }}
            >
              {t(`permission.decision.${decision}` as MessageKey)}
            </button>
          ))}
        </>
      }
    >
      {request ? (
        <>
          <dl className="facts facts-stacked" data-testid="permission-facts">
            <div>
              <dt>{t('permission.summary')}</dt>
              <dd>
                {request.summary}{' '}
                <code data-testid="permission-capability">{request.capability}</code>
              </dd>
            </div>
            <div>
              <dt>{t('permission.target')}</dt>
              <dd>
                <code data-testid="permission-target">{request.target}</code>
              </dd>
            </div>
            <div>
              <dt>{t('permission.risk')}</dt>
              <dd>
                <span
                  className={`badge badge-${RISK_TONE[request.risk]}`}
                  data-testid="permission-risk"
                >
                  {t(`risk.${request.risk}` as MessageKey)}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t('permission.reason')}</dt>
              <dd data-testid="permission-reason">{request.reason || none}</dd>
            </div>
            <div>
              <dt>{t('permission.requestedBy')}</dt>
              <dd data-testid="permission-subject">{subjectText(request.subject, t)}</dd>
            </div>
            <div>
              <dt>{t('permission.startedBy')}</dt>
              <dd>{t(`actor.${request.actor}` as MessageKey)}</dd>
            </div>
            <div>
              <dt>{t('permission.mission')}</dt>
              <dd data-testid="permission-mission">{request.missionTitle ?? none}</dd>
            </div>
            <div>
              <dt>{t('permission.step')}</dt>
              <dd>{request.stepTitle ?? none}</dd>
            </div>
            <div>
              <dt>{t('permission.consequence')}</dt>
              <dd data-testid="permission-consequence">{request.consequence}</dd>
            </div>
            <div>
              <dt>{t('permission.reversible')}</dt>
              <dd data-testid="permission-reversible">
                {t(request.reversible ? 'permission.reversibleYes' : 'permission.reversibleNo')}
              </dd>
            </div>
            <div>
              <dt>{t('permission.dataLeaves')}</dt>
              <dd data-testid="permission-data">
                {request.dataLeavesDevice ?? t('permission.dataStays')}
              </dd>
            </div>
          </dl>
          {request.risk === 'CRITICAL' ? (
            <p className="notice notice-warning" data-testid="permission-critical">
              {t('permission.criticalNote')}
            </p>
          ) : null}
          {error ? (
            <p className="notice notice-error" role="alert" data-testid="permission-error">
              {t('permission.answerFailed')}: {error}
            </p>
          ) : null}
          {waiting > 0 ? (
            <p className="muted small" data-testid="permission-more">
              {t('permission.more', { count: waiting })}
            </p>
          ) : null}
        </>
      ) : null}
    </Dialog>
  )
}

export function IdentityCheckDialog({
  open,
  reason,
  onCancel
}: {
  readonly open: boolean
  readonly reason: string
  readonly onCancel: () => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={t('identity.title')}
      description={reason}
      testId="identity-dialog"
      footer={
        <button type="button" className="button" data-testid="identity-cancel" onClick={onCancel}>
          {t('identity.cancel')}
        </button>
      }
    >
      <p>
        <span className="badge badge-muted" data-testid="identity-availability">
          {t('availability.UNAVAILABLE')}
        </span>{' '}
        {t('identity.unavailable')}
      </p>
    </Dialog>
  )
}
