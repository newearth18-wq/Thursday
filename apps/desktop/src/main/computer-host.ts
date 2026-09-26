import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  AutomationCall,
  AutomationOps,
  ComputerAppId,
  type AutomationOp,
  type ComputerStatus
} from '@jupiter/contracts'
import { AgentRuntime, RuntimeError } from '@jupiter/agent-runtime'
import { JupiterError, type Logger } from '@jupiter/core'

/**
 * The host's part of the Windows Computer Agent (SET 8).
 *
 * Jupiter Core decides what to do and checks every permission; the host
 * decides what it may act on. Only the applications in `APPS` can be opened,
 * files are saved and verified only in the folder the host chose, and
 * screenshots go only to the host's evidence folder. UI Automation itself
 * runs in the agent runtime, a separate PowerShell process: a fault there is
 * a structured error here, and the next call starts a new runtime.
 */

export interface ComputerHostOptions {
  readonly logger: Logger
  readonly platform: NodeJS.Platform
  /** Where files are saved (the person's Desktop; a temporary folder in tests). */
  readonly saveFolder: string
  readonly evidenceFolder: string
  readonly runtime?: AgentRuntime
  readonly systemRoot?: string
}

/** How long a control may take to appear before it counts as missing. */
const ELEMENT_WAIT_MS = 3_000

export class ComputerHost {
  private readonly runtime: AgentRuntime | null
  private screen: ComputerStatus['screen'] = null

  constructor(private readonly options: ComputerHostOptions) {
    this.runtime =
      options.platform === 'win32'
        ? (options.runtime ??
          new AgentRuntime({
            onEvent: (event) => {
              options.logger.info(
                `computer.runtime.${event.kind}`,
                `Agent runtime ${event.kind}: ${event.detail}`,
                { pid: event.pid }
              )
            }
          }))
        : (options.runtime ?? null)
  }

  get available(): boolean {
    return this.runtime !== null
  }

  /** The runtime's process id, for Diagnostics and crash tests. */
  get runtimePid(): number | null {
    return this.runtime?.pid ?? null
  }

  /** Starts the runtime and reads the screen size: the service's real health check. */
  async probe(): Promise<ComputerStatus> {
    if (this.runtime) {
      const pong = await this.runtime.call('ping', {})
      this.screen = pong.screen
    }
    return this.status()
  }

  status(): ComputerStatus {
    const runtime = this.runtime
    return {
      available: runtime !== null,
      platform: this.options.platform,
      reason:
        runtime === null
          ? `The Windows Computer Agent needs Windows; this computer runs ${this.options.platform}.`
          : null,
      runtime: {
        state:
          runtime === null
            ? 'unavailable'
            : runtime.state === 'starting'
              ? 'stopped'
              : runtime.state,
        pid: runtime?.pid ?? null,
        restarts: runtime?.restarts ?? 0,
        lastError: runtime?.lastError?.slice(0, 500) ?? null
      },
      screen: this.screen,
      saveFolder: runtime === null ? null : this.options.saveFolder,
      apps: [...ComputerAppId.options]
    }
  }

  async call(raw: unknown): Promise<unknown> {
    const parsed = AutomationCall.safeParse(raw)
    if (!parsed.success)
      throw new JupiterError(
        'INVALID_PAYLOAD',
        `Invalid automation call: ${parsed.error.message}`,
        {
          category: 'validation',
          userAction: null
        }
      )
    const { op } = parsed.data
    const result = await this.perform(op, parsed.data.params)
    // What goes back to Core is checked like everything else crossing a boundary.
    return AutomationOps[op].result.parse(result)
  }

  async stop(): Promise<void> {
    await this.runtime?.stop()
  }

