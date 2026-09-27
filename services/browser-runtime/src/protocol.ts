import {
  BrowserKey,
  BrowserTab,
  ExtractField,
  Extraction,
  Locator,
  PageInfo,
  Uuidv7,
  WebAddress
} from '@jupiter/contracts'
import { z } from 'zod'

/**
 * The browser runtime's protocol (SET 9): host ↔ runtime process.
 *
 * One JSON message per request over the process's IPC channel:
 * `{id, op, params}` → `{id, ok: true, result}` or
 * `{id, ok: false, error: {code, message}}`. The runtime announces itself
 * with `{id: 0, ok: true, result: {pid}}` once it is ready. Parameters and
 * results are validated on both sides; a message that does not match is a
 * fault, never guessed at.
 *
 * The host passes paths (a profile folder, the quarantine folder, evidence
 * files, a file to upload) that it chose itself; the runtime never receives
 * a path from Core or from a page.
 */

/** How the host starts the runtime (JSON in the JUPITER_BROWSER_CONFIG environment variable). */
export const RuntimeConfig = z
  .object({
    executablePath: z.string().min(1).max(1000),
    headless: z.boolean(),
    /** Chromium's sandbox cannot run as root (containers); the host decides. */
    noSandbox: z.boolean()
  })
  .strict()
export type RuntimeConfig = z.infer<typeof RuntimeConfig>

const Session = Uuidv7
const Timeout = z.number().int().min(100).max(120_000)
const Path = z.string().min(1).max(1000)
const WithPage = z.object({ page: PageInfo }).strict()
const Found = z
  .object({ page: PageInfo, found: z.string().max(300), method: z.enum(['semantic', 'selector']) })
  .strict()

export const RuntimeSession = z
  .object({ sessionId: Session, persistent: z.boolean(), tabs: z.array(BrowserTab).max(20) })
  .strict()
export type RuntimeSession = z.infer<typeof RuntimeSession>

