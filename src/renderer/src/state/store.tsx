import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  BrowserState,
  CommandCenterState,
  GeneralSettings,
  LogEntry,
  Mission,
  PluginRecord,
  ProviderConfig,
  SkillDescriptor
} from '@shared/schemas.js'

/**
 * One store for everything the UI reads from the main process.
 *
 * Each slice is seeded with a real call and then kept current by the matching
 * event, so no screen ever shows stale state after an action elsewhere.
 */

export type Route = 'browser' | 'command' | 'workflows' | 'plugins' | 'settings' | 'diagnostics'

interface Store {
  route: Route
  setRoute(route: Route): void

  browser: BrowserState
  settings: GeneralSettings | null
  providers: ProviderConfig[]
  plugins: PluginRecord[]
  skills: SkillDescriptor[]
  missions: Mission[]
  command: CommandCenterState | null
  logs: LogEntry[]

  refreshProviders(): Promise<void>
  refreshMissions(): Promise<void>
  refreshLogs(): Promise<void>
  patchSettings(patch: Partial<GeneralSettings>): Promise<void>
  /** Errors raised by background refreshes, shown in the status bar. */
  lastError: string | null
  reportError(message: string | null): void
}

const StoreContext = createContext<Store | null>(null)

const EMPTY_BROWSER: BrowserState = { tabs: [], activeTabId: null }

export function StoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [route, setRoute] = useState<Route>('browser')
  const [browser, setBrowser] = useState<BrowserState>(EMPTY_BROWSER)
  const [settings, setSettings] = useState<GeneralSettings | null>(null)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [plugins, setPlugins] = useState<PluginRecord[]>([])
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [missions, setMissions] = useState<Mission[]>([])
  const [command, setCommand] = useState<CommandCenterState | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [lastError, setLastError] = useState<string | null>(null)

  const reportError = useCallback((message: string | null) => setLastError(message), [])

  const guard = useCallback(
    async (label: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (err) {
        setLastError(`${label}: ${(err as Error).message}`)
      }
    },
    []
  )

  const refreshProviders = useCallback(
    () => guard('Could not load providers', async () => setProviders(await window.thursday['providers:list']())),
    [guard]
  )
  const refreshMissions = useCallback(
    () => guard('Could not load missions', async () => setMissions(await window.thursday['missions:list']())),
    [guard]
  )
  const refreshLogs = useCallback(
    () =>
      guard('Could not load logs', async () =>
        setLogs(await window.thursday['logs:query']({ limit: 300 }))
      ),
    [guard]
  )

  const patchSettings = useCallback(
    (patch: Partial<GeneralSettings>) =>
      guard('Could not save settings', async () => {
        setSettings(await window.thursday['settings:set'](patch))
      }),
    [guard]
  )

  // Initial load.
  useEffect(() => {
    void (async () => {
      const api = window.thursday
      await guard('Startup load failed', async () => {
        const [
          browserState,
          loadedSettings,
          loadedProviders,
          loadedPlugins,
          loadedSkills,
          loadedMissions,
          commandState,
          loadedLogs
        ] = await Promise.all([
          api['browser:getState'](),
          api['settings:get'](),
          api['providers:list'](),
          api['plugins:list'](),
          api['skills:list'](),
          api['missions:list'](),
          api['commandcenter:state'](),
          api['logs:query']({ limit: 300 })
        ])
        setBrowser(browserState)
        setSettings(loadedSettings)
        setProviders(loadedProviders)
        setPlugins(loadedPlugins)
        setSkills(loadedSkills)
        setMissions(loadedMissions)
        setCommand(commandState)
        setLogs(loadedLogs)
      })
    })()
  }, [guard])

  // Live updates.
  useEffect(() => {
    const api = window.thursday
    const offs = [
      api.on('browser:state', setBrowser),
      api.on('plugins:update', setPlugins),
      api.on('skills:update', setSkills),
      api.on('commandcenter:update', setCommand),
      api.on('settings:update', setSettings),
      api.on('log:append', (entry) => setLogs((prev) => [entry, ...prev].slice(0, 300))),
      api.on('mission:update', (mission) =>
        setMissions((prev) => {
          const index = prev.findIndex((candidate) => candidate.id === mission.id)
          if (index === -1) return [mission, ...prev]
          const next = [...prev]
          next[index] = mission
          return next
        })
      ),
      api.on('missions:invalidate', () => {
        void window.thursday['missions:list']().then(setMissions)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const value = useMemo<Store>(
    () => ({
      route,
      setRoute,
      browser,
      settings,
      providers,
      plugins,
      skills,
      missions,
      command,
      logs,
      refreshProviders,
      refreshMissions,
      refreshLogs,
      patchSettings,
      lastError,
      reportError
    }),
    [
      route,
      browser,
      settings,
      providers,
      plugins,
      skills,
      missions,
      command,
      logs,
      refreshProviders,
      refreshMissions,
      refreshLogs,
      patchSettings,
      lastError,
      reportError
    ]
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside <StoreProvider>')
  return store
}

/** Run an async action, surfacing failures instead of swallowing them. */
export function useAction(): {
  busy: boolean
  error: string | null
  ok: string | null
  run(work: () => Promise<string | void>): Promise<void>
  reset(): void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (work: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setOk(null)
    try {
      const message = await work()
      if (mounted.current && typeof message === 'string') setOk(message)
    } catch (err) {
      if (mounted.current) setError((err as Error).message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  const reset = useCallback(() => {
    setError(null)
    setOk(null)
  }, [])

  return { busy, error, ok, run, reset }
}
