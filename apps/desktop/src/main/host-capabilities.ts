import { mkdirSync } from 'node:fs'
import {
  Capabilities,
  DesktopNotification,
  HostOperations,
  type CoreToHost,
  type ErrorEnvelope
} from '@jupiter/contracts'
import { JupiterError, createErrorEnvelope, describeError, type Logger } from '@jupiter/core'
import type { CredentialVault } from './credential-vault'

/**
 * Privileged host functions, executed only when Jupiter Core's capability
 * dispatcher asks for them over the Core port — never directly from the
 * renderer. The dispatcher has already authorized, validated and audited the
 * request; the host validates the input and output again and acts only on
 * fixed targets it chooses itself (no paths come from the request).
 *
 * SET 2 adds the Windows-notification bridge: plain-text desktop
 * notifications, limited in size (by the contract) and in rate (here).
 *
 * SET 3 adds secure storage for API keys. Its status is a capability the
 * interface may query; storing, reading and deleting keys are host
 * operations only Jupiter Core itself performs (they are not in the
 * capability catalogue), and the host checks that the caller is Core.
 */

export type HostCall = Extract<CoreToHost, { kind: 'host-call' }>
export type HostOutcome = { ok: true; data: unknown } | { ok: false; error: ErrorEnvelope }

export interface DesktopNotifier {
  /** Whether the operating system can show notifications (Electron's Notification.isSupported()). */
  isSupported(): boolean
  show(notification: DesktopNotification): void
}

export interface HostCapabilityDependencies {
  readonly logger: Logger
  readonly logsDirectory: string
  /** Electron's shell.openPath: resolves to an empty string on success, or an error message. */
  readonly openPath: (path: string) => Promise<string>
  readonly notifier: DesktopNotifier
  readonly vault: CredentialVault
  readonly now?: () => number
}

export const HOST_CAPABILITIES = [
  'host.logs.reveal',
  'host.notifications.status',
  'host.notifications.show',
  'host.credentials.status',
  'host.credentials.store',
  'host.credentials.read',
  'host.credentials.delete'
] as const

/** Desktop notifications the interface may show per minute. */
const NOTIFICATIONS_PER_MINUTE = 6

export class HostCapabilities {
  private readonly shownAt: number[] = []

  constructor(private readonly deps: HostCapabilityDependencies) {}

  async execute(call: HostCall): Promise<HostOutcome> {
    const log = this.deps.logger.child({
      component: 'host-capabilities',
      correlationId: call.correlationId
    })
    switch (call.capability) {
      case 'host.logs.reveal':
        return this.revealLogs(call, log)
      case 'host.notifications.status':
        return this.notificationStatus(call)
      case 'host.notifications.show':
        return this.showNotification(call, log)
      case 'host.credentials.status':
        return { ok: true, data: this.deps.vault.status() }
      case 'host.credentials.store':
      case 'host.credentials.read':
      case 'host.credentials.delete':
        return this.credentialOperation(call, call.capability, log)
      default:
        log.warn('host-capability.unknown', `Refused unknown host capability ${call.capability}`)
        return this.failure(
          'UNKNOWN_HOST_CAPABILITY',
          'unsupported',
          `The host has no capability called "${call.capability}".`,
          null
        )
    }
  }

  private async revealLogs(call: HostCall, log: Logger): Promise<HostOutcome> {
    const input = Capabilities['host.logs.reveal'].input.safeParse(call.input)
    if (!input.success)
      return this.failure(
        'INVALID_PAYLOAD',
        'validation',
        'Invalid input for host.logs.reveal.',
        null
      )
    try {
      mkdirSync(this.deps.logsDirectory, { recursive: true })
      const problem = await this.deps.openPath(this.deps.logsDirectory)
      if (problem) {
        log.warn('host-capability.failed', `Opening the log folder failed: ${problem}`)
        return this.failure(
          'HOST_ACTION_FAILED',
          'dependency',
          `The system could not open the log folder: ${problem}`,
          `Open ${this.deps.logsDirectory} in your file manager instead.`
        )
      }
      const data = Capabilities['host.logs.reveal'].output.parse({
        opened: true,
        path: this.deps.logsDirectory
      })
      log.info('host-capability.succeeded', 'Opened the log folder')
      return { ok: true, data }
    } catch (error) {
      return this.failure(
        'HOST_ACTION_FAILED',
        'dependency',
        `Opening the log folder failed: ${describeError(error)}`,
        `Open ${this.deps.logsDirectory} in your file manager instead.`
      )
    }
  }

