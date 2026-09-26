import type { ErrorEnvelope } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'

/**
 * A one-line summary, in the interface language, for the errors Jupiter
 * itself raises. The error's own message (technical, English, with real
 * details such as paths and system error codes) is always shown as well —
 * the summary explains, it never replaces the facts.
 */
const KNOWN_CODES = [
  'ADAPTER_NOT_INSTALLED',
  'BACKUP_FAILED',
  'BUILD_METADATA_INVALID',
  'BUILD_METADATA_MISMATCH',
  'CONVERSATION_NOT_FOUND',
  'CORE_CRASHED',
  'CORE_NO_REPLY',
  'CORE_START_FAILED',
  'CORE_START_TIMEOUT',
  'CORE_UNAVAILABLE',
  'CREDENTIAL_UNREADABLE',
  'DATABASE_CORRUPT',
  'DATABASE_MIGRATIONS_INCONSISTENT',
  'DATABASE_MIGRATION_FAILED',
  'DATABASE_MIGRATION_MODIFIED',
  'DATABASE_SCHEMA_NEWER',
  'DATABASE_UNREADABLE',
  'DEPENDENCY_UNAVAILABLE',
  'ENVIRONMENT_SETTING_IGNORED',
  'EVENT_PERSISTENCE_UNAVAILABLE',
  'GENERATION_INTERRUPTED',
  'GENERATION_IN_PROGRESS',
  'INSECURE_TRANSPORT',
  'LOG_DIRECTORY_UNAVAILABLE',
  'LOG_WRITE_FAILED',
  'NOTIFICATIONS_RATE_LIMITED',
  'NOTIFICATIONS_UNAVAILABLE',
  'NO_MODEL_AVAILABLE',
  'PERMISSION_DENIED',
  'PRIVACY_MODE_BLOCKED',
  'PROVIDER_KEY_MISSING',
  'PROVIDER_KEY_REJECTED',
  'PROVIDER_MODEL_NOT_FOUND',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_REQUEST_REJECTED',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_SERVER_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNREACHABLE',
  'SECURE_STORAGE_UNAVAILABLE',
  'STORAGE_NOT_WRITABLE',
  'TIMEOUT',
  'TOO_MANY_GENERATIONS'
] as const

export type KnownErrorCode = (typeof KNOWN_CODES)[number]

export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return (KNOWN_CODES as readonly string[]).includes(code)
}

/** The localized summary for a known error, or null for any other code. */
export function errorSummary(error: Pick<ErrorEnvelope, 'code'>, t: Translate): string | null {
  return isKnownErrorCode(error.code) ? t(`errorCode.${error.code}` as MessageKey) : null
}

export { KNOWN_CODES }
