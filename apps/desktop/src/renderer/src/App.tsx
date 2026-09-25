import { useEffect, useRef, useState } from 'react'
import { Sidebar, type View } from './components/Sidebar'
import { useI18n } from './i18n'
import { useRuntime } from './useRuntime'
import { DiagnosticsView } from './views/DiagnosticsView'
import { HomeView } from './views/HomeView'
import { SettingsView } from './views/SettingsView'

export function App() {
  const { t } = useI18n()
  const [view, setView] = useState<View>('home')
  const { status, retry } = useRuntime()
  const main = useRef<HTMLElement>(null)
  const firstRender = useRef(true)

  useEffect(() => {
    const titles: Record<View, string> = {
      home: t('app.name'),
      settings: `${t('settings.title')} — ${t('app.name')}`,
      diagnostics: `${t('diagnostics.title')} — ${t('app.name')}`
    }
    document.title = titles[view]
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    // A new view starts at its top (the content area is shared between views), and focus
    // moves to it for keyboard and screen-reader users.
    main.current?.scrollTo({ top: 0 })
    main.current?.focus({ preventScroll: true })
  }, [view, t])

  const coreRunning = status.state === 'ready' && status.value.core.state === 'running'

  return (
    <div className="shell">
      <Sidebar view={view} onNavigate={setView} />
      <main className="content" ref={main} tabIndex={-1} data-testid={`view-${view}`}>
        {view === 'home' ? <HomeView status={status} onRetry={retry} onNavigate={setView} /> : null}
        {view === 'diagnostics' ? (
          <DiagnosticsView status={status} coreRunning={coreRunning} />
        ) : null}
        {view === 'settings' ? <SettingsView status={status} coreRunning={coreRunning} /> : null}
      </main>
    </div>
  )
}
