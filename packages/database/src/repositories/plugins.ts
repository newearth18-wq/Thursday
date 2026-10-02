import type { DatabaseSync } from 'node:sqlite'
import { ErrorEnvelope, PluginId, PluginSource } from '@jupiter/contracts'
import type { PluginStore, StoredPlugin } from '@jupiter/core'
import { integer, nullableText, text } from '../rows'

type Row = Record<string, unknown>

/** Installed plugins (SET 15). Validated on read: a damaged row never reaches Core as valid. */
export class SqlitePluginStore implements PluginStore {
  constructor(private readonly db: DatabaseSync) {}

  get(pluginId: string): StoredPlugin | null {
    const row = this.db.prepare('SELECT * FROM plugins WHERE plugin_id = ?').get(pluginId)
    return row ? pluginOf(row) : null
  }

  list(): StoredPlugin[] {
    return this.db
      .prepare('SELECT * FROM plugins ORDER BY plugin_id')
      .all()
      .map((row) => pluginOf(row as Row))
  }

  put(plugin: StoredPlugin): void {
    this.db
      .prepare(
        `INSERT INTO plugins (plugin_id, version, source, enabled, manifest_json, installed_at,
           updated_at, verified_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (plugin_id) DO UPDATE SET version = excluded.version,
           source = excluded.source, enabled = excluded.enabled,
           manifest_json = excluded.manifest_json, updated_at = excluded.updated_at,
           verified_at = excluded.verified_at, last_error = excluded.last_error`
      )
      .run(
        PluginId.parse(plugin.pluginId),
        plugin.version,
        PluginSource.parse(plugin.source),
        plugin.enabled ? 1 : 0,
        plugin.manifestJson,
        plugin.installedAt,
        plugin.updatedAt,
        plugin.verifiedAt,
        plugin.lastError ? JSON.stringify(plugin.lastError) : null
      )
  }

  setEnabled(pluginId: string, enabled: boolean, at: string): void {
    this.db
      .prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE plugin_id = ?')
      .run(enabled ? 1 : 0, at, pluginId)
  }

  setVerified(pluginId: string, at: string): void {
    this.db.prepare('UPDATE plugins SET verified_at = ? WHERE plugin_id = ?').run(at, pluginId)
  }

  setLastError(pluginId: string, error: ErrorEnvelope | null, at: string): void {
    this.db
      .prepare('UPDATE plugins SET last_error = ?, updated_at = ? WHERE plugin_id = ?')
      .run(error ? JSON.stringify(error) : null, at, pluginId)
  }

  remove(pluginId: string): boolean {
    return (
      Number(this.db.prepare('DELETE FROM plugins WHERE plugin_id = ?').run(pluginId).changes) > 0
    )
  }
}

function pluginOf(row: Row): StoredPlugin {
  const error = nullableText(row, 'last_error')
  return {
    pluginId: PluginId.parse(text(row, 'plugin_id')),
    version: text(row, 'version'),
    source: PluginSource.parse(text(row, 'source')),
    enabled: integer(row, 'enabled') === 1,
    manifestJson: text(row, 'manifest_json'),
    installedAt: text(row, 'installed_at'),
    updatedAt: text(row, 'updated_at'),
    verifiedAt: nullableText(row, 'verified_at'),
    lastError: error === null ? null : ErrorEnvelope.parse(JSON.parse(error))
  }
}
