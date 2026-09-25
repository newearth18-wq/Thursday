import { Icon, JupiterMark } from '@jupiter/ui'
import type { ViewId } from '../../../shared/views'
import { DESTINATIONS, shortcutLabel, type Destination } from '../destinations'
import { useI18n } from '../i18n'

/**
 * Compact left navigation (Visual Design Lock v1). Every destination is a
 * real link to a screen. Screens that are not built yet are grouped under a
 * "Coming later" heading (announced with each of them) and say so again on
 * the screen itself. In compact mode (or
 * when the window is narrow) only icons show; each keeps its accessible name
 * and a tooltip.
 */
interface Props {
  readonly view: ViewId
  readonly onNavigate: (view: ViewId) => void
  readonly compact: boolean
  readonly onToggleCompact: () => void
}

export function Sidebar({ view, onNavigate, compact, onToggleCompact }: Props) {
  const { t } = useI18n()

  const link = (destination: Destination) => {
    const label = t(destination.label)
    const planned = destination.availability === 'COMING_LATER'
    const hint = [
      label,
      planned ? t('availability.COMING_LATER') : null,
      destination.shortcut ? shortcutLabel(destination.shortcut) : null
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <li key={destination.id}>
        <button
          type="button"
          className="nav-link"
          aria-current={view === destination.id ? 'page' : undefined}
          aria-describedby={planned ? 'nav-planned-heading' : undefined}
          title={hint}
          data-testid={`nav-${destination.id}`}
          data-availability={destination.availability}
          onClick={() => {
            onNavigate(destination.id)
          }}
        >
          <Icon name={destination.icon} />
          <span className="nav-label">{label}</span>
        </button>
      </li>
    )
  }

  const main = DESTINATIONS.filter((destination) => destination.group === 'main')

  return (
    <nav className="sidebar" aria-label={t('nav.label')} data-compact={compact}>
      <div className="brand">
        <JupiterMark size={32} />
        <span className="brand-name">{t('app.name')}</span>
      </div>
      <ul className="nav-list">
        {main.filter((destination) => destination.availability === 'available').map(link)}
      </ul>
      <p id="nav-planned-heading" className="nav-heading" data-testid="nav-planned-heading">
        {t('availability.COMING_LATER')}
      </p>
      <ul className="nav-list" aria-labelledby="nav-planned-heading">
        {main.filter((destination) => destination.availability === 'COMING_LATER').map(link)}
      </ul>
      <ul className="nav-list nav-list-system">
        {DESTINATIONS.filter((destination) => destination.group === 'system').map(link)}
        <li>
          <button
            type="button"
            className="nav-link nav-toggle"
            aria-pressed={compact}
            title={`${t(compact ? 'nav.expand' : 'nav.collapse')} · Ctrl+B`}
            data-testid="nav-toggle-compact"
            onClick={onToggleCompact}
          >
            <Icon name={compact ? 'sidebarExpand' : 'sidebarCollapse'} />
            <span className="nav-label">{t('nav.compactMode')}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}
