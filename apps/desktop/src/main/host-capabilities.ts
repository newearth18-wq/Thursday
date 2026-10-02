import { mkdirSync } from 'node:fs'
import {
  Capabilities,
  DesktopNotification,
  HostOperations,
  type CoreToHost,
  type ErrorEnvelope
} from '@jupiter/contracts'
import { JupiterError, createErrorEnvelope, describeError, type Logger } from '@jupiter/core'
import type { BrowserHost } from './browser-host'
import type { FileHost } from './file-host'
import type { NotesHost } from './notes-host'
import type { ComputerHost } from './computer-host'
import type { CredentialVault } from './credential-vault'
import type { MicrophoneGate, SpeechHost } from './speech-host'
import type { IdentityHost } from './identity-host'
import type { PluginHost } from './plugin-host'
import type { VisionHost } from './vision-host'

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
  /** The Windows Computer Agent's host side (SET 8). */
  readonly computer: ComputerHost
  /** The Browser Agent's host side (SET 9). */
  readonly browser: BrowserHost
  /** The File Agent's and Artifact Manager's host side (SET 10). */
  readonly files: FileHost
  /** Obsidian notes' host side (SET 11). */
  readonly notes: NotesHost
  /** The operating system's voice (SET 12). */
  readonly speech: SpeechHost
  /** The microphone gate (SET 12): the interface gets the microphone only while it is open. */
  readonly microphone: MicrophoneGate
  /** SET 13: screen capture, OCR, QR and image processing; the camera gate. */
  readonly vision: VisionHost
  readonly camera: MicrophoneGate
  /** SET 14: the face engine (identity runtime) and Windows Hello. */
  readonly identity: IdentityHost
  /** Plugin folders and plugin storage (SET 15). */
  readonly plugins: PluginHost
  readonly now?: () => number
}

