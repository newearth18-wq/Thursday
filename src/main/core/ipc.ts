import { ipcMain } from 'electron'
import type { ZodTypeAny } from 'zod'
import { IPC_INPUT, type IpcChannel, type IpcInput, type IpcResult } from '@shared/ipc.js'
import { describeError, log } from './logger.js'

/**
 * Typed IPC registration.
 *
 * Every renderer call is validated against the channel's zod schema before a
 * handler runs, so a handler can trust its input. Handler failures are turned
 * into a structured error the renderer can display, and are logged with the
 * channel name so a failure is never anonymous.
 */

export class IpcError extends Error {
  constructor(
    message: string,
    readonly code: string = 'HANDLER_ERROR'
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

type Handler<C extends IpcChannel> = (input: IpcInput<C>) => Promise<IpcResult[C]> | IpcResult[C]

const registered = new Set<IpcChannel>()

export function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  if (registered.has(channel)) {
    throw new Error(`IPC channel "${channel}" registered twice`)
  }
  registered.add(channel)

  ipcMain.handle(channel, async (_event, rawInput: unknown) => {
    const schema = IPC_INPUT[channel] as ZodTypeAny
    // Electron's structured clone turns a missing argument into null on some
    // paths, so treat null as "no input" rather than rejecting the call.
    const parsed = schema.safeParse(rawInput === null ? undefined : rawInput)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      const message = `Invalid arguments for ${channel} — ${detail}`
      log.warn('ERROR', message, { channel })
      return { __thursdayError: { message, code: 'INVALID_INPUT' } }
    }

    try {
      const result = await handler(parsed.data as IpcInput<C>)
      return result === undefined ? null : result
    } catch (err) {
      const message = describeError(err)
      const code = err instanceof IpcError ? err.code : 'HANDLER_ERROR'
      log.error('ERROR', `${channel} failed: ${message}`, { channel, code })
      return { __thursdayError: { message, code } }
    }
  })
}

export function registeredChannels(): IpcChannel[] {
  return [...registered]
}
