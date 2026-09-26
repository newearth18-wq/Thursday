import type { DatabaseSync } from 'node:sqlite'
import { ErrorEnvelope, ModelCapability, ModelInfo } from '@jupiter/contracts'
import type { DiscoveredModel, ProviderStore, StoredProvider } from '@jupiter/core'
import { integer, json, nullableNumber, nullableText, text } from '../rows'

/**
 * Configured AI providers and their models. API keys are not here: only the
 * id under which the host keeps a key in secure storage, and its fingerprint.
 */
export class SqliteProviderStore implements ProviderStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): StoredProvider[] {
    return this.db
      .prepare('SELECT * FROM ai_providers ORDER BY created_at, provider_id')
      .all()
      .map(toProvider)
  }

  get(providerId: string): StoredProvider | null {
    const row = this.db.prepare('SELECT * FROM ai_providers WHERE provider_id = ?').get(providerId)
    return row ? toProvider(row) : null
  }

  insert(provider: StoredProvider): void {
    this.db
      .prepare(
        `INSERT INTO ai_providers (
           provider_id, adapter_id, display_name, base_url, enabled, check_state, error_json, checked_at,
           credential_id, credential_fingerprint, credential_saved_at, credential_validation,
           credential_validated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        provider.providerId,
        provider.adapterId,
        provider.displayName,
        provider.baseUrl,
        provider.enabled ? 1 : 0,
        provider.checkState,
        provider.error ? JSON.stringify(provider.error) : null,
        provider.checkedAt,
        provider.credentialId,
        provider.credentialFingerprint,
        provider.credentialSavedAt,
        provider.credentialValidation,
        provider.credentialValidatedAt,
        provider.createdAt,
        provider.updatedAt
      )
  }

  update(
    providerId: string,
    changes: Partial<Omit<StoredProvider, 'providerId' | 'createdAt'>>
  ): void {
    const current = this.get(providerId)
    if (!current) throw new Error(`No provider ${providerId}`)
    const next: StoredProvider = { ...current, ...changes }
    this.db
      .prepare(
        `UPDATE ai_providers SET
           adapter_id = ?, display_name = ?, base_url = ?, enabled = ?, check_state = ?, error_json = ?,
           checked_at = ?, credential_id = ?, credential_fingerprint = ?, credential_saved_at = ?,
           credential_validation = ?, credential_validated_at = ?, updated_at = ?
         WHERE provider_id = ?`
      )
      .run(
        next.adapterId,
        next.displayName,
        next.baseUrl,
        next.enabled ? 1 : 0,
        next.checkState,
        next.error ? JSON.stringify(next.error) : null,
        next.checkedAt,
        next.credentialId,
        next.credentialFingerprint,
        next.credentialSavedAt,
        next.credentialValidation,
        next.credentialValidatedAt,
        next.updatedAt,
        providerId
      )
  }

  remove(providerId: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM ai_providers WHERE provider_id = ?').run(providerId).changes
      ) > 0
    )
  }

  models(providerId: string): ModelInfo[] {
    return this.db
      .prepare('SELECT * FROM ai_models WHERE provider_id = ? ORDER BY enabled DESC, model_id')
      .all(providerId)
      .map(toModel)
  }

  model(providerId: string, modelId: string): ModelInfo | null {
    const row = this.db
      .prepare('SELECT * FROM ai_models WHERE provider_id = ? AND model_id = ?')
      .get(providerId, modelId)
    return row ? toModel(row) : null
  }

  putModel(model: ModelInfo): void {
    this.db
      .prepare(
        `INSERT INTO ai_models (
           provider_id, model_id, display_name, capabilities_json, capability_source, enabled, discovered,
           context_window, input_cost_per_million, output_cost_per_million, observed_latency_ms, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_id, model_id) DO UPDATE SET
           display_name = excluded.display_name, capabilities_json = excluded.capabilities_json,
           capability_source = excluded.capability_source, enabled = excluded.enabled,
           discovered = excluded.discovered, context_window = excluded.context_window,
           input_cost_per_million = excluded.input_cost_per_million,
           output_cost_per_million = excluded.output_cost_per_million,
           observed_latency_ms = excluded.observed_latency_ms, updated_at = excluded.updated_at`
      )
      .run(
        model.providerId,
        model.modelId,
        model.displayName,
        JSON.stringify(model.capabilities),
        model.capabilitySource,
        model.enabled ? 1 : 0,
        model.discovered ? 1 : 0,
        model.contextWindow,
        model.inputCostPerMillion,
        model.outputCostPerMillion,
        model.observedLatencyMs,
        model.updatedAt
      )
  }

  mergeDiscovered(providerId: string, models: readonly DiscoveredModel[], at: string): number {
    let added = 0
    for (const found of models) {
      const known = this.model(providerId, found.modelId)
      if (known) {
        // Keep what the person chose; refresh what the provider reports.
        const reported = found.capabilities
        this.putModel({
          ...known,
          displayName: found.displayName ?? known.displayName,
          discovered: true,
          contextWindow: found.contextWindow ?? known.contextWindow,
          inputCostPerMillion: found.inputCostPerMillion ?? known.inputCostPerMillion,
          outputCostPerMillion: found.outputCostPerMillion ?? known.outputCostPerMillion,
          ...(reported && known.capabilitySource !== 'user'
            ? { capabilities: [...reported], capabilitySource: 'provider' as const }
            : {}),
          updatedAt: at
        })
        continue
      }
      added++
      this.putModel({
        providerId,
        modelId: found.modelId,
        displayName: found.displayName,
        capabilities: found.capabilities ? [...found.capabilities] : [],
        capabilitySource: found.capabilities ? 'provider' : 'none',
        enabled: false,
        discovered: true,
        contextWindow: found.contextWindow,
        inputCostPerMillion: found.inputCostPerMillion,
        outputCostPerMillion: found.outputCostPerMillion,
        observedLatencyMs: null,
        updatedAt: at
      })
    }
    return added
  }

  recordLatency(providerId: string, modelId: string, latencyMs: number, at: string): void {
    // Exponential moving average: recent replies count most, one slow reply does not dominate.
    this.db
      .prepare(
        `UPDATE ai_models SET
           observed_latency_ms = CASE WHEN observed_latency_ms IS NULL THEN ? ELSE observed_latency_ms * 0.7 + ? * 0.3 END,
           updated_at = ?
         WHERE provider_id = ? AND model_id = ?`
      )
      .run(latencyMs, latencyMs, at, providerId, modelId)
  }
}

function toProvider(row: Record<string, unknown>): StoredProvider {
  const errorJson = nullableText(row, 'error_json')
  const checkState = text(row, 'check_state')
  const validation = text(row, 'credential_validation')
  return {
    providerId: text(row, 'provider_id'),
    adapterId: text(row, 'adapter_id'),
    displayName: text(row, 'display_name'),
    baseUrl: text(row, 'base_url'),
    enabled: integer(row, 'enabled') === 1,
    checkState: checkState === 'ready' || checkState === 'failed' ? checkState : 'not-checked',
    error: errorJson === null ? null : ErrorEnvelope.parse(JSON.parse(errorJson)),
    checkedAt: nullableText(row, 'checked_at'),
    credentialId: nullableText(row, 'credential_id'),
    credentialFingerprint: nullableText(row, 'credential_fingerprint'),
    credentialSavedAt: nullableText(row, 'credential_saved_at'),
    credentialValidation:
      validation === 'valid' || validation === 'rejected' || validation === 'unknown'
        ? validation
        : 'not-validated',
    credentialValidatedAt: nullableText(row, 'credential_validated_at'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at')
  }
}

function toModel(row: Record<string, unknown>): ModelInfo {
  return ModelInfo.parse({
    providerId: text(row, 'provider_id'),
    modelId: text(row, 'model_id'),
    displayName: nullableText(row, 'display_name'),
    capabilities: ModelCapability.array().parse(json(row, 'capabilities_json')),
    capabilitySource: text(row, 'capability_source'),
    enabled: integer(row, 'enabled') === 1,
    discovered: integer(row, 'discovered') === 1,
    contextWindow: nullableNumber(row, 'context_window'),
    inputCostPerMillion: nullableNumber(row, 'input_cost_per_million'),
    outputCostPerMillion: nullableNumber(row, 'output_cost_per_million'),
    observedLatencyMs: nullableNumber(row, 'observed_latency_ms'),
    updatedAt: text(row, 'updated_at')
  })
}