  private notificationStatus(call: HostCall): HostOutcome {
    const input = Capabilities['host.notifications.status'].input.safeParse(call.input)
    if (!input.success)
      return this.failure(
        'INVALID_PAYLOAD',
        'validation',
        'Invalid input for host.notifications.status.',
        null
      )
    return { ok: true, data: { supported: this.deps.notifier.isSupported() } }
  }

  private showNotification(call: HostCall, log: Logger): HostOutcome {
    const input = DesktopNotification.safeParse(call.input)
    if (!input.success)
      return this.failure(
        'INVALID_PAYLOAD',
        'validation',
        'Invalid input for host.notifications.show.',
        null
      )
    if (!this.deps.notifier.isSupported()) {
      return this.failure(
        'NOTIFICATIONS_UNAVAILABLE',
        'unsupported',
        'This system cannot show desktop notifications.',
        null
      )
    }
    const now = (this.deps.now ?? Date.now)()
    while (this.shownAt.length > 0 && now - (this.shownAt[0] ?? now) > 60_000) this.shownAt.shift()
    if (this.shownAt.length >= NOTIFICATIONS_PER_MINUTE) {
      log.warn('host-capability.rate-limited', 'Refused a desktop notification: rate limit')
      return this.failure(
        'NOTIFICATIONS_RATE_LIMITED',
        'dependency',
        `Jupiter shows at most ${String(NOTIFICATIONS_PER_MINUTE)} desktop notifications a minute.`,
        'Try again in a minute.'
      )
    }
    try {
      this.deps.notifier.show(input.data)
    } catch (error) {
      return this.failure(
        'HOST_ACTION_FAILED',
        'dependency',
        `The system could not show the notification: ${describeError(error)}`,
        null
      )
    }
    this.shownAt.push(now)
    log.info('host-capability.succeeded', 'Showed a desktop notification', {
      tone: input.data.tone
    })
    return { ok: true, data: { shown: true } }
  }

  /** Keys are handled only for Jupiter Core, never for any other caller. */
  private credentialOperation(
    call: HostCall,
    operation: 'host.credentials.store' | 'host.credentials.read' | 'host.credentials.delete',
    log: Logger
  ): HostOutcome {
    if (call.actor.type !== 'core') {
      log.warn('host-capability.denied', `Refused ${operation} for ${call.actor.type}`)
      return this.failure(
        'PERMISSION_DENIED',
        'permission',
        `Only Jupiter Core may use ${operation}.`,
        null
      )
    }
    try {
      switch (operation) {
        case 'host.credentials.store': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          const fingerprint = this.deps.vault.store(input.data.credentialId, input.data.secret)
          return { ok: true, data: { stored: true, fingerprint } }
        }
        case 'host.credentials.read': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: { secret: this.deps.vault.read(input.data.credentialId) } }
        }
        case 'host.credentials.delete': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: { deleted: this.deps.vault.delete(input.data.credentialId) } }
        }
      }
    } catch (error) {
      if (error instanceof JupiterError)
        return {
          ok: false,
          error: createErrorEnvelope({
            code: error.code,
            category: error.category,
            message: error.message,
            userAction: error.userAction,
            retryable: error.retryable
          })
        }
      return this.failure(
        'HOST_ACTION_FAILED',
        'dependency',
        `Secure storage failed: ${describeError(error)}`,
        null
      )
    }
  }

  private invalid(operation: string): HostOutcome {
    // The reason is not included: the input may hold a key.
    return this.failure('INVALID_PAYLOAD', 'validation', `Invalid input for ${operation}.`, null)
  }

  private failure(
    code: string,
    category: ErrorEnvelope['category'],
    message: string,
    userAction: string | null
  ): HostOutcome {
    return {
      ok: false,
      error: createErrorEnvelope({ code, category, message, userAction, retryable: false })
    }
  }
}
