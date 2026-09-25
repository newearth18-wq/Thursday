import type { GatewayStatus } from '@jupiter/contracts'
import { Icon } from '@jupiter/ui'
import type { ViewId } from '../../../shared/views'
import { destinationOf } from '../destinations'
import { useI18n, type MessageKey } from '../i18n'
import { useNetworkStatus } from '../useNetworkStatus'
import type { Loadable } from '../useRuntime'
import { AppMenu } from './AppMenu'

/**
 * The bar above every screen: where you are, and two truthful indicators —
 * the network connection (from Chromium) and Jupiter Core (from the host's
 * gateway status) — plus the Jupiter menu. It adds no information of its
 * own: every value is read from the system.
 */
interface Props {
  readonly view: ViewId
  readonly status: Loadable<GatewayStatus>
  readonly onNavigate: (view: ViewId) => void
  readonly onShowShortcuts: () => void
  readonly onShowAbout: () => void
}

type CoreIndicator = 'running' | 'starting' | 'stopped' | 'unknown'

function coreIndicator(status: Loadable<GatewayStatus>): CoreIndicator {
  if (status.state !== 'ready') return 'unknown'
  const state = status.value.core.state
  if (state === 'running') return 'running'
  if (state === 'starting' || state === 'stopping') return 'starting'
  return 'stopped'
}

export function TopBar({ view, status, onNavigate, onShowShortcuts, onShowAbout }: Props) {
  const { t } = useI18n()
  const online = useNetworkStatus()
  const core = coreIndicator(status)
  const overall = status.state === 'ready' ? status.value.runtime.overall : null

  return (
    <header className="top-bar" data-testid="top-bar">
      <p className="top-bar-title" aria-hidden="true">
        {t(destinationOf(view).label)}
      </p>
      <ul className="indicators" aria-label={t('indicators.label')}>
        <li
          className={`indicator indicator-${online ? 'ok' : 'warning'}`}
          data-testid="indicator-network"
          data-state={online ? 'online' : 'offline'}
          title={t(online ? 'indicators.onlineHint' : 'indicators.offlineHint')}
        >
          <Icon name={online ? 'online' : 'offline'} size={16} />
          <span>{t(online ? 'indicators.online' : 'indicators.offline')}</span>
        </li>
        <li
          className={`indicator indicator-${core === 'running' ? (overall === 'HEALTHY' ? 'ok' : 'warning') : core === 'stopped' ? 'error' : 'muted'}`}
          data-testid="indicator-core"
          data-state={core}
          data-overall={overall ?? ''}
        >
          <span className="indicator-dot" aria-hidden="true" />
          <span>{t(`indicators.core.${core}` as MessageKey)}</span>
        </li>
      </ul>
      <AppMenu
        onNavigate={onNavigate}
        onShowShortcuts={onShowShortcuts}
        onShowAbout={onShowAbout}
      />
    </header>
  )
}
