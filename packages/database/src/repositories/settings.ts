import type { DatabaseSync } from 'node:sqlite'
import { Actor } from '@jupiter/contracts'
import type { SettingsStore, StoredSetting } from '@jupiter/core'
import { json, text } from '../rows'

export class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): StoredSetting[] {
    return this.db
      .prepare('SELECT key, value_json, updated_at, updated_by FROM settings ORDER BY key')
      .all()
      .map(toSetting)
  }

  get(key: string): StoredSetting | null {
    const row = this.db
      .prepare('SELECT key, value_json, updated_at, updated_by FROM settings WHERE key = ?')
      .get(key)
    return row ? toSetting(row) : null
  }

  put(key: string, value: unknown, actor: Actor, at: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      )
      .run(key, JSON.stringify(value), at, JSON.stringify(actor))
  }
}

function toSetting(row: Record<string, unknown>): StoredSetting {
  return {
    key: text(row, 'key'),
    value: json(row, 'value_json'),
    updatedAt: text(row, 'updated_at'),
    updatedBy: Actor.parse(json(row, 'updated_by'))
  }
}
