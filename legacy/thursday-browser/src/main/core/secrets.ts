import { safeStorage } from 'electron'
import { get, getDb, run } from './db.js'
import { log } from './logger.js'

/**
 * Secret storage for provider API keys.
 *
 * Keys are encrypted with Electron `safeStorage`, which is backed by the OS
 * keychain (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux).
 * When no OS keyring is available we still store the key so the app works,
 * but we record that it is unencrypted and Diagnostics reports it plainly
 * rather than implying the key is protected.
 */

let encryptionAvailable: boolean | null = null

export function isEncryptionAvailable(): boolean {
  if (encryptionAvailable === null) {
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable()
    } catch {
      encryptionAvailable = false
    }
    if (!encryptionAvailable) {
      log.warn(
        'CORE',
        'OS secure storage is unavailable; API keys will be stored unencrypted in the local database',
        { platform: process.platform }
      )
    }
  }
  return encryptionAvailable
}

export function setSecret(key: string, value: string): void {
  if (value.length === 0) {
    deleteSecret(key)
    return
  }
  const encrypt = isEncryptionAvailable()
  const buffer = encrypt ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8')
  getDb()
    .prepare(
      'INSERT INTO secrets(key, value, encrypted) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted'
    )
    .run(key, new Uint8Array(buffer), encrypt ? 1 : 0)
}

export function getSecret(key: string): string | null {
  const row = get('SELECT value, encrypted FROM secrets WHERE key = ?', key) as
    | { value: Uint8Array; encrypted: number }
    | undefined
  if (!row) return null
  const buffer = Buffer.from(row.value)
  if (row.encrypted !== 1) return buffer.toString('utf8')
  try {
    return safeStorage.decryptString(buffer)
  } catch (err) {
    log.error('CORE', `Stored secret "${key}" could not be decrypted`, {
      reason: (err as Error).message
    })
    return null
  }
}

export function hasSecret(key: string): boolean {
  return get('SELECT 1 AS present FROM secrets WHERE key = ?', key) !== undefined
}

export function deleteSecret(key: string): void {
  run('DELETE FROM secrets WHERE key = ?', key)
}

export const providerSecretKey = (providerId: string): string => `provider:${providerId}:apiKey`
