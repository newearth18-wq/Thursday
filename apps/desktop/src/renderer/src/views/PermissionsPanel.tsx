import { useState } from 'react'
import type { PermissionGrant } from '@jupiter/contracts'
import { request } from '../api'
import { Switch } from '../components/FormControls'
import { ConfirmDialog } from '../components/InfoDialogs'
import { useNotify } from '../components/Toasts'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { RISK_TONE, subjectText } from '../permissionText'
import { usePendingPermissions, usePermissionAudit, usePermissionGrants } from '../usePermissions'
import { envelopeOf } from '../useRuntime'

/**
 * Settings → Permissions (SET 7): the requests waiting for an answer, every
 * permission given (with Revoke), and the audit trail. Everything is read
 * from Jupiter Core; Revoke is sent to Core and shown only once Core confirms.
 */
export function PermissionsPanel({ coreSession }: { readonly coreSession: string | null }) {
  const { t, locale } = useI18n()
  const notify = useNotify()
  const [showEnded, setShowEnded] = useState(false)
  const [revoking, setRevoking] = useState<PermissionGrant | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = usePendingPermissions(coreSession)
  const grants = usePermissionGrants(coreSession, showEnded)
  const audit = usePermissionAudit(coreSession)
  const time = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'medium'
  })
  const at = (value: string) => time.format(new Date(value))

  const revoke = (grant: PermissionGrant) => {
    setBusy(true)
    request('permissions.revoke', { grantId: grant.grantId }).then(
      () => {
        setBusy(false)
        setRevoking(null)
        notify({ tone: 'success', title: t('permissions.revoked') })
        grants.refresh()
        audit.refresh()
      },
      (error: unknown) => {
        setBusy(false)
        setRevoking(null)
        notify({
          tone: 'error',
          title: t('permissions.revokeFailed'),
          message: envelopeOf(error).message
        })
      }
    )
  }

  const failed = [pending.data, grants.data, audit.data].find((item) => item.state === 'error')

  return (
    <div className="panel-stack" data-testid="permissions-panel">
      <p className="muted">{t('permissions.intro')}</p>
      {failed?.state === 'error' ? (
        <p className="notice notice-error" role="alert" data-testid="permissions-error">
          {t('permissions.loadFailed')}: {failed.error.message}
        </p>
      ) : null}

      <section aria-labelledby="permissions-pending">
        <h3 id="permissions-pending">{t('permissions.pending')}</h3>
        {pending.data.state === 'ready' && pending.data.value.length === 0 ? (
          <p className="muted small" data-testid="permissions-no-pending">
            {t('permissions.noPending')}
          </p>
        ) : null}
        {pending.data.state === 'ready' && pending.data.value.length > 0 ? (
          <ul className="permission-list" data-testid="permissions-pending-list">
            {pending.data.value.map((item) => (
              <li key={item.requestId} className="permission-item">
                <code>{item.capability}</code>{' '}
                <span className={`badge badge-${RISK_TONE[item.risk]}`}>
                  {t(`risk.${item.risk}` as MessageKey)}
                </span>{' '}
                <span>{subjectText(item.subject, t)}</span>{' '}
                <code className="permission-target">{item.target}</code>{' '}
                <span className="muted small">{at(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="permissions-grants">
        <h3 id="permissions-grants">{t('permissions.grants')}</h3>
        <Switch
          label={t('permissions.showEnded')}
          checked={showEnded}
          onChange={setShowEnded}
          testId="permissions-show-ended"
        />
        {grants.data.state === 'ready' && grants.data.value.length === 0 ? (
          <p className="muted small" data-testid="permissions-no-grants">
            {t('permissions.noGrants')}
          </p>
        ) : null}
        {grants.data.state === 'ready' && grants.data.value.length > 0 ? (
          <ul className="permission-list" data-testid="permissions-grant-list">
            {grants.data.value.map((grant) => (
              <li
                key={grant.grantId}
                className="permission-item"
                data-testid="permission-grant"
                data-capability={grant.capability}
                data-subject={grant.subject.id}
                data-state={grant.state}
              >
                <div className="permission-item-main">
                  <code>{grant.capability}</code> <span>{subjectText(grant.subject, t)}</span>
                  <span className="muted small">
                    {t('permissions.target')}:{' '}
                    <code className="permission-target">
                      {grant.target === '*' ? t('permissions.anyTarget') : grant.target}
                    </code>
                    {' · '}
                    {t('permissions.kind')}: {t(`permissions.kind.${grant.kind}` as MessageKey)}
                    {grant.missionId ? ` · ${t('permissions.onlyMission')}` : ''}
                    {' · '}
                    {t('permissions.givenBy')}:{' '}
                    {grant.createdBy === 'core'
                      ? t('permissions.defaultPolicy')
                      : t(`actor.${grant.createdBy}` as MessageKey)}
                    {' · '}
                    {t('permissions.givenAt')}: {at(grant.createdAt)}
                  </span>
                </div>
                <span className="badge badge-muted" data-testid="permission-grant-state">
                  {t(`permissions.state.${grant.state}` as MessageKey)}
                </span>
                {grant.state === 'ACTIVE' ? (
                  <button
                    type="button"
                    className="button"
                    data-testid="permission-revoke"
                    disabled={busy}
                    onClick={() => {
                      setRevoking(grant)
                    }}
                  >
                    {t('permissions.revoke')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="permissions-audit">
        <h3 id="permissions-audit">{t('permissions.audit')}</h3>
        <p className="muted small">{t('permissions.auditIntro')}</p>
        {audit.data.state === 'ready' && audit.data.value.length === 0 ? (
          <p className="muted small">{t('permissions.noAudit')}</p>
        ) : null}
        {audit.data.state === 'ready' && audit.data.value.length > 0 ? (
          <ol className="permission-list" data-testid="permissions-audit-table">
            {audit.data.value.map((entry) => (
              <li
                key={entry.entryId}
                className="permission-item"
                data-testid="permission-audit-row"
                data-action={entry.action}
              >
                <div className="permission-item-main">
                  <span>
                    <strong>{t(`permissions.auditAction.${entry.action}` as MessageKey)}</strong>{' '}
                    <code>{entry.capability}</code>{' '}
                    <span className="badge badge-muted">{entry.outcome}</span>
                  </span>
                  <span className="muted small">
                    {t('permissions.audit.at')}: {at(entry.at)}
                    {' · '}
                    {t('permissions.audit.requester')}: {entry.subjectId ?? t('permission.none')}
                    {' · '}
                    {t('permissions.target')}:{' '}
                    <code className="permission-target">
                      {entry.target ?? t('permission.none')}
                    </code>
                  </span>
                  <span className="small">{entry.detail}</span>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <ConfirmDialog
        open={revoking !== null}
        title={t('permissions.revokeTitle')}
        description={
          revoking
            ? t('permissions.revokeDescription', {
                requester: subjectText(revoking.subject, t),
                capability: revoking.capability,
                target: revoking.target === '*' ? t('permissions.anyTarget') : revoking.target
              })
            : ''
        }
        confirmLabel={t('permissions.revoke')}
        onConfirm={() => {
          if (revoking) revoke(revoking)
        }}
        onCancel={() => {
          setRevoking(null)
        }}
        testId="permission-revoke-dialog"
      />
    </div>
  )
}
