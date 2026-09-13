import { app } from 'electron'
import type { DiagnosticItem, DiagnosticsReport, HealthStatus } from '@shared/schemas.js'
import { get, getDbPath } from '../core/db.js'
import { describeError, log } from '../core/logger.js'
import { isEncryptionAvailable } from '../core/secrets.js'
import { listPlugins } from '../plugins/engine.js'
import { listSkills } from '../skills/registry.js'
import { detectLocalAi, listProviders, testProvider } from '../ai/router.js'

/**
 * Diagnostics.
 *
 * Every line is the result of an actual check performed just now. Nothing is
 * reported as connected or healthy on the strength of configuration alone.
 */

export interface DiagnosticsHooks {
  browserStatus(): { ok: boolean; detail: string }
}

let hooks: DiagnosticsHooks = {
  browserStatus: () => ({ ok: false, detail: 'The browser core has not started' })
}

export function setDiagnosticsHooks(next: DiagnosticsHooks): void {
  hooks = next
}

export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const checkedAt = Date.now()
  const items: DiagnosticItem[] = []

  const item = (key: string, label: string, status: HealthStatus, detail: string): DiagnosticItem => ({
    key,
    label,
    status,
    detail,
    checkedAt: Date.now()
  })

  /* --- browser core --- */
  const browser = hooks.browserStatus()
  items.push(
    item('browser', 'Browser Core', browser.ok ? 'ok' : 'error', browser.detail)
  )

  /* --- database --- */
  try {
    const row = get('SELECT COUNT(*) AS count FROM missions')
    items.push(
      item('database', 'Database', 'ok', `SQLite at ${getDbPath()} — ${Number(row?.count ?? 0)} mission(s) stored`)
    )
  } catch (err) {
    items.push(item('database', 'Database', 'error', `Query failed: ${describeError(err)}`))
  }

  /* --- secure storage --- */
  const encrypted = isEncryptionAvailable()
  items.push(
    item(
      'secure-storage',
      'Secure Storage',
      encrypted ? 'ok' : 'degraded',
      encrypted
        ? 'OS keychain available — API keys are encrypted at rest'
        : 'No OS keychain on this system. API keys are stored unencrypted in the local database.'
    )
  )

  /* --- plugin engine --- */
  const plugins = listPlugins()
  const broken = plugins.filter((plugin) => plugin.health === 'error' || plugin.health === 'crashed')
  items.push(
    item(
      'plugin-engine',
      'Plugin Engine',
      broken.length === 0 ? 'ok' : 'degraded',
      `${plugins.length} plugin(s) installed, ${plugins.filter((p) => p.health === 'ok').length} running` +
        (broken.length > 0 ? `, ${broken.length} unhealthy` : '')
    )
  )
  items.push(
    item(
      'skill-registry',
      'Skill Registry',
      'ok',
      `${listSkills().length} skill(s) registered: ${listSkills().map((s) => s.id).join(', ') || 'none'}`
    )
  )

  for (const plugin of plugins) {
    const status: HealthStatus =
      plugin.health === 'ok'
        ? 'ok'
        : plugin.health === 'disabled'
          ? 'disabled'
          : plugin.health === 'starting'
            ? 'unknown'
            : 'error'
    const detail =
      plugin.health === 'ok'
        ? `v${plugin.version} — ${plugin.skillIds.length} skill(s): ${plugin.skillIds.join(', ') || 'none'}`
        : plugin.health === 'disabled'
          ? `v${plugin.version} — disabled by the user`
          : (plugin.error ?? `Health is "${plugin.health}"`)
    items.push(item(`plugin:${plugin.id}`, plugin.name, status, detail))
  }

  /* --- providers (real connection tests) --- */
  const providers = listProviders()
  if (providers.length === 0) {
    items.push(
      item('providers', 'AI Providers', 'unknown', 'No providers configured yet — add one in Settings')
    )
  }
  await Promise.all(
    providers.map(async (provider) => {
      if (!provider.enabled) {
        items.push(item(`provider:${provider.id}`, provider.label, 'disabled', 'Disabled in Settings'))
        return
      }
      try {
        const result = await testProvider(provider.id)
        items.push(
          item(
            `provider:${provider.id}`,
            provider.label,
            result.ok ? 'ok' : 'error',
            result.ok
              ? `Connected in ${result.latencyMs ?? 0}ms — ${result.message}`
              : `${result.message}${result.detail ? ` — ${result.detail}` : ''}`
          )
        )
      } catch (err) {
        items.push(item(`provider:${provider.id}`, provider.label, 'error', describeError(err)))
      }
    })
  )

  /* --- local AI --- */
  for (const detection of await detectLocalAi()) {
    items.push(
      item(
        `local:${detection.kind}`,
        detection.label,
        detection.status === 'detected' ? 'ok' : detection.status === 'error' ? 'error' : 'offline',
        detection.detail
      )
    )
  }

  /* --- runtime --- */
  items.push(
    item(
      'runtime',
      'Runtime',
      'ok',
      `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node} on ${process.platform}`
    )
  )
  items.push(item('userdata', 'User Data', 'ok', app.getPath('userData')))

  const report: DiagnosticsReport = { generatedAt: checkedAt, items }
  const failing = items.filter((entry) => entry.status === 'error')
  log.info('CORE', `Diagnostics run: ${items.length} checks, ${failing.length} failing`, {
    failing: failing.map((entry) => entry.key)
  })
  return report
}
