import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  BrowserCall,
  BrowserOps,
  DownloadType,
  originOf,
  type BrowserOp,
  type BrowserSession,
  type BrowserStatus
} from '@jupiter/contracts'
import { BrowserRuntime, BrowserRuntimeError } from '@jupiter/browser-runtime'
import { JupiterError, type Logger } from '@jupiter/core'

/**
 * The host's part of the Browser Agent (SET 9).
 *
 * Jupiter Core decides what to do, checks every permission and every origin;
 * the host decides what the browser may touch. It chooses the browser (an
 * installed Microsoft Edge, Google Chrome or Chromium — never the person's
 * own profile), the folders sessions keep data in, the quarantine folder
 * downloads land in until they are verified, the folder files may be
 * uploaded from, and where evidence is written. Playwright runs in the
 * browser runtime, a separate process: a fault there is a structured error
 * here, and the next call starts a new runtime.
 */

export interface BrowserExecutable {
  readonly path: string
  readonly name: string
}

export interface BrowserHostFolders {
  /** The persistent profile (only when the person turned it on). */
  readonly profile: string
  /** Downloads wait here until their name, size, origin and content are checked. */
  readonly quarantine: string
  /** Verified downloads. */
  readonly downloads: string
  /** The only folder files may be uploaded from. */
  readonly uploads: string
  readonly evidence: string
}

export interface BrowserHostOptions {
  readonly logger: Logger
  readonly executable: BrowserExecutable | null
  readonly folders: BrowserHostFolders
  /** The runtime bundle; null when the build does not contain it. */
  readonly runtimeEntry: string | null
  /** What runs the bundle: Electron as Node in the app, Node in tests. */
  readonly command: string
  readonly env?: Readonly<Record<string, string>>
  readonly headless?: boolean
  readonly runtime?: BrowserRuntime
}

const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

interface SessionMeta {
  readonly missionId: string | null
  readonly profile: 'temporary' | 'persistent'
  readonly createdAt: string
}

/** Where Chromium-family browsers are installed, in order of preference. */
export function findBrowser(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync
): BrowserExecutable | null {
  const candidates: BrowserExecutable[] = []
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(
      (root): root is string => typeof root === 'string' && root !== ''
    )
    for (const root of roots)
      candidates.push({
        path: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        name: 'Microsoft Edge'
      })
    for (const root of roots)
      candidates.push({
        path: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        name: 'Google Chrome'
      })
  } else if (platform === 'darwin') {
    candidates.push(
      {
        path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        name: 'Microsoft Edge'
      },
      {
        path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        name: 'Google Chrome'
      }
    )
  } else {
    for (const [path, name] of [
      ['/usr/bin/microsoft-edge', 'Microsoft Edge'],
      ['/usr/bin/google-chrome', 'Google Chrome'],
      ['/usr/bin/google-chrome-stable', 'Google Chrome'],
      ['/usr/bin/chromium', 'Chromium'],
      ['/usr/bin/chromium-browser', 'Chromium'],
      ['/snap/bin/chromium', 'Chromium']
    ] as const)
      candidates.push({ path, name })
  }
  return candidates.find((candidate) => exists(candidate.path)) ?? null
}

export class BrowserHost {
  private readonly runtime: BrowserRuntime | null
  private readonly sessions = new Map<string, SessionMeta>()
  private version: string | null = null

  constructor(private readonly options: BrowserHostOptions) {
    const { executable, runtimeEntry } = options
    this.runtime =
      options.runtime ??
      (executable && runtimeEntry
        ? new BrowserRuntime({
            launch: {
              command: options.command,
              entry: runtimeEntry,
              config: {
                executablePath: executable.path,
                headless: options.headless ?? true,
                // Chromium's sandbox cannot run as root (containers); everywhere else it stays on.
                noSandbox: process.platform === 'linux' && process.getuid?.() === 0
              },
              ...(options.env ? { env: options.env } : {})
            },
            onEvent: (event) => {
              options.logger.info(
                `browser.runtime.${event.kind}`,
                `Browser runtime ${event.kind}: ${event.detail}`,
                { pid: event.pid }
              )
            }
          })
        : null)
  }