  private async perform(op: AutomationOp, params: unknown): Promise<unknown> {
    if (op === 'status') {
      if (this.runtime) await this.probe().catch(() => undefined)
      return this.status()
    }
    const runtime = this.runtime
    if (!runtime)
      throw new JupiterError(
        'COMPUTER_UNAVAILABLE',
        `The Windows Computer Agent needs Windows; this computer runs ${this.options.platform}.`,
        { category: 'unsupported', userAction: null }
      )
    try {
      switch (op) {
        case 'listWindows':
          return await runtime.call('listWindows', {})
        case 'launch': {
          const { app } = AutomationOps.launch.params.parse(params)
          return await runtime.call('start', this.launchOf(app))
        }
        case 'windowOp':
          return await runtime.call('windowOp', AutomationOps.windowOp.params.parse(params))
        case 'findElement':
        case 'invoke':
        case 'readText':
        case 'select': {
          const input = AutomationOps[op].params.parse(params)
          return await runtime.call(op, { ...input, waitMs: ELEMENT_WAIT_MS })
        }
        case 'setValue':
        case 'typeText': {
          const input = AutomationOps[op].params.parse(params)
          return await runtime.call(op, { ...input, waitMs: ELEMENT_WAIT_MS })
        }
        case 'scroll':
          return await runtime.call('scroll', {
            ...AutomationOps.scroll.params.parse(params),
            waitMs: ELEMENT_WAIT_MS
          })
        case 'sendKeys':
          return await runtime.call('sendKeys', AutomationOps.sendKeys.params.parse(params))
        case 'readTree':
          return await runtime.call('readTree', AutomationOps.readTree.params.parse(params))
        case 'clickPoint':
          return await runtime.call('clickPoint', AutomationOps.clickPoint.params.parse(params))
        case 'screenshot': {
          const { handle } = AutomationOps.screenshot.params.parse(params)
          mkdirSync(this.options.evidenceFolder, { recursive: true })
          const file = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`
          const shot = await runtime.call('screenshot', {
            handle,
            path: join(this.options.evidenceFolder, file)
          })
          return { file, ...shot }
        }
        case 'resolveSavePath': {
          const { fileName } = AutomationOps.resolveSavePath.params.parse(params)
          const path = this.savePath(fileName)
          return { path, exists: existsSync(path) }
        }
        case 'verifyFile': {
          const { fileName, expected } = AutomationOps.verifyFile.params.parse(params)
          return this.verify(fileName, expected)
        }
      }
    } catch (error) {
      throw toJupiterError(error)
    }
  }

  /** The executable for each app, chosen here and never taken from a request. */
  private launchOf(app: ComputerAppId): { file: string; args: string[] } {
    const root = this.options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
    switch (app) {
      case 'notepad':
        return { file: join(root, 'System32', 'notepad.exe'), args: [] }
      case 'explorer':
        // File Explorer opens the folder files are saved to, nothing else.
        mkdirSync(this.options.saveFolder, { recursive: true })
        return { file: join(root, 'explorer.exe'), args: [this.options.saveFolder] }
    }
  }

  private savePath(fileName: string): string {
    const folder = resolve(this.options.saveFolder)
    const path = resolve(folder, fileName)
    if (dirname(path) !== folder || basename(path) !== fileName)
      throw new JupiterError('INVALID_FILE_NAME', `"${fileName}" is not a plain file name.`, {
        category: 'validation',
        userAction: 'Use a name such as "hello.txt".'
      })
    return path
  }

  /** Reads the saved file back; its content is compared here and never returned. */
  private verify(fileName: string, expected: string) {
    const path = this.savePath(fileName)
    if (!existsSync(path)) return { path, exists: false, bytes: 0, sha256: null, matches: false }
    const bytes = readFileSync(path)
    const text = decodeText(bytes)
    return {
      path,
      exists: true,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      matches: normalize(text) === normalize(expected)
    }
  }
}

/** Notepad writes UTF-8 (with or without a byte-order mark) or UTF-16. */
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return bytes.subarray(3).toString('utf8')
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  return bytes.toString('utf8')
}

/** Line endings are the only difference allowed: Notepad writes CRLF. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function toJupiterError(error: unknown): unknown {
  if (error instanceof JupiterError) return error
  if (error instanceof RuntimeError) {
    const runtimeFault = error.code.startsWith('RUNTIME_')
    return new JupiterError(error.code, error.message, {
      category: error.code === 'RUNTIME_TIMEOUT' ? 'timeout' : 'dependency',
      userAction: runtimeFault
        ? 'Try again: Jupiter starts a new agent runtime for the next action.'
        : null,
      retryable: runtimeFault
    })
  }
  return error
}
