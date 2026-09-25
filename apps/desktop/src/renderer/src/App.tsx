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
  const { info, runtime, retry } = useRuntime()
  const main = useRef<HTMLElement>(null)
  const firstRender = useRef(true)

  useEffect(() => {
    const titles: Record<View, string> = {
      home: t('app.name'),
      settings: `${t('settings.title')} — ${t('app.name')}`,
      diagnostics: `${t('diagnostics.title')} — ${t('app.name')}`
    }
    document.title = titles[view]
    // Move focus to the new content for keyboard and screen-reader users.
    if (firstRender.current) firstRender.current = false
    else main.current?.focus()
  }, [view, t])

  return (
    <div className="shell">
      <Sidebar view={view} onNavigate={setView} />
      <main className="content" ref={main} tabIndex={-1} data-testid={`view-${view}`}>
        {view === 'home' ? (
          <HomeView info={info} runtime={runtime} onRetry={retry} onNavigate={setView} />
        ) : null}
        {view === 'diagnostics' ? <DiagnosticsView info={info} runtime={runtime} /> : null}
        {view === 'settings' ? <SettingsView info={info} /> : null}
      </main>
    </div>
  )
}
