import { useEffect, useRef, useState } from 'react'
import type { GatewayStatus } from '@jupiter/contracts'
import { JupiterMark } from '@jupiter/ui'
import type { ViewId } from '../../shared/views'
import { AboutDialog, ShortcutsDialog } from './components/InfoDialogs'
import { Sidebar } from './components/Sidebar'
import { useNotify } from './components/Toasts'
import { TopBar } from './components/TopBar'
import { focusableWithin } from './components/Dialog'
import { destinationOf } from './destinations'
import { useI18n } from './i18n'
import { usePreferences } from './preferences'
import { useView } from './router'
import { useShortcuts } from './useShortcuts'
import { useRuntimeContext, type Loadable } from './useRuntime'
import { ChatView } from './views/ChatView'
import { DiagnosticsView } from './views/DiagnosticsView'
import { FeatureView } from './views/FeatureViews'
import { HomeView } from './views/HomeView'
import { ModelsView } from './views/ModelsView'
import { SettingsView } from './views/SettingsView'

/** How long the interface waits for saved preferences before showing defaults. */
const PREFERENCES_WAIT_MS = 2500

export function App() {
  const { t } = useI18n()
  const { view, navigate } = useView()
  const { status, retry } = useRuntimeContext()
  const prefs = usePreferences()
  const [dialog, setDialog] = useState<'shortcuts' | 'about' | null>(null)
  const [waited, setWaited] = useState(false)
  const main = useRef<HTMLElement>(null)
  const sidebarRegion = useRef<HTMLDivElement>(null)
  const topRegion = useRef<HTMLDivElement>(null)
  const firstView = useRef(true)
  const coreRunning = status.state === 'ready' && status.value.core.state === 'running'

  useEffect(() => {
    const timer = setTimeout(() => {
      setWaited(true)
    }, PREFERENCES_WAIT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [])
  const ready = prefs.status !== 'loading' || waited

  // The window title names the screen (shown in the Windows title bar and taskbar).
  useEffect(() => {
    document.title =
      view === 'home' ? t('app.name') : t('app.windowTitle', { view: t(destinationOf(view).label) })
  }, [view, t])

  // A new view starts at its top, and focus moves to its heading for keyboard and screen-reader users.
  useEffect(() => {
    if (!ready) return
    if (firstView.current) {
      firstView.current = false
      return
    }
    main.current?.scrollTo({ top: 0 })
    const heading = main.current?.querySelector<HTMLElement>('h1')
    ;(heading ?? main.current)?.focus({ preventScroll: true })
  }, [view, ready])

  useCoreToasts(status)

  const cycleRegion = (backwards: boolean) => {
    const regions = [sidebarRegion.current, topRegion.current, main.current].filter(
      (region): region is HTMLElement => region !== null
    )
    const index = regions.findIndex((region) => region.contains(document.activeElement))
    const next = regions[(index + (backwards ? -1 : 1) + regions.length) % regions.length]
    if (!next) return
    const target = next === main.current ? next : (focusableWithin(next)[0] ?? next)
    target.focus()
  }

  useShortcuts({
    navigate,
    toggleCompact: () => {
      void prefs.update('ui.compact', !prefs.values['ui.compact'])
    },
    showHelp: () => {
      setDialog('shortcuts')
    },
    cycleRegion
  })

  if (!ready) {
    return (
      <div className="splash" role="status" data-testid="splash">
        <JupiterMark size={96} tone="dim" />
        <p>{t('app.starting')}</p>
      </div>
    )
  }

  return (
    <div className="app">
      <button
        type="button"
        className="skip-link"
        data-testid="skip-link"
        onClick={() => {
          main.current?.focus()
        }}
      >
        {t('app.skipToContent')}
      </button>
      <div className="shell" data-compact={prefs.values['ui.compact']}>
        <div ref={sidebarRegion} className="sidebar-region">
          <Sidebar
            view={view}
            onNavigate={navigate}
            compact={prefs.values['ui.compact']}
            onToggleCompact={() => {
              void prefs.update('ui.compact', !prefs.values['ui.compact'])
            }}
          />
        </div>
        <div className="workspace">
          <div ref={topRegion}>
            <TopBar
              view={view}
              status={status}
              onNavigate={navigate}
              onShowShortcuts={() => {
                setDialog('shortcuts')
              }}
              onShowAbout={() => {
                setDialog('about')
              }}
            />
          </div>
          <main
            id="main"
            className="content"
            ref={main}
            tabIndex={-1}
            aria-label={t(destinationOf(view).label)}
            data-testid={`view-${view}`}
          >
            <ViewContent
              view={view}
              status={status}
              coreRunning={coreRunning}
              onRetry={retry}
              onNavigate={navigate}
            />
          </main>
        </div>
      </div>
      <ShortcutsDialog
        open={dialog === 'shortcuts'}
        onClose={() => {
          setDialog(null)
        }}
      />
      <AboutDialog
        open={dialog === 'about'}
        status={status}
        onClose={() => {
          setDialog(null)
        }}
      />
    </div>
  )
}

function ViewContent({
  view,
  status,
  coreRunning,
  onRetry,
  onNavigate
}: {
  readonly view: ViewId
  readonly status: Loadable<GatewayStatus>
  readonly coreRunning: boolean
  readonly onRetry: ReturnType<typeof useRuntimeContext>['retry']
  readonly onNavigate: (view: ViewId) => void
}) {
  switch (view) {
    case 'home':
      return <HomeView status={status} onRetry={onRetry} onNavigate={onNavigate} />
    case 'settings':
      return <SettingsView status={status} coreRunning={coreRunning} />
    case 'diagnostics':
      return <DiagnosticsView status={status} coreRunning={coreRunning} />
    case 'chat':
      return <ChatView onNavigate={onNavigate} />
    case 'models':
      return <ModelsView />
    default:
      return <FeatureView view={view} />
  }
}

/** Toasts (and, in the background, Windows notifications) when Jupiter Core stops or comes back. */
function useCoreToasts(status: Loadable<GatewayStatus>): void {
  const { t } = useI18n()
  const notify = useNotify()
  const previous = useRef<string | null>(null)
  const state = status.state === 'ready' ? status.value.core.state : null
  useEffect(() => {
    const before = previous.current
    previous.current = state
    if (before === null || state === null || before === state) return
    if (before === 'running' && state === 'crashed') {
      notify({
        tone: 'warning',
        title: t('toast.coreStopped'),
        message: t('toast.coreStoppedDetail'),
        desktop: true
      })
    } else if (before !== 'running' && state === 'running') {
      notify({ tone: 'success', title: t('toast.coreRunning'), desktop: true })
    }
  }, [state, notify, t])
}
