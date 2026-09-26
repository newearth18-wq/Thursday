import {
  AutomationOps,
  type AutomationOp,
  type AutomationParams,
  type AutomationResult
} from '@jupiter/contracts'
import { JupiterError } from '../errors'

/**
 * How the Computer Agent reaches the host (SET 8): one typed call per
 * automation operation. Failures arrive as JupiterError with the host's or
 * the runtime's own code (ELEMENT_NOT_FOUND, RUNTIME_CRASHED, …).
 */
export interface ComputerDriver {
  call<O extends AutomationOp>(
    op: O,
    params: AutomationParams<O>,
    signal?: AbortSignal
  ): Promise<AutomationResult<O>>
}

/** A driver over a raw transport (the host operation `host.computer.call`), validating every result. */
export function checkedDriver(
  transport: (op: AutomationOp, params: unknown, signal?: AbortSignal) => Promise<unknown>
): ComputerDriver {
  return {
    async call(op, params, signal) {
      const raw = await transport(op, params, signal)
      const parsed = AutomationOps[op].result.safeParse(raw)
      if (!parsed.success)
        throw new JupiterError(
          'AUTOMATION_REPLY_INVALID',
          `The host's reply to ${op} is not valid: ${parsed.error.message}`,
          { category: 'internal', userAction: null }
        )
      return parsed.data as AutomationResult<typeof op>
    }
  }
}
