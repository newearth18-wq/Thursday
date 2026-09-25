import { useRef } from 'react'
import type { RiskLevel } from '@jupiter/contracts'
import { useI18n, type MessageKey } from '../i18n'
import { Dialog } from './Dialog'

/**
 * Permission and identity modal shells (SET 2).
 *
 * Nothing in this build asks for permission or identity: the Permission
 * Engine is SET 7 and identity verification is SET 14. These dialogs define
 * how such a request will be presented — exact target, risk level, an
 * explicit answer, safe default focus — and are exercised by unit tests. The
 * identity dialog states truthfully that verification is unavailable.
 */

export interface PermissionPrompt {
  /** The capability that wants to run, e.g. `files.delete`. */
  readonly capability: string
  /** The exact target, e.g. a full file path. */
  readonly target: string
  readonly risk: RiskLevel
  /** Why it is needed, in the requester's words (untrusted text, shown as text). */
  readonly reason: string
  readonly requestedBy: string
}

export function PermissionRequestDialog({
  prompt,
  onAllowOnce,
  onDeny
}: {
  readonly prompt: PermissionPrompt | null
  readonly onAllowOnce: () => void
  readonly onDeny: () => void
}) {
  const { t } = useI18n()
  const denyRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open={prompt !== null}
      onClose={onDeny}
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
            onClick={onDeny}
          >
            {t('permission.deny')}
          </button>
          <button
            type="button"
            className="button button-primary"
            data-testid="permission-allow"
            onClick={onAllowOnce}
          >
            {t('permission.allowOnce')}
          </button>
        </>
      }
    >
      {prompt ? (
        <dl className="facts facts-stacked">
          <div>
            <dt>{t('permission.action')}</dt>
            <dd>
              <code>{prompt.capability}</code>
            </dd>
          </div>
          <div>
            <dt>{t('permission.target')}</dt>
            <dd>
              <code data-testid="permission-target">{prompt.target}</code>
            </dd>
          </div>
          <div>
            <dt>{t('permission.risk')}</dt>
            <dd>
              <span
                className={`badge badge-${prompt.risk === 'LOW' ? 'info' : prompt.risk === 'MEDIUM' ? 'warning' : 'error'}`}
                data-testid="permission-risk"
              >
                {t(`risk.${prompt.risk}` as MessageKey)}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t('permission.requestedBy')}</dt>
            <dd>{prompt.requestedBy}</dd>
          </div>
          <div>
            <dt>{t('permission.reason')}</dt>
            <dd>{prompt.reason}</dd>
          </div>
        </dl>
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
