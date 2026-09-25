import { JupiterMark } from '@jupiter/ui'
import { useI18n, type MessageKey } from '../i18n'

export type View = 'home' | 'settings' | 'diagnostics'

/** Destinations from the Visual Design Lock that do not exist yet, with the SET that builds them. */
const PLANNED: readonly { readonly label: MessageKey; readonly set: number }[] = [
  { label: 'nav.missions', set: 4 },
  { label: 'nav.skills', set: 6 },
  { label: 'nav.memory', set: 11 },
  { label: 'nav.files', set: 10 },
  { label: 'nav.automations', set: 18 },
  { label: 'nav.aiModels', set: 3 },
  { label: 'nav.devices', set: 12 },
  { label: 'nav.plugins', set: 15 }
]

interface Props {
  readonly view: View
  readonly onNavigate: (view: View) => void
}

export function Sidebar({ view, onNavigate }: Props) {
  const { t } = useI18n()
  const link = (target: View, label: MessageKey) => (
    <li>
      <button
        type="button"
        className="nav-link"
        aria-current={view === target ? 'page' : undefined}
        data-testid={`nav-${target}`}
        onClick={() => {
          onNavigate(target)
        }}
      >
        {t(label)}
      </button>
    </li>
  )

  return (
    <nav className="sidebar" aria-label={t('nav.label')}>
      <div className="brand">
        <JupiterMark size={36} />
        <span>{t('app.name')}</span>
      </div>
      <ul className="nav-list">
        {link('home', 'nav.home')}
        {PLANNED.map((item) => (
          // Not a control: an unavailable destination must not look clickable.
          <li
            key={item.label}
            className="nav-planned"
            aria-disabled="true"
            title={t('nav.plannedFor', { set: item.set })}
            data-testid="nav-planned"
          >
            <span>{t(item.label)}</span>
            <span className="badge badge-muted">{t('availability.COMING_LATER')}</span>
          </li>
        ))}
        {link('settings', 'nav.settings')}
        {link('diagnostics', 'nav.diagnostics')}
      </ul>
    </nav>
  )
}
