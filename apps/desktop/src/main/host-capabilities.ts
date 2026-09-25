import { mkdirSync } from 'node:fs'
import { Capabilities, type CoreToHost, type ErrorEnvelope } from '@jupiter/contracts'
import { createErrorEnvelope, describeError, type Logger } from '@jupiter/core'

/**
 * Privileged host functions, executed only when Jupiter Core's capability
 * dispatcher asks for them over the Core port — never directly from the
 * renderer. The dispatcher has already authorized, validated and audited the
 * request; the host validates the input and output again and acts only on
 * fixed targets it chooses itself (no paths come from the request).
 */

export type HostCall = Extract<CoreToHost, { kind: 'host-call' }>
export type HostOutcome = { ok: true; data: unknown } | { ok: false; error: ErrorEnvelope }

export interface HostCapabilityDependencies {
  readonly logger: Logger
  readonly logsDirectory: string
  /** Electron's shell.openPath: resolves to an empty string on success, or an error message. */
  readonly openPath: (path: string) => Promise<string>
}

export const HOST_CAPABILITIES = ['host.logs.reveal'] as const

export class HostCapabilities {
  constructor(private readonly deps: HostCapabilityDependencies) {}

  async execute(call: HostCall): Promise<HostOutcome> {
    const log = this.deps.logger.child({
      component: 'host-capabilities',
      correlationId: call.correlationId
    })
    if (call.capability !== 'host.logs.reveal') {
      log.warn('host-capability.unknown', `Refused unknown host capability ${call.capability}`)
      return this.failure(
        'UNKNOWN_HOST_CAPABILITY',
        'unsupported',
        `The host has no capability called "${call.capability}".`,
        null
      )
    }
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