  get available(): boolean {
    return this.runtime !== null
  }

  /** The runtime's process id, for Diagnostics and crash tests. */
  get runtimePid(): number | null {
    return this.runtime?.pid ?? null
  }

  private reason(): string | null {
    if (!this.options.executable)
      return 'No Chromium-based browser was found on this computer (Microsoft Edge, Google Chrome or Chromium). Install one to use the Browser Agent.'
    if (!this.options.runtimeEntry)
      return 'This build of Jupiter does not contain the browser runtime.'
    return null
  }

  /** Starts the runtime: the service's real health check. */
  async probe(): Promise<BrowserStatus> {
    if (this.runtime) {
      const pong = await this.runtime.call('ping', {})
      this.version = pong.version ?? this.version
    }
    return this.status()
  }

  status(): BrowserStatus {
    const runtime = this.runtime
    return {
      available: runtime !== null,
      reason: this.reason(),
      browser: this.options.executable?.name ?? null,
      version: this.version,
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
      // The setting lives in Core, which fills this in (and alone decides whether a session may use it).
      persistentProfile: false,
      downloadsFolder: runtime === null ? null : this.options.folders.downloads,
      uploadsFolder: runtime === null ? null : this.options.folders.uploads,
      sessions: this.sessions.size
    }
  }

  async call(raw: unknown): Promise<unknown> {
    const parsed = BrowserCall.safeParse(raw)
    if (!parsed.success)
      throw new JupiterError('INVALID_PAYLOAD', `Invalid browser call: ${parsed.error.message}`, {
        category: 'validation',
        userAction: null
      })
    const { op } = parsed.data
    const result = await this.perform(op, parsed.data.params)
    // What goes back to Core is checked like everything else crossing a boundary.
    return BrowserOps[op].result.parse(result)
  }

  async stop(): Promise<void> {
    await this.runtime?.stop()
    this.sessions.clear()
  }

  private async perform(op: BrowserOp, params: unknown): Promise<unknown> {
    if (op === 'status') {
      if (this.runtime) await this.probe().catch(() => undefined)
      return this.status()
    }
    if (op === 'resolveUpload') {
      const { fileName } = BrowserOps.resolveUpload.params.parse(params)
      const path = this.uploadPath(fileName)
      return { path, exists: existsSync(path) }
    }
    const runtime = this.runtime
    if (!runtime)
      throw new JupiterError(
        'BROWSER_UNAVAILABLE',
        this.reason() ?? 'The Browser Agent is not available.',
        {
          category: 'unsupported',
          userAction: null
        }
      )
    try {
      switch (op) {
        case 'openSession': {
          const input = BrowserOps.openSession.params.parse(params)
          if (input.profile === 'persistent') {
            if ([...this.sessions.values()].some((meta) => meta.profile === 'persistent'))
              throw new JupiterError(
                'PERSISTENT_PROFILE_IN_USE',
                'The persistent profile is already open in another session.',
                { category: 'validation', userAction: 'Close that session first.' }
              )
          }
          const opened = await runtime.call('openSession', {
            sessionId: input.sessionId,
            userDataDir: input.profile === 'persistent' ? this.options.folders.profile : null
          })
          const meta: SessionMeta = {
            missionId: input.missionId,
            profile: input.profile,
            createdAt: new Date().toISOString()
          }
          this.sessions.set(input.sessionId, meta)
          const pong = await runtime.call('ping', {})
          this.version = pong.version ?? this.version
          return this.session(opened.sessionId, opened.tabs, meta)
        }
        case 'closeSession': {
          const { sessionId } = BrowserOps.closeSession.params.parse(params)
          this.sessions.delete(sessionId)
          return await runtime.call('closeSession', { sessionId })
        }
        case 'listSessions': {
          const { sessions } = await runtime.call('listSessions', {})
          return {
            sessions: sessions.flatMap((session) => {
              const meta = this.sessions.get(session.sessionId)
              return meta ? [this.session(session.sessionId, session.tabs, meta)] : []
            })
          }
        }
        case 'page':
        case 'switchTab':
        case 'closeTab':
        case 'navigate':
        case 'newTab':
        case 'read':
        case 'clickPoint':
        case 'stop':
          return await runtime.call(op, BrowserOps[op].params.parse(params), deadlineOf(params))
        case 'click':
        case 'fill':
        case 'select':
        case 'press':
        case 'waitFor':
        case 'describe':
        case 'extract': {
          const input = BrowserOps[op].params.parse(params)
          return await runtime.call(op, input, deadlineOf(params))
        }
        case 'screenshot': {
          const input = BrowserOps.screenshot.params.parse(params)
          const file = this.evidenceName('png')
          const shot = await runtime.call('screenshot', {
            ...input,
            path: join(this.evidenceFolder(), file)
          })
          return { page: shot.page, file, bytes: shot.bytes }
        }
        case 'snapshotHtml': {
          const input = BrowserOps.snapshotHtml.params.parse(params)
          const file = this.evidenceName('html')
          const snap = await runtime.call('snapshotHtml', {
            ...input,
            path: join(this.evidenceFolder(), file)
          })
          return { page: snap.page, file, bytes: snap.bytes }
        }
        case 'download':
          return await this.download(runtime, BrowserOps.download.params.parse(params))
        case 'upload':
          return await this.upload(runtime, BrowserOps.upload.params.parse(params))
      }
    } catch (error) {
      throw toJupiterError(error)
    }
  }

