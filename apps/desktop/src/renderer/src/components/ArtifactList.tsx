import { useState } from 'react'
import type { Artifact, ErrorEnvelope, UserRoot } from '@jupiter/contracts'
import { request } from '../api'
import { formatBytes } from '../format'
import { useI18n, type MessageKey } from '../i18n'
import { copyText, withPermission } from '../useFiles'
import { envelopeOf } from '../useRuntime'
import { LoadFailure } from '../views/LoadFailure'
import { Dialog } from './Dialog'
import { Menu } from './Menu'

/**
 * Artifacts as the person sees them (SET 10): each file Jupiter produced,
 * where it is, what it came from, its version, and how it was verified —
 * with Open, Show in folder, Copy path, Share (a copy in Downloads,
 * Documents or Desktop), Check again, Keep and Delete (to the Recycle Bin).
 * Actions that need a permission ask for it first, in the permission dialog.
 */

export const VERIFICATION_TONE: Readonly<Record<Artifact['verificationStatus'], string>> = {
  VERIFIED: 'success',
  FAILED: 'error',
  MISSING: 'warning'
}

const SHARE_ROOTS: readonly UserRoot[] = ['downloads', 'documents', 'desktop']

export function ArtifactList({
  artifacts,
  formatTime,
  testId = 'artifact-list'
}: {
  readonly artifacts: readonly Artifact[]
  readonly formatTime: (iso: string | null) => string
  readonly testId?: string
}) {
  const { t } = useI18n()
  if (artifacts.length === 0)
    return (
      <p className="muted" data-testid={`${testId}-empty`}>
        {t('artifacts.none')}
      </p>
    )
  return (
    <ul className="artifact-list" data-testid={testId}>
      {artifacts.map((artifact) => (
        <ArtifactItem key={artifact.artifactId} artifact={artifact} formatTime={formatTime} />
      ))}
    </ul>
  )
}

function ArtifactItem({
  artifact,
  formatTime
}: {
  readonly artifact: Artifact
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<ErrorEnvelope | null>(null)
  const [confirming, setConfirming] = useState(false)
  const deleted = artifact.deletedAt !== null

  const act = async (action: string, run: () => Promise<unknown>, doneKey: MessageKey) => {
    setBusy(action)
    setError(null)
    setDone(null)
    try {
      await withPermission(run, setWaiting)
      setDone(t(doneKey))
    } catch (failure) {
      setError(envelopeOf(failure))
    } finally {
      setBusy(null)
    }
  }
  const id = artifact.artifactId

  return (
    <li
      className="artifact"
      data-testid="artifact"
      data-artifact-id={id}
      data-status={artifact.verificationStatus}
      data-type={artifact.type}
      data-deleted={deleted}
      data-kept={artifact.kept}
    >
      <div className="artifact-head">
        <strong data-testid="artifact-name">{artifact.name}</strong>
        <span className="badge badge-muted">{artifact.type.toUpperCase()}</span>
        <span className="badge badge-muted">
          {t('artifacts.version', { version: artifact.version })}
        </span>
        {/* A deleted file is not there to be verified: only "Deleted" is shown. */}
        {deleted ? null : (
          <span
            className={`badge badge-${VERIFICATION_TONE[artifact.verificationStatus]}`}
            data-testid="artifact-verification"
          >
            {t(`artifacts.status.${artifact.verificationStatus}` as MessageKey)}
          </span>
        )}
        {artifact.kept ? <span className="badge badge-info">{t('artifacts.kept')}</span> : null}
        {deleted ? <span className="badge badge-muted">{t('artifacts.deleted')}</span> : null}
      </div>
      <p className="small">
        <code data-testid="artifact-path">{artifact.path}</code>
      </p>
      <p className="muted small">
        {formatBytes(t, artifact.size)} · {formatTime(artifact.createdAt)} ·{' '}
        {artifact.source.transformation}
      </p>
      <details className="artifact-checks">
        <summary>
          {t('artifacts.checks', {
            passed: artifact.verificationDetails.filter((check) => check.passed).length,
            total: artifact.verificationDetails.length
          })}
        </summary>
        <ul className="small" data-testid="artifact-check-list">
          {artifact.verificationDetails.map((check, index) => (
            <li key={`${check.check}-${String(index)}`} data-passed={check.passed}>
              <span className={`badge badge-${check.passed ? 'success' : 'error'}`}>
                {t(check.passed ? 'artifacts.checkPassed' : 'artifacts.checkFailed')}
              </span>{' '}
              <code>{check.check}</code> {check.detail}
            </li>
          ))}
          <li className="muted">
            {t('artifacts.hash')}: <code>{artifact.hash}</code>
          </li>
        </ul>
      </details>
      {deleted ? null : (
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            data-testid="artifact-open"
            onClick={() =>
              void act(
                'open',
                () => request('artifacts.open', { artifactId: id }),
                'artifacts.opened'
              )
            }
          >
            {t('artifacts.open')}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            data-testid="artifact-reveal"
            onClick={() =>
              void act(
                'reveal',
                () => request('artifacts.reveal', { artifactId: id }),
                'artifacts.revealed'
              )
            }
          >
            {t('artifacts.reveal')}
          </button>
          <button
            type="button"
            className="button"
            data-testid="artifact-copy-path"
            onClick={() => {
              setDone(t(copyText(artifact.path) ? 'artifacts.copied' : 'artifacts.copyFailed'))
            }}
          >
            {t('artifacts.copyPath')}
          </button>
          <Menu
            label={t('artifacts.share')}
            icon="folder"
            text={t('artifacts.share')}
            testId="artifact-share"
            items={SHARE_ROOTS.map((root) => ({
              id: root,
              label: t(`files.root.${root}` as MessageKey),
              onSelect: () =>
                void act(
                  'share',
                  () => request('artifacts.share', { artifactId: id, root }),
                  'artifacts.shared'
                )
            }))}
          />
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            data-testid="artifact-verify"
            onClick={() =>
              void act(
                'verify',
                () => request('artifacts.verify', { artifactId: id }),
                'artifacts.verified'
              )
            }
          >
            {t('artifacts.verify')}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            aria-pressed={artifact.kept}
            data-testid="artifact-keep"
            onClick={() =>
              void act(
                'keep',
                () => request('artifacts.keep', { artifactId: id, kept: !artifact.kept }),
                artifact.kept ? 'artifacts.released' : 'artifacts.keptDone'
              )
            }
          >
            {t(artifact.kept ? 'artifacts.release' : 'artifacts.keep')}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={busy !== null}
            data-testid="artifact-delete"
            onClick={() => {
              setConfirming(true)
            }}
          >
            {t('artifacts.delete')}
          </button>
        </div>
      )}
      <p className="small" role="status" data-testid="artifact-action-status">
        {waiting ? t('files.waitingPermission') : busy ? t('files.working') : (done ?? '')}
      </p>
      {error ? (
        <LoadFailure title={t('artifacts.actionFailed')} error={error} testId="artifact-error" />
      ) : null}
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false)
        }}
        title={t('artifacts.deleteTitle', { name: artifact.name })}
        description={t('artifacts.deleteDescription', { path: artifact.path })}
        role="alertdialog"
        testId="artifact-delete-dialog"
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setConfirming(false)
              }}
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              className="button button-danger"
              data-testid="artifact-delete-confirm"
              onClick={() => {
                setConfirming(false)
                void act(
                  'delete',
                  () => request('artifacts.delete', { artifactId: id }),
                  'artifacts.deletedDone'
                )
              }}
            >
              {t('artifacts.deleteConfirm')}
            </button>
          </>
        }
      />
    </li>
  )
}
