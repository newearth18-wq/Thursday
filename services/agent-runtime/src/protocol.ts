import { ElementInfo, ElementQuery, KeyChord, UiNode, WindowInfo } from '@jupiter/contracts'
import { z } from 'zod'

/**
 * The runtime's wire contract (SET 8): what the host may ask the UI
 * Automation process, and what it answers. Both directions are validated;
 * a reply that does not match is treated as a runtime fault.
 *
 * The runtime only acts on what it is given: window handles, element
 * queries, an executable and arguments the host chose, and a screenshot path
 * in a folder the host chose.
 */

const Handle = z.number().int().positive()
const Wait = z.number().int().min(0).max(10_000)
const Element = z.object({ element: ElementInfo }).strict()
const Text = z.string().max(10_000)

export const RuntimeOps = {
  ping: {
    params: z.object({}).strict(),
    result: z
      .object({
        pid: z.number().int().positive(),
        psVersion: z.string().max(40),
        screen: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .strict()
      })
      .strict()
  },
  listWindows: {
    params: z.object({}).strict(),
    result: z.object({ windows: z.array(WindowInfo).max(200) }).strict()
  },
  start: {
    params: z
      .object({ file: z.string().min(1).max(500), args: z.array(z.string().max(1000)).max(4) })
      .strict(),
    result: z.object({ processId: z.number().int().positive() }).strict()
  },
  windowOp: {
    params: z
      .object({
        handle: Handle,
        operation: z.enum(['focus', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize']),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional()
      })
      .strict(),
    result: z.object({ window: WindowInfo.nullable() }).strict()
  },
  findElement: {
    params: z.object({ handle: Handle, query: ElementQuery, waitMs: Wait }).strict(),
    result: Element
  },
  invoke: {
    params: z.object({ handle: Handle, query: ElementQuery, waitMs: Wait }).strict(),
    result: Element
  },
  setValue: {
    params: z.object({ handle: Handle, query: ElementQuery, waitMs: Wait, text: Text }).strict(),
    result: Element
  },
  typeText: {
    params: z.object({ handle: Handle, query: ElementQuery, waitMs: Wait, text: Text }).strict(),
    result: Element
  },
  sendKeys: {
    params: z.object({ handle: Handle, keys: z.array(KeyChord).min(1).max(10) }).strict(),
    result: z.object({ window: WindowInfo }).strict()
  },
  readText: {
    params: z.object({ handle: Handle, query: ElementQuery, waitMs: Wait }).strict(),
    result: z.object({ text: z.string().max(200_000) }).strict()
  },
  readTree: {
    params: z
      .object({
        handle: Handle,
        depth: z.number().int().min(1).max(8),
        maxNodes: z.number().int().min(1).max(500)
      })
      .strict(),
    result: z.object({ nodes: z.array(UiNode).max(500), truncated: z.boolean() }).strict()
  },
  scroll: {
    params: z
      .object({
        handle: Handle,
        query: ElementQuery,
        waitMs: Wait,
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(20)
      })
      .strict(),
    result: Element
  },
  select: {
    params: z.object({ handle: Handle, query: ElementQuery, waitMs: Wait }).strict(),
    result: Element
  },
  screenshot: {
    params: z.object({ handle: Handle.nullable(), path: z.string().min(1).max(1000) }).strict(),
    result: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        bytes: z.number().int().nonnegative()
      })
      .strict()
  },
  clickPoint: {
    params: z
      .object({ handle: Handle, x: z.number().int().min(0), y: z.number().int().min(0) })
      .strict(),
    result: z.object({ screenX: z.number().int(), screenY: z.number().int() }).strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type RuntimeOp = keyof typeof RuntimeOps
export type RuntimeParams<O extends RuntimeOp> = z.infer<(typeof RuntimeOps)[O]['params']>
export type RuntimeResult<O extends RuntimeOp> = z.infer<(typeof RuntimeOps)[O]['result']>

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
