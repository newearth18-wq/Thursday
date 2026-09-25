import { useEffect } from 'react'
import { AddressBar, BrowserStage, TabStrip } from './components/BrowserChrome.js'
import { NavRail, StatusBar } from './components/Shell.js'
import { Sidebar } from './components/Sidebar.js'
import { CommandCenter } from './views/CommandCenter.js'
import { Diagnostics } from './views/Diagnostics.js'
import { Plugins } from './views/Plugins.js'
import { Settings } from './views/Settings.js'
import { Workflows } from './views/Workflows.js'
import { useStore } from './state/store.js'

export function App(): JSX.Element {
  const { route } = useStore()

  /**
   * Web pages live in a native view stacked above this document, so they must
   * be hidden whenever a full-screen panel is showing — otherwise the page
   * would punch straight through the UI.
   */
  useEffect(() => {
    if (route === 'browser') return
    void window.thursday['browser:setViewport']({ x: 0, y: 0, width: 0, height: 0, visible: false })
  }, [route])

  return (
    <div className="app">
      <NavRail />
      <div className="main">
        <div className="workspace">
          <div className="stage">
            {route === 'browser' ? (
              <>
                <TabStrip />
                <AddressBar />
                <BrowserStage />
              </>
            ) : null}
            {route === 'command' ? <CommandCenter /> : null}
            {route === 'workflows' ? <Workflows /> : null}
            {route === 'plugins' ? <Plugins /> : null}
            {route === 'settings' ? <Settings /> : null}
            {route === 'diagnostics' ? <Diagnostics /> : null}
          </div>
          <Sidebar />
        </div>
        <StatusBar />
      </div>
    </div>
  )
}
