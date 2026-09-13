import { app } from 'electron'
import { GeneralSettings } from '@shared/schemas.js'
import { all, run } from './db.js'
import { emit } from './events.js'
import { publishCommandCenter } from './app-state.js'
import { log } from './logger.js'
import { setLogRetention } from './logger.js'

let cache: GeneralSettings | null = null

function defaults(): GeneralSettings {
  return GeneralSettings.parse({ downloadDir: app.getPath('downloads') })
}

export function loadSettings(): GeneralSettings {
  if (cache) return cache
  const rows = all('SELECT key, value FROM settings')
  const raw: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      raw[String(row.key)] = JSON.parse(String(row.value))
    } catch {
      // A corrupt single key must not take the whole settings object down.
      log.warn('CORE', `Ignoring unreadable setting "${String(row.key)}"`)
    }
  }
  const merged = { ...defaults(), ...raw }
  const parsed = GeneralSettings.safeParse(merged)
  if (!parsed.success) {
    log.warn('CORE', 'Stored settings failed validation; falling back to defaults', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    })
    cache = defaults()
  } else {
    cache = parsed.data
  }
  setLogRetention(cache.logRetention)
  return cache
}

export function updateSettings(patch: Partial<GeneralSettings>): GeneralSettings {
  const current = loadSettings()
  const next = GeneralSettings.parse({ ...current, ...patch })
  for (const [key, value] of Object.entries(next)) {
    run(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value)
    )
  }
  cache = next
  setLogRetention(next.logRetention)
  emit('settings:update', next)
  // The Command Center shows the selected model, so it must follow the change.
  publishCommandCenter()
  log.info('CORE', 'Settings updated', { keys: Object.keys(patch) })
  return next
}
