import type { ViewId } from '../../../shared/views'
import { request } from '../api'
import { useI18n } from '../i18n'
import { envelopeOf } from '../useRuntime'
import { Menu } from './Menu'
import { useNotify } from './Toasts'

/** The Jupiter menu: shortcuts, About, the log folder, Settings and Diagnostics — all real actions. */
export function AppMenu({
  onNavigate,
  onShowShortcuts,
  onShowAbout
}: {
  readonly onNavigate: (view: ViewId) => void
  readonly onShowShortcuts: () => void
  readonly onShowAbout: () => void
}) {
  const { t } = useI18n()
  const notify = useNotify()
  return (
    <Menu
      label={t('menu.label')}
      icon="menu"
      align="end"
      testId="app-menu"
      items={[
        {
          id: 'shortcuts',
          label: t('menu.shortcuts'),
          icon: 'keyboard',
          onSelect: onShowShortcuts
        },
        { id: 'about', label: t('menu.about'), icon: 'about', onSelect: onShowAbout },
        {
          id: 'logs',
          label: t('menu.openLogs'),
          icon: 'folder',
          onSelect: () => {
            request('host.logs.reveal', {}).then(
              (result) => {
                notify({ tone: 'success', title: t('menu.logsOpened'), message: result.path })
              },
              (error: unknown) => {
                notify({
                  tone: 'error',
                  title: t('menu.logsFailed'),
                  message: envelopeOf(error).message
                })
              }
            )
          }
        },
        {
          id: 'settings',
          label: t('nav.settings'),
          icon: 'settings',
          onSelect: () => {
            onNavigate('settings')
          }
        },
        {
          id: 'diagnostics',
          label: t('nav.diagnostics'),
          icon: 'diagnostics',
          onSelect: () => {
            onNavigate('diagnostics')
          }
        }
      ]}
    />
  )
}
