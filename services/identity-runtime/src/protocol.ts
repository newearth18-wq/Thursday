import { HostFace } from '@jupiter/contracts'
import { z } from 'zod'

/**
 * The identity runtime's protocol (SET 14): host ↔ runtime process.
 *
 * One JSON message per request over the process's IPC channel:
 * `{id, op, params}` → `{id, ok: true, result}` or
 * `{id, ok: false, error: {code, message}}`. The runtime announces itself
 * with `{id: 0, ok: true, result: {pid}}` once it is ready. Parameters and
 * results are validated on both sides.
 *
 * The runtime only ever sees raw pixels the host decoded (RGB, at most
 * 1024 × 1024) and returns where the faces are and their descriptors. It
 * keeps nothing between requests, writes nothing and reaches no network.
 */

export const MAX_SIDE = 1024

export const RuntimeOps = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ pid: z.number().int().positive() }).strict()
  },
  /** Loads the models (once) and says which engine answers. */
  status: {
    params: z.object({}).strict(),
    result: z.object({ engine: z.string().max(200), backend: z.string().max(40) }).strict()
  },
  /** The faces in an image: where each is, how sure the detector is, and its descriptor. */
  describe: {
    params: z
      .object({
        width: z.number().int().min(16).max(MAX_SIDE),
        height: z.number().int().min(16).max(MAX_SIDE),
        /** width × height × 3 bytes, RGB, row by row, as base64. */
        rgb: z
          .string()
          .max(Math.ceil((MAX_SIDE * MAX_SIDE * 3 * 4) / 3) + 4)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      })
      .strict(),
    result: z.object({ faces: z.array(HostFace).max(10) }).strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type RuntimeOp = keyof typeof RuntimeOps
export type RuntimeParams<O extends RuntimeOp> = z.input<(typeof RuntimeOps)[O]['params']>
export type RuntimeResult<O extends RuntimeOp> = z.infer<(typeof RuntimeOps)[O]['result']>

export const RuntimeRequest = z
  .object({ id: z.number().int().positive(), op: z.string().max(40), params: z.unknown() })
  .strict()

export const RuntimeReply = z.union([
  z
    .object({ id: z.number().int().nonnegative(), ok: z.literal(true), result: z.unknown() })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      ok: z.literal(false),
      error: z.object({ code: z.string().max(64), message: z.string().max(2000) }).strict()
    })
    .strict()
])
export type RuntimeReply = z.infer<typeof RuntimeReply>

export function isRuntimeOp(value: string): value is RuntimeOp {
  return Object.hasOwn(RuntimeOps, value)
}
