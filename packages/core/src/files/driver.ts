import { FileOps, type FileOp, type FileParams, type FileResult } from '@jupiter/contracts'
import { JupiterError } from '../errors'

/**
 * How the File Agent and the Artifact Manager reach the host (SET 10): one
 * typed call per file operation. Failures arrive as JupiterError with the
 * host's or the document runtime's own code (PATH_REFUSED, FILE_NOT_FOUND,
 * DOCUMENT_INVALID, RUNTIME_CRASHED…).
 */
export interface FileDriver {
  call<O extends FileOp>(op: O, params: FileParams<O>, signal?: AbortSignal): Promise<FileResult<O>>
}

/** A driver over a raw transport (the host operation `host.files.call`), validating every result. */
export function checkedFileDriver(
  transport: (op: FileOp, params: unknown, signal?: AbortSignal) => Promise<unknown>
): FileDriver {
  return {
    async call(op, params, signal) {
      const raw = await transport(op, params, signal)
      const parsed = FileOps[op].result.safeParse(raw)
      if (!parsed.success)
        throw new JupiterError(
          'FILES_REPLY_INVALID',
          `The host's reply to ${op} is not valid: ${parsed.error.message}`,
          { category: 'internal', userAction: null }
        )
      return parsed.data as FileResult<typeof op>
    }
  }
}
