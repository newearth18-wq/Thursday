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
import {
  SettingDefaults,
  SettingDefinitions,
  type ErrorEnvelope,
  type SettingKey,
  type SettingValue
} from '@jupiter/contracts'
import { request } from './api'
import { coreSessionOf, envelopeOf, useRuntimeContext } from './useRuntime'

/**
 * Interface preferences (SET 2): language, theme, text size, compact mode,
 * Reduce Motion, avatar mode, desktop notifications.
 *
 * Jupiter Core stores them (validated settings, `settings.update`, audited).
 * The interface applies a change at once. If saving fails — for example
 * while Core is restarting or the database is unavailable — the change stays
 * applied for this session and is reported as not saved; when preferences can
 * be read again, such changes are kept and saved then. Nothing claims a change
 * was saved before Core confirms it.
 */

export const PREFERENCE_KEYS = [
  'ui.language',
  'ui.theme',
  'ui.textScale',
  'ui.compact',
  'ui.reduceMotion',
  'ui.avatar',
  'notifications.desktop'
] as const satisfies readonly SettingKey[]

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number]
export type Preferences = { readonly [K in PreferenceKey]: SettingValue<K> }

export type PreferencesStatus = 'loading' | 'ready' | 'unavailable'

export interface PreferencesData {
  readonly values: Preferences
  readonly status: PreferencesStatus
  /** Why the stored preferences could not be read (defaults are in use). */
  readonly loadError: ErrorEnvelope | null
  /** Applied for this session, but saving failed. */
  readonly unsaved: ReadonlySet<PreferenceKey>
  update<K extends PreferenceKey>(key: K, value: SettingValue<K>): Promise<ErrorEnvelope | null>
}

export function defaultPreferences(): Preferences {
  const values: Partial<Record<PreferenceKey, unknown>> = {}
  for (const key of PREFERENCE_KEYS) values[key] = SettingDefaults[key]
  return values as Preferences
}

/** Merge validated stored values over the defaults; anything invalid keeps its default. */
export function preferencesFrom(records: readonly { key: string; value: unknown }[]): Preferences {
  const values: Record<string, unknown> = { ...defaultPreferences() }
  for (const record of records) {
    if (!(PREFERENCE_KEYS as readonly string[]).includes(record.key)) continue
    const key = record.key as PreferenceKey
    const parsed = SettingDefinitions[key].safeParse(record.value)
    if (parsed.success) values[key] = parsed.data
  }
  return values as Preferences
}

const PreferencesContext = createContext<PreferencesData>({
  values: defaultPreferences(),
  status: 'loading',
  loadError: null,
  unsaved: new Set(),
  update: () => Promise.resolve(null)
})

export function usePreferences(): PreferencesData {
  return useContext(PreferencesContext)
}

export function PreferencesProvider({ children }: { readonly children: ReactNode }) {
  const { status: runtime } = useRuntimeContext()
  const coreSession = coreSessionOf(runtime)
  const coreDown =
    runtime.state === 'error' ||
    (runtime.state === 'ready' &&
      (runtime.value.core.state === 'crashed' || runtime.value.core.state === 'stopped'))
  const databaseHealthy =
    runtime.state === 'ready' &&
    runtime.value.runtime.services.some(
      (service) => service.serviceId === 'database' && service.status === 'HEALTHY'
    )
  // Load when Core (re)starts and when the database comes back.
  const loadKey = coreSession === null ? null : `${coreSession}|${String(databaseHealthy)}`

  const [values, setValues] = useState<Preferences>(defaultPreferences)
  const [loaded, setLoaded] = useState<{ key: string; error: ErrorEnvelope | null } | null>(null)
  const [unsaved, setUnsaved] = useState<ReadonlySet<PreferenceKey>>(new Set())
  const latest = useRef({ values, unsaved })
  useEffect(() => {
    latest.current = { values, unsaved }
  }, [values, unsaved])

  const update = useCallback(async <K extends PreferenceKey>(key: K, value: SettingValue<K>) => {
    setValues((previous) => ({ ...previous, [key]: value }))
    try {
      await request('settings.update', { key, value } as never)
      setUnsaved((previous) => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
      return null
    } catch (error) {
      setUnsaved((previous) => new Set(previous).add(key))
      return envelopeOf(error)
    }
  }, [])

  useEffect(() => {
    if (loadKey === null) return
    let active = true
    request('settings.list', {}).then(
      (result) => {
        if (!active) return
        // Changes made while they could not be saved stay in effect, and are saved now.
        const { values: current, unsaved: pending } = latest.current
        const merged: Record<string, unknown> = { ...preferencesFrom(result.settings) }
        for (const key of pending) merged[key] = current[key]
        setValues(merged as Preferences)
        setLoaded({ key: loadKey, error: null })
        for (const key of pending) void update(key, current[key])
      },
      (error: unknown) => {
        if (active) setLoaded({ key: loadKey, error: envelopeOf(error) })
      }
    )
    return () => {
      active = false
    }
  }, [loadKey, update])

  const status: PreferencesStatus = coreDown
    ? 'unavailable'
    : loaded === null
      ? 'loading'
      : loaded.error
        ? 'unavailable'
        : 'ready'

  const value = useMemo<PreferencesData>(
    () => ({ values, status, loadError: loaded?.error ?? null, unsaved, update }),
    [values, status, loaded, unsaved, update]
  )

  useApplyToDocument(values)
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

/** Whether non-essential motion is off: the preference, or the operating system's setting under `system`. */
export function useReducedMotion(preference: Preferences['ui.reduceMotion']): boolean {
  const [systemReduced, setSystemReduced] = useState(() => systemPrefersReducedMotion())
  useEffect(() => {
    const query = mediaQuery('(prefers-reduced-motion: reduce)')
    if (!query) return
    const onChange = () => {
      setSystemReduced(query.matches)
    }
    query.addEventListener('change', onChange)
    return () => {
      query.removeEventListener('change', onChange)
    }
  }, [])
  return preference === 'on' || (preference === 'system' && systemReduced)
}

function mediaQuery(query: string): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

function systemPrefersReducedMotion(): boolean {
  return mediaQuery('(prefers-reduced-motion: reduce)')?.matches ?? false
}

/** Preferences take effect through attributes on <html>, which the stylesheet reads. */
function useApplyToDocument(values: Preferences): void {
  const reduced = useReducedMotion(values['ui.reduceMotion'])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = values['ui.theme']
    root.dataset.compact = String(values['ui.compact'])
    root.dataset.motion = reduced ? 'reduced' : 'full'
    root.dataset.avatar = values['ui.avatar']
    root.style.fontSize = `${values['ui.textScale']}%`
  }, [values, reduced])
}
