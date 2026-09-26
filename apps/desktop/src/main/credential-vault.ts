import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { Uuidv7, type SecureStorageStatus } from '@jupiter/contracts'
import { JupiterError, describeError, type Logger } from '@jupiter/core'

/**
 * API keys, kept with the operating system's secure storage (SET 3).
 *
 * Electron's `safeStorage` encrypts with a key the operating system protects:
 * DPAPI on Windows (bound to the signed-in user), the Keychain on macOS, and
 * the Secret Service (GNOME Keyring / KWallet) on Linux. Each key is stored
 * as one ciphertext file, `<data folder>/credentials/<credentialId>.bin`,
 * readable only by the user; the plaintext exists only in memory, only for
 * the request that needs it.
 *
 * When no OS-backed store is available — on Linux Chromium then falls back
 * to a hard-coded password (`basic_text`), which is not protection — Jupiter
 * refuses to store keys and says so, instead of pretending.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only. */
  getSelectedStorageBackend?(): string
}

/** Linux backends that are not real protection. */
const UNPROTECTED_BACKENDS = new Set(['basic_text', 'unknown'])

export class CredentialVault {
  private readonly log: Logger

  constructor(
    private readonly directory: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly platform: NodeJS.Platform,
    logger: Logger
  ) {
    this.log = logger.child({ component: 'credential-vault' })
  }

  status(): SecureStorageStatus {
    const backend = this.backend()
    let available: boolean
    try {
      available = this.safeStorage.isEncryptionAvailable()
    } catch (error) {
      return {
        available: false,
        backend: 'unavailable',
        reason: `The operating system's secure storage could not be checked: ${describeError(error)}`
      }
    }
    if (!available)
      return {
        available: false,
        backend: 'unavailable',
        reason:
          this.platform === 'linux'
            ? 'No secret service (such as GNOME Keyring or KWallet) is running and unlocked, so API keys cannot be protected.'
            : 'The operating system did not make its secure storage available to Jupiter.'
      }
    if (UNPROTECTED_BACKENDS.has(backend))
      return {
        available: false,
        backend: 'unavailable',
        reason:
          'Only an unprotected fallback store is available, so Jupiter does not store API keys. Start a secret service (such as GNOME Keyring) and restart Jupiter.'
      }
    return { available: true, backend, reason: null }
  }

  /** Returns the key's fingerprint: the first 8 hex characters of its SHA-256. */
  store(credentialId: string, secret: string): string {
    const file = this.fileFor(credentialId)
    const status = this.status()
    if (!status.available) throw unavailable(status.reason)
    const ciphertext = this.safeStorage.encryptString(secret)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${String(process.pid)}.tmp`
    try {
      writeFileSync(temporary, ciphertext, { mode: 0o600 })
      renameSync(temporary, file)
      chmodSync(file, 0o600)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw new JupiterError(
        'CREDENTIAL_WRITE_FAILED',
        `The API key could not be saved: ${describeError(error)}`,
        {
          category: 'dependency',
          userAction: `Make sure ${this.directory} is writable, then try again.`,
          retryable: true
        }
      )
    }
    this.log.info('credential.stored', 'Stored an API key in secure storage', {
      credentialId,
      backend: status.backend
    })
    return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8)
  }

  read(credentialId: string): string {
    const file = this.fileFor(credentialId)
    if (!existsSync(file))
      throw new JupiterError('CREDENTIAL_NOT_FOUND', 'The saved API key is missing.', {
        category: 'configuration',
        userAction: 'Save the API key again in AI models.'
      })
    const status = this.status()
    if (!status.available) throw unavailable(status.reason)
    try {
      return this.safeStorage.decryptString(readFileSync(file))
    } catch (error) {
      throw new JupiterError(
        'CREDENTIAL_UNREADABLE',
        `The saved API key could not be decrypted: ${describeError(error)}`,
        {
          category: 'configuration',
          userAction:
            'Keys can only be read by the Windows account that saved them. Save the API key again in AI models.'
        }
      )
    }
  }

  delete(credentialId: string): boolean {
    const file = this.fileFor(credentialId)
    if (!existsSync(file)) return false
    rmSync(file, { force: true })
    this.log.info('credential.deleted', 'Removed an API key from secure storage', { credentialId })
    return true
  }

  private backend(): string {
    if (this.platform === 'win32') return 'dpapi'
    if (this.platform === 'darwin') return 'keychain'
    try {
      return this.safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /** Credential ids are UUIDv7: the file name can never leave the credentials folder. */
  private fileFor(credentialId: string): string {
    if (!Uuidv7.safeParse(credentialId).success)
      throw new JupiterError('INVALID_CREDENTIAL_ID', 'Invalid credential id.', {
        category: 'validation',
        userAction: null
      })
    return join(this.directory, `${credentialId}.bin`)
  }
}

function unavailable(reason: string | null): JupiterError {
  return new JupiterError(
    'SECURE_STORAGE_UNAVAILABLE',
    `Jupiter cannot store API keys on this computer: ${reason ?? 'no secure storage is available'}`,
    {
      category: 'dependency',
      userAction:
        'Providers without a key (for example on this computer) still work. On Windows, sign in with your normal account.',
      retryable: false
    }
  )
}
