import { mkdirSync } from 'node:fs'
import {
  Capabilities,
  DesktopNotification,
  type CoreToHost,
  type ErrorEnvelope
} from '@jupiter/contracts'
import { createErrorEnvelope, describeError, type Logger } from '@jupiter/core'

/**
 * Privileged host functions, executed only when Jupiter Core's capability
 * dispatcher asks for them over the Core port — never directly from the
 * renderer. The dispatcher has already authorized, validated and audited the
 * request; the host validates the input and output again and acts only on
 * fixed targets it chooses itself (no paths come from the request).
 *
 * SET 2 adds the Windows-notification bridge: plain-text desktop
 * notifications, limited in size (by the contract) and in rate (here).
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
  readonly now?: () => number
}

export const HOST_CAPABILITIES = [
  'host.logs.reveal',
  'host.notifications.status',
  'host.notifications.show'
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
