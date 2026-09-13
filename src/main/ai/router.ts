import { randomUUID } from 'node:crypto'
import {
  type ConnectionResult,
  type LocalAiDetection,
  type ModelInfo,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderKind
} from '@shared/schemas.js'
import { all, get, run } from '../core/db.js'
import { describeError, log } from '../core/logger.js'
import { deleteSecret, getSecret, hasSecret, providerSecretKey, setSecret } from '../core/secrets.js'
import { createProvider, providerKindInfo, type ModelProvider } from './providers/index.js'

/**
 * Model Router.
 *
 * Owns provider configuration and hands out ready-to-use `ModelProvider`
 * adapters. Nothing above this layer knows which vendor is in play.
 */

function rowToConfig(row: Record<string, unknown>): ProviderConfig {
  const id = String(row.id)
  return {
    id,
    kind: String(row.kind) as ProviderKind,
    label: String(row.label),
    baseUrl: String(row.base_url ?? ''),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    enabled: Number(row.enabled) === 1,
    hasApiKey: hasSecret(providerSecretKey(id)),
    createdAt: Number(row.created_at)
  }
}

export function listProviders(): ProviderConfig[] {
  return all('SELECT * FROM providers ORDER BY created_at ASC').map(rowToConfig)
}

export function getProviderConfig(id: string): ProviderConfig | null {
  const row = get('SELECT * FROM providers WHERE id = ?', id)
  return row ? rowToConfig(row) : null
}

export function saveProvider(draft: ProviderDraft): ProviderConfig {
  const info = providerKindInfo(draft.kind)
  const existing = draft.id ? getProviderConfig(draft.id) : null
  const id = existing?.id ?? draft.id ?? randomUUID()
  const baseUrl = (draft.baseUrl ?? existing?.baseUrl ?? info.defaultBaseUrl).trim()

  if (baseUrl.length === 0) {
    throw new Error(
      `A base URL is required for "${info.label}". Example: ${info.defaultBaseUrl || 'https://your-host/v1'}`
    )
  }
  try {
    new URL(baseUrl)
  } catch {
    throw new Error(`"${baseUrl}" is not a valid base URL. Include the scheme, e.g. https://host/v1`)
  }

  if (existing) {
    run(
      'UPDATE providers SET kind = ?, label = ?, base_url = ?, model = ?, enabled = ? WHERE id = ?',
      draft.kind,
      draft.label,
      baseUrl,
      draft.model === undefined ? existing.model : draft.model,
      draft.enabled === undefined ? (existing.enabled ? 1 : 0) : draft.enabled ? 1 : 0,
      id
    )
  } else {
    run(
      'INSERT INTO providers(id, kind, label, base_url, model, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      draft.kind,
      draft.label,
      baseUrl,
      draft.model ?? null,
      draft.enabled === false ? 0 : 1,
      Date.now()
    )
  }

  // An empty string is an explicit "remove the key"; undefined leaves it alone.
  if (draft.apiKey !== undefined) {
    if (draft.apiKey.length > 0) setSecret(providerSecretKey(id), draft.apiKey)
    else deleteSecret(providerSecretKey(id))
  }

  const saved = getProviderConfig(id)
  if (!saved) throw new Error(`Provider ${id} could not be read back after saving`)
  log.info('MODEL', `Provider ${existing ? 'updated' : 'added'}: ${saved.label}`, {
    providerId: id,
    kind: saved.kind,
    baseUrl: saved.baseUrl,
    hasApiKey: saved.hasApiKey
  })
  return saved
}

export function deleteProvider(id: string): void {
  const config = getProviderConfig(id)
  if (!config) throw new Error(`No provider with id ${id}`)
  run('DELETE FROM providers WHERE id = ?', id)
  run('DELETE FROM provider_models WHERE provider_id = ?', id)
  deleteSecret(providerSecretKey(id))
  log.info('MODEL', `Provider removed: ${config.label}`, { providerId: id })
}