export const HOST_CAPABILITIES = [
  'host.logs.reveal',
  'host.notifications.status',
  'host.notifications.show',
  'host.credentials.status',
  'host.credentials.store',
  'host.credentials.read',
  'host.credentials.delete',
  'host.computer.call',
  'host.browser.call',
  'host.files.call',
  'host.vault.status',
  'host.vault.seal',
  'host.vault.unseal',
  'host.notes.call',
  'host.speech.voices',
  'host.speech.synthesize',
  'host.microphone.gate',
  'host.vision.engines',
  'host.vision.capture',
  'host.vision.ocr',
  'host.vision.qr',
  'host.vision.redact',
  'host.vision.compare',
  'host.camera.gate',
  'host.identity.engines',
  'host.identity.face',
  'host.identity.hello',
  'host.plugins.discover',
  'host.plugins.code',
  'host.plugins.choose',
  'host.plugins.commit',
  'host.plugins.discard',
  'host.plugins.remove',
  'host.plugins.storage'
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
      case 'host.computer.call':
        return this.agentOperation(call, 'host.computer.call', log)
      case 'host.browser.call':
        return this.agentOperation(call, 'host.browser.call', log)
      case 'host.files.call':
        return this.agentOperation(call, 'host.files.call', log)
      case 'host.notes.call':
        return this.agentOperation(call, 'host.notes.call', log)
      case 'host.vault.status':
      case 'host.vault.seal':
      case 'host.vault.unseal':
        return this.vaultOperation(call, call.capability, log)
      case 'host.speech.voices':
      case 'host.speech.synthesize':
      case 'host.microphone.gate':
        return this.voiceOperation(call, call.capability, log)
      case 'host.vision.engines':
      case 'host.vision.capture':
      case 'host.vision.ocr':
      case 'host.vision.qr':
      case 'host.vision.redact':
      case 'host.vision.compare':
      case 'host.camera.gate':
        return this.visionOperation(call, call.capability, log)
      case 'host.identity.engines':
      case 'host.identity.face':
      case 'host.identity.hello':
        return this.identityOperation(call, call.capability, log)
      case 'host.plugins.discover':
      case 'host.plugins.code':
      case 'host.plugins.choose':
      case 'host.plugins.commit':
      case 'host.plugins.discard':
      case 'host.plugins.remove':
      case 'host.plugins.storage':
        return this.pluginOperation(call, call.capability, log)
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

  /**
   * Computer (SET 8), browser (SET 9) and file (SET 10) actions are
   * performed only for Jupiter Core, which has already checked the
   * permissions (and, for the browser, the origins).
   */
  private async agentOperation(
    call: HostCall,
    operation: 'host.computer.call' | 'host.browser.call' | 'host.files.call' | 'host.notes.call',
    log: Logger
  ): Promise<HostOutcome> {
    if (call.actor.type !== 'core') {
      log.warn('host-capability.denied', `Refused ${operation} for ${call.actor.type}`)
      return this.failure(
        'PERMISSION_DENIED',
        'permission',
        `Only Jupiter Core may use ${operation}.`,
        null
      )
    }
    const input = HostOperations[operation].input.safeParse(call.input)
    if (!input.success)
      return this.failure(
        'INVALID_PAYLOAD',
        'validation',
        `Invalid input for ${operation}: ${input.error.issues.map((issue) => issue.message).join('; ')}`,
        null
      )
    try {
      const data =
        operation === 'host.computer.call'
          ? await this.deps.computer.call(input.data)
          : operation === 'host.browser.call'
            ? await this.deps.browser.call(input.data)
            : operation === 'host.files.call'
              ? await this.deps.files.call(input.data)
              : await this.deps.notes.call(input.data)
      return { ok: true, data }
    } catch (error) {
      if (error instanceof JupiterError) {
        log.info(
          `host-capability.${agentName(operation)}.failed`,
          `${input.data.op} failed: ${error.code}`
        )
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
      }
      return this.failure(
        'HOST_ACTION_FAILED',
        'dependency',
        `The ${agentName(operation)} action failed: ${describeError(error)}`,
        null
      )
    }
  }

  /** Sealing for sensitive memories (SET 11): Jupiter Core only; the text is never logged. */
  private vaultOperation(
    call: HostCall,
    operation: 'host.vault.status' | 'host.vault.seal' | 'host.vault.unseal',
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
        case 'host.vault.status': {
          const status = this.deps.vault.status()
          return { ok: true, data: { available: status.available, reason: status.reason } }
        }
        case 'host.vault.seal': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: { sealed: this.deps.vault.seal(input.data.text) } }
        }
        case 'host.vault.unseal': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: { text: this.deps.vault.unseal(input.data.sealed) } }
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

  /** Voice (SET 12): Jupiter Core only. Text to speak is never logged. */
  private async voiceOperation(
    call: HostCall,
    operation: 'host.speech.voices' | 'host.speech.synthesize' | 'host.microphone.gate',
    log: Logger
  ): Promise<HostOutcome> {
    if (call.actor.type !== 'core') {
      log.warn('host-capability.denied', `Refused ${operation} for ${call.actor.type}`)
      return this.failure(
        'PERMISSION_DENIED',
        'permission',
        `Only Jupiter Core may use ${operation}.`,
        null
      )
    }
    const input = HostOperations[operation].input.safeParse(call.input)
    if (!input.success) return this.invalid(operation)
    try {
      switch (operation) {
        case 'host.speech.voices':
          return { ok: true, data: await this.deps.speech.voices() }
        case 'host.speech.synthesize': {
          const request = HostOperations['host.speech.synthesize'].input.parse(call.input)
          return { ok: true, data: await this.deps.speech.synthesize(request) }
        }
        case 'host.microphone.gate': {
          const request = HostOperations['host.microphone.gate'].input.parse(call.input)
          const open = this.deps.microphone.set(request)
          log.info(
            open ? 'voice.gate.opened' : 'voice.gate.closed',
            open ? `Microphone gate opened (${request.purpose})` : 'Microphone gate closed',
            { sessionId: request.sessionId }
          )
          return { ok: true, data: { open } }
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
        'SYSTEM_VOICE_FAILED',
        'dependency',
        `The system voice failed: ${describeError(error)}`,
        'Try again, or choose a speech model as the voice source.'
      )
    }
  }

  /**
   * Identity (SET 14): Jupiter Core only. Images, descriptors and Windows
   * Hello's answers are never logged — only that a check happened.
   */
  private async identityOperation(
    call: HostCall,
    operation: 'host.identity.engines' | 'host.identity.face' | 'host.identity.hello',
    log: Logger
  ): Promise<HostOutcome> {
    if (call.actor.type !== 'core') {
      log.warn('host-capability.denied', `Refused ${operation} for ${call.actor.type}`)
      return this.failure(
        'PERMISSION_DENIED',
        'permission',
        `Only Jupiter Core may use ${operation}.`,
        null
      )
    }
    const input = HostOperations[operation].input.safeParse(call.input)
    if (!input.success) return this.invalid(operation)
    const identity = this.deps.identity
    try {
      switch (operation) {
        case 'host.identity.engines':
          return { ok: true, data: await identity.engines() }
        case 'host.identity.face':
          return {
            ok: true,
            data: await identity.face(HostOperations['host.identity.face'].input.parse(call.input))
          }
        case 'host.identity.hello': {
          const result = await identity.hello(
            HostOperations['host.identity.hello'].input.parse(call.input)
          )
          log.info('identity.hello.asked', `Windows Hello answered: ${result.outcome}`)
          return { ok: true, data: result }
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
        'IDENTITY_HOST_FAILED',
        'internal',
        'The identity engine failed unexpectedly.',
        'Try again.'
      )
    }
  }

  /**
   * Plugins (SET 15): Jupiter Core only. The host reads, copies and removes plugin folders and
   * keeps plugin storage; it never runs plugin code, and logs no plugin file content.
   */
  private async pluginOperation(
    call: HostCall,
    operation:
      | 'host.plugins.discover'
      | 'host.plugins.code'
      | 'host.plugins.choose'
      | 'host.plugins.commit'
      | 'host.plugins.discard'
      | 'host.plugins.remove'
      | 'host.plugins.storage',
    log: Logger
  ): Promise<HostOutcome> {
    if (call.actor.type !== 'core') {
      log.warn('host-capability.denied', `Refused ${operation} for ${call.actor.type}`)
      return this.failure(
        'PERMISSION_DENIED',
        'permission',
        `Only Jupiter Core may use ${operation}.`,
        null
      )
    }
    const plugins = this.deps.plugins
    try {
      switch (operation) {
        case 'host.plugins.discover':
          if (!HostOperations[operation].input.safeParse(call.input).success)
            return this.invalid(operation)
          return { ok: true, data: await plugins.discover() }
        case 'host.plugins.code': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: await plugins.code(input.data) }
        }
        case 'host.plugins.choose': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: await plugins.choose(input.data.purpose) }
        }
        case 'host.plugins.commit': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          await plugins.commit(input.data.stagingId, input.data.pluginId)
          log.info('plugins.installed', `Plugin ${input.data.pluginId} put in place`)
          return { ok: true, data: { committed: true } }
        }
        case 'host.plugins.discard': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: { discarded: await plugins.discard(input.data.stagingId) } }
        }
        case 'host.plugins.remove': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          const removed = await plugins.remove(input.data.pluginId)
          log.info('plugins.removed', `Plugin ${input.data.pluginId} removed`)
          return { ok: true, data: { removed } }
        }
        case 'host.plugins.storage': {
          const input = HostOperations[operation].input.safeParse(call.input)
          if (!input.success) return this.invalid(operation)
          return { ok: true, data: await plugins.storage(input.data) }
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
      log.warn('plugins.host.failed', `${operation} failed`, {
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown'
      })
      return this.failure(
        'PLUGIN_HOST_FAILED',
        'internal',
        `The plugin folder could not be handled: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
        'Try again.'
      )
    }
  }

  /** Vision and camera (SET 13): Jupiter Core only. Images and their text are never logged. */
  private async visionOperation(
    call: HostCall,
    operation:
      | 'host.vision.engines'
      | 'host.vision.capture'
      | 'host.vision.ocr'
      | 'host.vision.qr'
      | 'host.vision.redact'
      | 'host.vision.compare'
      | 'host.camera.gate',
    log: Logger
  ): Promise<HostOutcome> {
    if (call.actor.type !== 'core') {
      log.warn('host-capability.denied', `Refused ${operation} for ${call.actor.type}`)
      return this.failure(
        'PERMISSION_DENIED',
        'permission',
        `Only Jupiter Core may use ${operation}.`,
        null
      )
    }
    const input = HostOperations[operation].input.safeParse(call.input)
    if (!input.success) return this.invalid(operation)
    const vision = this.deps.vision
    try {
      switch (operation) {
        case 'host.vision.engines':
          return { ok: true, data: await vision.engines() }
        case 'host.vision.capture': {
          const request = HostOperations['host.vision.capture'].input.parse(call.input)
          const image = await vision.capture(request)
          log.info(
            'vision.captured',
            `Captured ${request.source} (${String(image.width)}×${String(image.height)})`
          )
          return { ok: true, data: image }
        }
        case 'host.vision.ocr':
          return {
            ok: true,
            data: await vision.ocr(HostOperations['host.vision.ocr'].input.parse(call.input))
          }
        case 'host.vision.qr':
          return {
            ok: true,
            data: await vision.qr(HostOperations['host.vision.qr'].input.parse(call.input))
          }
        case 'host.vision.redact':
          return {
            ok: true,
            data: vision.redact(HostOperations['host.vision.redact'].input.parse(call.input))
          }
        case 'host.vision.compare':
          return {
            ok: true,
            data: vision.compare(HostOperations['host.vision.compare'].input.parse(call.input))
          }
        case 'host.camera.gate': {
          const request = HostOperations['host.camera.gate'].input.parse(call.input)
          const open = this.deps.camera.set({ ...request, purpose: 'listen' })
          log.info(
            open ? 'camera.gate.opened' : 'camera.gate.closed',
            open ? 'Camera gate opened' : 'Camera gate closed',
            { sessionId: request.sessionId }
          )
          return { ok: true, data: { open } }
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
        'VISION_HOST_FAILED',
        'dependency',
        `The vision engine failed: ${describeError(error)}`,
        'Try again.'
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

function agentName(
  operation: 'host.computer.call' | 'host.browser.call' | 'host.files.call' | 'host.notes.call'
): string {
  return operation === 'host.computer.call'
    ? 'computer'
    : operation === 'host.browser.call'
      ? 'browser'
      : operation === 'host.files.call'
        ? 'file'
        : 'notes'
}
