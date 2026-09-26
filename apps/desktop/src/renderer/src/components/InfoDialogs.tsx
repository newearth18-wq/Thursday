import type { GatewayStatus } from '@jupiter/contracts'
import { JupiterMark } from '@jupiter/ui'
import { DESTINATIONS, shortcutLabel } from '../destinations'
import { useI18n, type MessageKey } from '../i18n'
import type { Loadable } from '../useRuntime'
import { Dialog } from './Dialog'

/** Every keyboard shortcut Jupiter handles, read from the same list the handler uses. */
export function ShortcutsDialog({
  open,
  onClose
}: {
  readonly open: boolean
  readonly onClose: () => void
}) {
  const { t } = useI18n()
  const rows: { keys: string; action: string }[] = [
    ...DESTINATIONS.filter((destination) => destination.shortcut !== null).map((destination) => ({
      keys: destination.shortcut ? shortcutLabel(destination.shortcut) : '',
      action: t('shortcuts.open', { view: t(destination.label) })
    })),
    { keys: 'Ctrl+B', action: t('shortcuts.compact') },
    { keys: 'F6', action: t('shortcuts.regions') },
    { keys: 'F1 / Ctrl+/', action: t('shortcuts.help') },
    { keys: 'Esc', action: t('shortcuts.escape') },
    { keys: 'Tab / Shift+Tab', action: t('shortcuts.tab') }
  ]
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('shortcuts.title')}
      description={t('shortcuts.description')}
      testId="shortcuts-dialog"
      footer={
        <button type="button" className="button" onClick={onClose}>
          {t('dialog.done')}
        </button>
      }
    >
      <table className="data-table shortcuts-table">
        <thead>
          <tr>
            <th scope="col">{t('shortcuts.keys')}</th>
            <th scope="col">{t('shortcuts.action')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.keys}>
              <td>
                <kbd>{row.keys}</kbd>
              </td>
              <td>{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  )
}

/** About Jupiter: the real build, read from the host's build metadata. */
export function AboutDialog({
  open,
  onClose,
  status
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly status: Loadable<GatewayStatus>
}) {
  const { t } = useI18n()
  const app = status.state === 'ready' ? status.value.app : null
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('about.title')}
      testId="about-dialog"
      footer={
        <button type="button" className="button" onClick={onClose}>
          {t('dialog.done')}
        </button>
      }
    >
      <div className="about">
        <JupiterMark size={72} />
        {app ? (
          <dl className="facts facts-stacked">
            <div>
              <dt>{t('home.version')}</dt>
              <dd data-testid="about-version">
                {app.build?.version ?? t('home.versionUnavailable')}
              </dd>
            </div>
            <div>
              <dt>{t('home.channel')}</dt>
              <dd>{app.build?.channel ?? t('diagnostics.none')}</dd>
            </div>
            <div>
              <dt>{t('diagnostics.buildId')}</dt>
              <dd>
                <code>{app.build?.buildId ?? t('diagnostics.none')}</code>
              </dd>
            </div>
            <div>
              <dt>{t('home.environment')}</dt>
              <dd>{t(`env.${app.environment}` as MessageKey)}</dd>
            </div>
            <div>
              <dt>{t('diagnostics.electron')}</dt>
              <dd>{app.versions.electron}</dd>
            </div>
          </dl>
        ) : (
          <p>{t('load.loading')}</p>
        )}
      </div>
    </Dialog>
  )
}

/** A yes/no question for an action that cannot be undone. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  testId
}: {
  readonly open: boolean
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly testId?: string
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      testId={testId}
      footer={
        <>
          <button type="button" className="button" data-testid="confirm-cancel" onClick={onCancel}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="button button-primary"
            data-testid="confirm-ok"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  )
}
