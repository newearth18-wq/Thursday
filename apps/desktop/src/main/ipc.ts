import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  INVOKE_CHANNELS,
  ipcInvokeContract,
  type InvokeChannel,
  type IpcInput,
  type IpcOutput,
  type IpcResponse
} from '@jupiter/contracts'
import { createErrorEnvelope, toErrorEnvelope, uuidv7, type Logger } from '@jupiter/core'

/**
 * The SET 0 IPC gateway.
 *
 * Every request is: checked against the allowlist of channels, checked for a
 * trusted sender (the main window's top frame on the app's own origin),
 * validated against its input schema, handled, and its output validated
 * before it leaves. Every request gets a correlation ID that appears in the
 * reply and in every log line it produced.
 */

export interface HandlerContext {
  readonly correlationId: string
  readonly logger: Logger
}

export type IpcHandlers = {
  readonly [C in InvokeChannel]: (
    input: IpcInput<C>,
    context: HandlerContext
  ) => Promise<IpcOutput<C>> | IpcOutput<C>
}

function issuesOf(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

export function registerIpcHandlers(options: {
  readonly logger: Logger
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  readonly handlers: IpcHandlers
}): void {
  const log = options.logger.child({ component: 'ipc' })

  for (const channel of INVOKE_CHANNELS) {
    const contract = ipcInvokeContract[channel]
    const handler = options.handlers[channel] as (
      input: unknown,
      context: HandlerContext
    ) => unknown

    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResponse<unknown>> => {
      const correlationId = uuidv7()
      const requestLog = log.child({ correlationId })
      const started = performance.now()
      const fail = (response: IpcResponse<unknown> & { ok: false }) => {
        requestLog.warn('ipc.request.rejected', `${channel} rejected: ${response.error.code}`, {
          channel,
          code: response.error.code,
          durationMs: Math.round(performance.now() - started)
        })
        return response
      }

      if (!options.isTrustedSender(event)) {
        return fail({
          ok: false,
          correlationId,
          error: createErrorEnvelope({
            code: 'IPC_UNTRUSTED_SENDER',
            category: 'permission',
            message: `${channel} was called from a frame that is not the Jupiter interface.`,
            userAction: null,
            retryable: false
          })
        })
      }

      // Structured clone turns a missing argument into null on some paths.
      const input = contract.input.safeParse(raw === null ? undefined : raw)
      if (!input.success) {
        return fail({
          ok: false,
          correlationId,
          error: createErrorEnvelope({
            code: 'IPC_INVALID_INPUT',
            category: 'validation',
            message: `Invalid request for ${channel} — ${issuesOf(input.error)}`,
            userAction: null,
            retryable: false
          })
        })
      }

      requestLog.debug('ipc.request', channel, { channel })
      try {
        const result = await handler(input.data, { correlationId, logger: requestLog })
        const output = contract.output.safeParse(result)
        if (!output.success) {
          requestLog.error(
            'ipc.output.invalid',
            `${channel} produced output that breaks its contract`,
            {
              channel,
              issues: issuesOf(output.error)
            }
          )
          return fail({
            ok: false,
            correlationId,
            error: createErrorEnvelope({
              code: 'IPC_INVALID_OUTPUT',
              category: 'internal',
              message: `Jupiter produced an invalid reply for ${channel}, so it was not sent.`,
              userAction:
                'Restart Jupiter. If this keeps happening, include the log files in a bug report.',
              retryable: false
            })
          })
        }
        requestLog.debug('ipc.response', `${channel} succeeded`, {
          channel,
          durationMs: Math.round(performance.now() - started)
        })
        return { ok: true, correlationId, data: output.data }
      } catch (error) {
        return fail({
          ok: false,
          correlationId,
          error: toErrorEnvelope(error, {
            code: 'IPC_HANDLER_FAILED',
            category: 'internal',
            userAction: 'Try again. If it keeps failing, restart Jupiter.',
            retryable: true
          })
        })
      }
    })
  }
}
