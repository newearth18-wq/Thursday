import {
  BrowserOps,
  type BrowserOp,
  type BrowserParams,
  type BrowserResult
} from '@jupiter/contracts'
import { JupiterError } from '../errors'

/**
 * How the Browser Agent reaches the host (SET 9): one typed call per browser
 * operation. Failures arrive as JupiterError with the host's or the
 * runtime's own code (ELEMENT_NOT_FOUND, NAVIGATION_FAILED, RUNTIME_CRASHED…).
 */
export interface BrowserDriver {
  call<O extends BrowserOp>(
    op: O,
    params: BrowserParams<O>,
    signal?: AbortSignal
  ): Promise<BrowserResult<O>>
}

/** A driver over a raw transport (the host operation `host.browser.call`), validating every result. */
export function checkedBrowserDriver(
  transport: (op: BrowserOp, params: unknown, signal?: AbortSignal) => Promise<unknown>
): BrowserDriver {
  return {
    async call(op, params, signal) {
      const raw = await transport(op, params, signal)
      const parsed = BrowserOps[op].result.safeParse(raw)
      if (!parsed.success)
        throw new JupiterError(
          'BROWSER_REPLY_INVALID',
          `The host's reply to ${op} is not valid: ${parsed.error.message}`,
          { category: 'internal', userAction: null }
        )
      return parsed.data as BrowserResult<typeof op>
    }
  }
}