  private session(
    sessionId: string,
    tabs: BrowserSession['tabs'],
    meta: SessionMeta
  ): BrowserSession {
    return {
      sessionId,
      missionId: meta.missionId,
      profile: meta.profile,
      tabs,
      createdAt: meta.createdAt
    }
  }

  private evidenceFolder(): string {
    mkdirSync(this.options.folders.evidence, { recursive: true })
    return this.options.folders.evidence
  }

  private evidenceName(extension: 'png' | 'html'): string {
    return `browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${extension}`
  }

  private uploadPath(fileName: string): string {
    const folder = resolve(this.options.folders.uploads)
    const path = resolve(folder, fileName)
    if (dirname(path) !== folder || basename(path) !== fileName)
      throw new JupiterError('INVALID_FILE_NAME', `"${fileName}" is not a plain file name.`, {
        category: 'validation',
        userAction: 'Use a file name from the upload folder, such as "report.pdf".'
      })
    return path
  }

  /** The file lands in quarantine and leaves it only once every check has passed. */
  private async download(
    runtime: BrowserRuntime,
    input: ReturnType<typeof BrowserOps.download.params.parse>
  ) {
    mkdirSync(this.options.folders.quarantine, { recursive: true })
    const got = await runtime.call(
      'download',
      {
        sessionId: input.sessionId,
        target: input.target,
        dir: this.options.folders.quarantine,
        timeoutMs: input.timeoutMs
      },
      deadlineOf(input)
    )
    const fileName = safeName(got.suggestedName)
    const sourceOrigin = originOf(got.url) ?? got.page.origin
    const reject = (why: string) => {
      rmSync(got.path, { force: true })
      return {
        page: got.page,
        verified: false,
        rejected: why,
        fileName,
        sourceOrigin,
        evidence: null
      }
    }
    if (dirname(resolve(got.path)) !== resolve(this.options.folders.quarantine))
      return reject('The runtime saved the file outside the quarantine folder.')
    if (sourceOrigin !== got.page.origin)
      return reject(
        `The file came from ${sourceOrigin}, not from the page's own origin ${got.page.origin}.`
      )
    if (got.bytes === 0) return reject('The file is empty.')
    if (got.bytes > input.maxBytes)
      return reject(
        `The file is ${String(got.bytes)} bytes, more than the ${String(input.maxBytes)} allowed.`
      )
    const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
    const declared = DownloadType.safeParse(extension === 'jpeg' ? 'jpg' : extension)
    if (!declared.success || !input.types.includes(declared.data))
      return reject(`"${fileName}" is not one of the expected types (${input.types.join(', ')}).`)
    const bytes = readFileSync(got.path)
    if (!contentMatches(declared.data, bytes))
      return reject(`The content of "${fileName}" is not a ${declared.data.toUpperCase()} file.`)
    mkdirSync(this.options.folders.downloads, { recursive: true })
    const path = uniquePath(this.options.folders.downloads, fileName)
    renameSync(got.path, path)
    return {
      page: got.page,
      verified: true,
      rejected: null,
      fileName: basename(path),
      sourceOrigin,
      evidence: {
        kind: 'download' as const,
        path,
        type: declared.data,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        origin: sourceOrigin
      }
    }
  }