export const RuntimeOps = {
  ping: {
    params: z.object({}).strict(),
    result: z
      .object({
        pid: z.number().int().positive(),
        /** The browser's version, once it has been started. */
        version: z.string().max(100).nullable(),
        sessions: z.number().int().nonnegative()
      })
      .strict()
  },
  openSession: {
    params: z
      .object({
        sessionId: Session,
        /** A profile folder for the persistent profile; null for a temporary one (nothing on disk). */
        userDataDir: Path.nullable()
      })
      .strict(),
    result: RuntimeSession
  },
  closeSession: {
    params: z.object({ sessionId: Session }).strict(),
    result: z.object({ closed: z.boolean() }).strict()
  },
  listSessions: {
    params: z.object({}).strict(),
    result: z.object({ sessions: z.array(RuntimeSession).max(50) }).strict()
  },
  page: { params: z.object({ sessionId: Session }).strict(), result: WithPage },
  navigate: {
    params: z.object({ sessionId: Session, url: WebAddress, timeoutMs: Timeout }).strict(),
    result: z.object({ page: PageInfo, status: z.number().int().nullable() }).strict()
  },
  newTab: {
    params: z
      .object({ sessionId: Session, url: WebAddress.nullable(), timeoutMs: Timeout })
      .strict(),
    result: WithPage
  },
  switchTab: {
    params: z.object({ sessionId: Session, index: z.number().int().min(0).max(20) }).strict(),
    result: WithPage
  },
  closeTab: {
    params: z
      .object({ sessionId: Session, index: z.number().int().min(0).max(20).nullable() })
      .strict(),
    result: WithPage
  },
  click: {
    params: z.object({ sessionId: Session, target: Locator, timeoutMs: Timeout }).strict(),
    result: Found
  },
  fill: {
    params: z
      .object({
        sessionId: Session,
        target: Locator,
        text: z.string().max(10_000),
        timeoutMs: Timeout
      })
      .strict(),
    result: Found.extend({ matches: z.boolean(), sensitive: z.boolean() }).strict()
  },
  select: {
    params: z
      .object({
        sessionId: Session,
        target: Locator,
        value: z.string().max(500),
        timeoutMs: Timeout
      })
      .strict(),
    result: Found.extend({ selected: z.array(z.string().max(500)).max(50) }).strict()
  },
  press: {
    params: z
      .object({
        sessionId: Session,
        target: Locator.nullable(),
        keys: z.array(BrowserKey).min(1).max(10),
        timeoutMs: Timeout
      })
      .strict(),
    result: WithPage
  },
  waitFor: {
    params: z
      .object({
        sessionId: Session,
        target: Locator.nullable(),
        urlContains: z.string().min(1).max(500).nullable(),
        state: z.enum(['load', 'domcontentloaded', 'networkidle']).nullable(),
        timeoutMs: Timeout
      })
      .strict(),
    result: WithPage
  },
  describe: {
    params: z.object({ sessionId: Session, target: Locator, timeoutMs: Timeout }).strict(),
    result: Found.extend({
      kind: z.enum(['link', 'button', 'submit', 'field', 'password', 'file', 'other']),
      formAction: z.string().max(2000).nullable(),
      formHasPassword: z.boolean()
    }).strict()
  },
  read: {
    params: z
      .object({ sessionId: Session, maxChars: z.number().int().min(100).max(100_000) })
      .strict(),
    result: z
      .object({
        page: PageInfo,
        structure: z.string().max(100_000),
        text: z.string().max(100_000),
        truncated: z.boolean()
      })
      .strict()
  },
  extract: {
    params: z
      .object({
        sessionId: Session,
        fields: z.array(ExtractField).min(1).max(30),
        timeoutMs: Timeout
      })
      .strict(),
    result: z.object({ page: PageInfo, data: Extraction }).strict()
  },
  screenshot: {
    params: z.object({ sessionId: Session, fullPage: z.boolean(), path: Path }).strict(),
    result: z.object({ page: PageInfo, bytes: z.number().int().nonnegative() }).strict()
  },
  snapshotHtml: {
    params: z.object({ sessionId: Session, path: Path }).strict(),
    result: z.object({ page: PageInfo, bytes: z.number().int().nonnegative() }).strict()
  },
  download: {
    params: z
      .object({
        sessionId: Session,
        target: Locator,
        /** The quarantine folder: the file stays here until the host has checked it. */
        dir: Path,
        timeoutMs: Timeout
      })
      .strict(),
    result: z
      .object({
        page: PageInfo,
        path: Path,
        suggestedName: z.string().max(300),
        url: z.string().max(2000),
        bytes: z.number().int().nonnegative()
      })
      .strict()
  },
  upload: {
    params: z
      .object({ sessionId: Session, target: Locator, path: Path, timeoutMs: Timeout })
      .strict(),
    result: z.object({ page: PageInfo, attached: z.array(z.string().max(200)).max(20) }).strict()
  },
  clickPoint: {
    params: z
      .object({ sessionId: Session, x: z.number().int().min(0), y: z.number().int().min(0) })
      .strict(),
    result: z
      .object({
        page: PageInfo,
        viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict()
      })
      .strict()
  },
  stop: {
    params: z.object({ sessionId: Session }).strict(),
    result: z.object({ stopped: z.boolean() }).strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type RuntimeOp = keyof typeof RuntimeOps
export type RuntimeParams<O extends RuntimeOp> = z.infer<(typeof RuntimeOps)[O]['params']>
export type RuntimeResult<O extends RuntimeOp> = z.infer<(typeof RuntimeOps)[O]['result']>

export const RuntimeRequest = z
  .object({ id: z.number().int().positive(), op: z.string().max(40), params: z.unknown() })
  .strict()
export type RuntimeRequest = z.infer<typeof RuntimeRequest>

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