/** Build the live adapter for a stored provider. */
export function resolveProvider(id: string): ModelProvider {
  const config = getProviderConfig(id)
  if (!config) throw new Error(`No provider with id ${id}. Add it in Settings → AI Providers.`)
  return createProvider(config.kind, {
    id: config.id,
    label: config.label,
    baseUrl: config.baseUrl,
    apiKey: getSecret(providerSecretKey(config.id))
  })
}

export async function testProvider(id: string): Promise<ConnectionResult> {
  const config = getProviderConfig(id)
  if (!config) throw new Error(`No provider with id ${id}`)
  const provider = resolveProvider(id)
  const result = await provider.testConnection()
  if (result.ok) {
    log.info('MODEL', `Connection test passed for ${config.label}`, {
      providerId: id,
      latencyMs: result.latencyMs
    })
  } else {
    log.warn('MODEL', `Connection test failed for ${config.label}: ${result.message}`, {
      providerId: id,
      detail: result.detail
    })
  }
  return result
}

export async function fetchModels(
  id: string
): Promise<{ ok: boolean; models: ModelInfo[]; error: string | null }> {
  const config = getProviderConfig(id)
  if (!config) throw new Error(`No provider with id ${id}`)
  try {
    const models = await resolveProvider(id).listModels()
    run('DELETE FROM provider_models WHERE provider_id = ?', id)
    const now = Date.now()
    for (const model of models) {
      run(
        'INSERT OR REPLACE INTO provider_models(provider_id, model_id, label, cached_at) VALUES (?, ?, ?, ?)',
        id,
        model.id,
        model.label,
        now
      )
    }
    log.info('MODEL', `Fetched ${models.length} models from ${config.label}`, { providerId: id })
    return { ok: true, models, error: null }
  } catch (err) {
    const message = describeError(err)
    log.warn('MODEL', `Could not fetch models from ${config.label}: ${message}`, { providerId: id })
    return { ok: false, models: cachedModels(id), error: message }
  }
}

export function cachedModels(providerId: string): ModelInfo[] {
  return all(
    'SELECT model_id, label FROM provider_models WHERE provider_id = ? ORDER BY model_id',
    providerId
  ).map((row) => ({ id: String(row.model_id), label: String(row.label) }))
}

/* ---------------------------- local AI ---------------------------- */

const LOCAL_TARGETS: { kind: 'ollama' | 'lmstudio'; label: string; baseUrl: string }[] = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' }
]

/**
 * Probe the well-known local endpoints.
 *
 * A target is only ever reported as "detected" after a real HTTP round trip
 * succeeded — never because the port looks plausible.
 */
export async function detectLocalAi(): Promise<LocalAiDetection[]> {
  const results = await Promise.all(
    LOCAL_TARGETS.map(async (target): Promise<LocalAiDetection> => {
      const probe = createProvider(target.kind, {
        id: `probe-${target.kind}`,
        label: target.label,
        baseUrl: target.baseUrl,
        apiKey: null
      })
      try {
        const models = await probe.listModels(AbortSignal.timeout(4000))
        log.info('MODEL', `${target.label} detected at ${target.baseUrl}`, { models: models.length })
        return {
          kind: target.kind,
          label: target.label,
          baseUrl: target.baseUrl,
          status: 'detected',
          detail:
            models.length > 0
              ? `Running with ${models.length} model${models.length === 1 ? '' : 's'}`
              : 'Running, but no models are installed yet',
          models
        }
      } catch (err) {
        const message = describeError(err)
        // "Refused"/"timed out" means nothing is there; anything else is a
        // real fault worth distinguishing in the UI.
        const notRunning =
          message.includes('Connection refused') ||
          message.includes('Timed out') ||
          message.includes('could not be resolved')
        return {
          kind: target.kind,
          label: target.label,
          baseUrl: target.baseUrl,
          status: notRunning ? 'not_detected' : 'error',
          detail: notRunning ? `Not running at ${target.baseUrl}` : message,
          models: []
        }
      }
    })
  )
  return results
}