  private async upload(
    runtime: BrowserRuntime,
    input: ReturnType<typeof BrowserOps.upload.params.parse>
  ) {
    const path = this.uploadPath(input.fileName)
    if (!existsSync(path) || !statSync(path).isFile())
      throw new JupiterError(
        'UPLOAD_FILE_NOT_FOUND',
        `"${input.fileName}" is not in the upload folder.`,
        {
          category: 'validation',
          userAction: `Put the file in ${this.options.folders.uploads} first.`
        }
      )
    const size = statSync(path).size
    if (size > UPLOAD_LIMIT_BYTES)
      throw new JupiterError('UPLOAD_TOO_LARGE', `"${input.fileName}" is larger than 50 MB.`, {
        category: 'validation',
        userAction: null
      })
    const done = await runtime.call('upload', {
      sessionId: input.sessionId,
      target: input.target,
      path,
      timeoutMs: input.timeoutMs
    })
    const bytes = readFileSync(path)
    return {
      page: done.page,
      attached: done.attached,
      evidence: {
        kind: 'upload' as const,
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        origin: done.page.origin
      }
    }
  }
}

/**
 * How long the runtime has to answer: the operation's own timeout and some
 * room, so a slow page ends with its own timeout, not as a hung runtime.
 */
function deadlineOf(params: unknown): number {
  const timeout = (params as { timeoutMs?: unknown } | null)?.timeoutMs
  return (typeof timeout === 'number' ? timeout : 30_000) + 15_000
}

/** The page's name for a file, reduced to a plain, safe file name. */
function safeName(suggested: string): string {
  const base = basename(suggested.replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 120)
  return base === '' ? 'download' : base
}

/** Never overwrites: `report.pdf`, then `report (2).pdf`, `report (3).pdf`… */
function uniquePath(folder: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''
  let path = join(folder, fileName)
  for (let n = 2; existsSync(path); n++) path = join(folder, `${stem} (${String(n)})${extension}`)
  return path
}

/** The file's own bytes must be what its name says. */
function contentMatches(type: DownloadType, bytes: Buffer): boolean {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  switch (type) {
    case 'pdf':
      return starts(0x25, 0x50, 0x44, 0x46, 0x2d)
    case 'png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'jpg':
      return starts(0xff, 0xd8, 0xff)
    case 'zip':
      return starts(0x50, 0x4b, 0x03, 0x04)
    case 'txt':
    case 'csv':
    case 'json': {
      if (bytes.includes(0)) return false
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      if (text.includes('�')) return false
      if (type !== 'json') return true
      try {
        JSON.parse(text)
        return true
      } catch {
        return false
      }
    }
  }
}

function toJupiterError(error: unknown): unknown {
  if (error instanceof JupiterError) return error
  if (error instanceof BrowserRuntimeError) {
    const runtimeFault = error.code.startsWith('RUNTIME_') || error.code === 'BROWSER_CRASHED'
    return new JupiterError(error.code, error.message, {
      category:
        error.code === 'CANCELLED'
          ? 'cancellation'
          : error.code === 'RUNTIME_TIMEOUT' || error.code === 'BROWSER_TIMEOUT'
            ? 'timeout'
            : error.code === 'INVALID_PAYLOAD'
              ? 'validation'
              : 'dependency',
      userAction: runtimeFault
        ? 'Try again: Jupiter starts a new browser runtime for the next action.'
        : null,
      retryable: runtimeFault
    })
  }
  return error
}
