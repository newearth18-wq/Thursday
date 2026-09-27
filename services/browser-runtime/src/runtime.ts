import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator as LocatorQuery, PageInfo } from '@jupiter/contracts'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page
} from 'playwright-core'
import {
  RuntimeConfig,
  RuntimeOps,
  RuntimeRequest,
  isRuntimeOp,
  type RuntimeOp,
  type RuntimeParams,
  type RuntimeReply,
  type RuntimeResult,
  type RuntimeSession
} from './protocol'

/**
 * The browser runtime process (SET 9).
 *
 * Started by the Jupiter host as its own process (a separate crash domain).
 * It drives one Chromium-family browser through Playwright and does exactly
 * what one validated request says, then answers. It decides nothing: which
 * pages it may visit, which actions need a permission and whether an origin
 * is allowed are decided by Jupiter Core before a request reaches it.
 *
 * Each session is its own browser context — its own cookies, storage and
 * downloads. A temporary session keeps nothing on disk; the persistent one
 * uses the profile folder the host chose. Pages may not open tabs by
 * themselves (they are closed), and no page is granted a browser permission
 * (location, camera, notifications…).
 */

class RuntimeFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

interface Session {
  readonly sessionId: string
  readonly context: BrowserContext
  /** A persistent session owns its own browser process. */
  readonly persistent: boolean
  readonly pages: Page[]
  active: number
  popupsClosed: number
  /** Checks of tabs a page opened, still under way (counted before a page is reported). */
  readonly popupChecks: Set<Promise<void>>
  /** Aborts the operation under way (stop). */
  abort: AbortController
}

const config = RuntimeConfig.parse(JSON.parse(process.env.JUPITER_BROWSER_CONFIG ?? '{}'))
const sessions = new Map<string, Session>()
let browser: Browser | null = null
let starting: Promise<Browser> | null = null

function send(reply: RuntimeReply): void {
  process.send?.(reply)
}

function launchArgs(): string[] {
  const args = ['--disable-extensions', '--disable-sync', '--no-first-run']
  if (config.noSandbox) args.push('--no-sandbox')
  return args
}

async function shared(): Promise<Browser> {
  if (browser?.isConnected()) return browser
  starting ??= chromium
    .launch({
      executablePath: config.executablePath,
      headless: config.headless,
      args: launchArgs()
    })
    .then((launched) => {
      browser = launched
      launched.on('disconnected', () => {
        if (browser === launched) browser = null
        for (const [id, session] of sessions) if (!session.persistent) sessions.delete(id)
      })
      return launched
    })
    .finally(() => {
      starting = null
    })
  return starting
}

const CONTEXT_OPTIONS = {
  acceptDownloads: true,
  // No page gets a browser permission (location, camera, microphone, notifications…).
  permissions: [] as string[],
  serviceWorkers: 'block' as const,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US'
}

function watch(session: Session, page: Page): void {
  session.pages.push(page)
  page.on('close', () => {
    const index = session.pages.indexOf(page)
    if (index >= 0) session.pages.splice(index, 1)
    if (session.active >= session.pages.length)
      session.active = Math.max(0, session.pages.length - 1)
  })
}

async function openSession(params: RuntimeParams<'openSession'>): Promise<RuntimeSession> {
  if (sessions.has(params.sessionId))
    throw new RuntimeFailure('SESSION_EXISTS', 'A session with this id is already open.')
  let context: BrowserContext
  if (params.userDataDir !== null) {
    mkdirSync(params.userDataDir, { recursive: true })
    context = await chromium.launchPersistentContext(params.userDataDir, {
      ...CONTEXT_OPTIONS,
      executablePath: config.executablePath,
      headless: config.headless,
      args: launchArgs()
    })
  } else {
    context = await (await shared()).newContext(CONTEXT_OPTIONS)
  }
  const session: Session = {
    sessionId: params.sessionId,
    context,
    persistent: params.userDataDir !== null,
    pages: [],
    active: 0,
    popupsClosed: 0,
    popupChecks: new Set(),
    abort: new AbortController()
  }
  // A page may not open tabs by itself (window.open, target=_blank): no request of such a tab
  // leaves the browser, and the tab is closed and counted.
  await context.route('**/*', (route) => {
    let page: Page | null
    try {
      page = route.request().frame().page()
    } catch {
      // The navigation of a tab that has no frame yet: a tab a page opened by itself.
      session.popupsClosed += 1
      return route.abort('blockedbyclient').catch(() => undefined)
    }
    if (!session.pages.includes(page)) return route.abort('blockedbyclient').catch(() => undefined)
    return route.fallback().catch(() => undefined)
  })
  context.on('page', (page) => {
    const check = page
      .opener()
      .then(async (opener) => {
        // Counted when its navigation was blocked; here the tab itself is closed.
        if (opener !== null) await page.close().catch(() => undefined)
      })
      .catch(() => undefined)
      .finally(() => session.popupChecks.delete(check))
    session.popupChecks.add(check)
  })
  const existing = context.pages()
  if (existing.length > 0) for (const page of existing) watch(session, page)
  else watch(session, await context.newPage())
  sessions.set(params.sessionId, session)
  return describeSession(session)
}

async function newPage(session: Session): Promise<Page> {
  const page = await session.context.newPage()
  watch(session, page)
  return page
}

function describeSession(session: Session): RuntimeSession {
  return {
    sessionId: session.sessionId,
    persistent: session.persistent,
    tabs: session.pages.map((page, index) => ({
      index,
      url: page.url().slice(0, 2000),
      title: '',
      active: index === session.active
    }))
  }
}

function sessionOf(sessionId: string): Session {
  const session = sessions.get(sessionId)
  if (!session)
    throw new RuntimeFailure(
      browser === null && !starting ? 'BROWSER_CRASHED' : 'SESSION_NOT_FOUND',
      'This browser session is not open (it was closed, or the browser stopped).'
    )
  return session
}

function pageOf(session: Session): Page {
  const page = session.pages[session.active]
  if (!page || page.isClosed())
    throw new RuntimeFailure('TAB_NOT_FOUND', 'The session has no open tab.')
  return page
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : 'null'
  } catch {
    return 'null'
  }
}

async function info(session: Session): Promise<PageInfo> {
  const page = pageOf(session)
  const title = await page.title().catch(() => '')
  await Promise.all([...session.popupChecks])
  const popups = session.popupsClosed
  session.popupsClosed = 0
  return {
    url: page.url().slice(0, 2000),
    origin: originOf(page.url()),
    title: title.slice(0, 500),
    tab: session.active,
    tabs: session.pages.length,
    popupsClosed: popups
  }
}

/** A Playwright locator from a query: role and name first, a CSS selector only as the last choice. */
function locate(
  page: Page,
  query: LocatorQuery
): { locator: Locator; label: string; method: 'semantic' | 'selector' } {
  const exact = query.exact ?? false
  let locator: Locator
  let label: string
  let method: 'semantic' | 'selector' = 'semantic'
  if (query.role !== undefined) {
    locator = page.getByRole(
      query.role,
      query.name === undefined ? {} : { name: query.name, exact }
    )
    label = query.name === undefined ? query.role : `${query.role} "${query.name}"`
  } else if (query.label !== undefined) {
    locator = page.getByLabel(query.label, { exact })
    label = `field labelled "${query.label}"`
  } else if (query.placeholder !== undefined) {
    locator = page.getByPlaceholder(query.placeholder, { exact })
    label = `field with placeholder "${query.placeholder}"`
  } else if (query.text !== undefined) {
    locator = page.getByText(query.text, { exact })
    label = `text "${query.text}"`
  } else if (query.testId !== undefined) {
    locator = page.getByTestId(query.testId)
    label = `test id "${query.testId}"`
  } else {
    locator = page.locator(query.css ?? 'body')
    label = `selector ${query.css ?? ''}`
    method = 'selector'
  }
  return { locator, label, method }
}

/** Waits for the control; exactly which one (the n-th) when several match. */
async function find(
  session: Session,
  query: LocatorQuery,
  timeoutMs: number
): Promise<{ locator: Locator; found: string; method: 'semantic' | 'selector' }> {
  const page = pageOf(session)
  const { locator, label, method } = locate(page, query)
  const chosen = locator.nth(query.index ?? 0)
  try {
    await chosen.waitFor({ state: 'attached', timeout: timeoutMs })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new RuntimeFailure(
        'ELEMENT_NOT_FOUND',
        `No control matches (${label}) on ${originOf(page.url())} within ${String(timeoutMs)} ms.`
      )
    throw error
  }
  const count = await locator.count()
  const found =
    count > 1 ? `${label} (match ${String((query.index ?? 0) + 1)} of ${String(count)})` : label
  return { locator: chosen, found: found.slice(0, 300), method }
}

async function settle(page: Page): Promise<void> {
  // A click or key may start a navigation: give it a moment to commit, without waiting for slow pages.
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined)
}

/** Runs an operation of a session, stopped at once by `stop`. */
async function guarded<T>(session: Session, work: () => Promise<T>): Promise<T> {
  const { signal } = session.abort
  const listener = { remove: (): void => undefined }
  const stopped = new Promise<never>((_, reject) => {
    const onAbort = () => {
      reject(new RuntimeFailure('CANCELLED', 'The operation was stopped.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    listener.remove = () => {
      signal.removeEventListener('abort', onAbort)
    }
  })
  try {
    return await Promise.race([work(), stopped])
  } finally {
    listener.remove()
  }
}

const handlers: { [O in RuntimeOp]: (params: RuntimeParams<O>) => Promise<RuntimeResult<O>> } = {
  ping() {
    return Promise.resolve({
      pid: process.pid,
      version: browser?.isConnected() ? browser.version().slice(0, 100) : null,
      sessions: sessions.size
    })
  },
  openSession,
  async closeSession({ sessionId }) {
    const session = sessions.get(sessionId)
    if (!session) return { closed: false }
    sessions.delete(sessionId)
    session.abort.abort()
    await session.context.close().catch(() => undefined)
    return { closed: true }
  },
  listSessions() {
    return Promise.resolve({ sessions: [...sessions.values()].map(describeSession) })
  },
  async page({ sessionId }) {
    return { page: await info(sessionOf(sessionId)) }
  },
  async navigate({ sessionId, url, timeoutMs }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    const response = await guarded(session, () =>
      page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    )
    return { page: await info(session), status: response?.status() ?? null }
  },
  async newTab({ sessionId, url, timeoutMs }) {
    const session = sessionOf(sessionId)
    const page = await newPage(session)
    session.active = session.pages.indexOf(page)
    if (url !== null)
      await guarded(session, () =>
        page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
      )
    return { page: await info(session) }
  },
  async switchTab({ sessionId, index }) {
    const session = sessionOf(sessionId)
    const page = session.pages[index]
    if (!page) throw new RuntimeFailure('TAB_NOT_FOUND', `There is no tab ${String(index + 1)}.`)
    session.active = index
    await page.bringToFront()
    return { page: await info(session) }
  },
  async closeTab({ sessionId, index }) {
    const session = sessionOf(sessionId)
    const page = session.pages[index ?? session.active]
    if (!page) throw new RuntimeFailure('TAB_NOT_FOUND', 'There is no such tab.')
    if (session.pages.length === 1) await newPage(session)
    await page.close()
    session.active = Math.min(session.active, session.pages.length - 1)
    return { page: await info(session) }
  },
  async click({ sessionId, target, timeoutMs }) {
    const session = sessionOf(sessionId)
    const { locator, found, method } = await find(session, target, timeoutMs)
    await guarded(session, () => locator.click({ timeout: timeoutMs }))
    await settle(pageOf(session))
    return { page: await info(session), found, method }
  },
  async fill({ sessionId, target, text, timeoutMs }) {
    const session = sessionOf(sessionId)
    const { locator, found, method } = await find(session, target, timeoutMs)
    await guarded(session, () => locator.fill(text, { timeout: timeoutMs }))
    const value = await locator.inputValue({ timeout: timeoutMs }).catch(() => null)
    const sensitive = (await locator.getAttribute('type').catch(() => null)) === 'password'
    return { page: await info(session), found, method, matches: value === text, sensitive }
  },
  async select({ sessionId, target, value, timeoutMs }) {
    const session = sessionOf(sessionId)
    const { locator, found, method } = await find(session, target, timeoutMs)
    const selected = await guarded(session, () =>
      locator.selectOption(value, { timeout: timeoutMs })
    )
    return { page: await info(session), found, method, selected: selected.slice(0, 50) }
  },
  async press({ sessionId, target, keys, timeoutMs }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    const on = target === null ? null : (await find(session, target, timeoutMs)).locator
    for (const key of keys)
      await guarded(session, () =>
        on ? on.press(key, { timeout: timeoutMs }) : page.keyboard.press(key)
      )
    await settle(page)
    return { page: await info(session) }
  },
  async waitFor({ sessionId, target, urlContains, state, timeoutMs }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    await guarded(session, async () => {
      if (target !== null) await find(session, target, timeoutMs)
      if (urlContains !== null)
        await page.waitForURL((url) => url.href.includes(urlContains), { timeout: timeoutMs })
      if (state !== null) await page.waitForLoadState(state, { timeout: timeoutMs })
    })
    return { page: await info(session) }
  },
  async describe({ sessionId, target, timeoutMs }) {
    const session = sessionOf(sessionId)
    const { locator, found, method } = await find(session, target, timeoutMs)
    const facts = await locator.evaluate((element) => {
      const tag = element.tagName.toLowerCase()
      const type = (element.getAttribute('type') ?? '').toLowerCase()
      const form = (element as HTMLButtonElement).form ?? element.closest('form')
      let kind: 'link' | 'button' | 'submit' | 'field' | 'password' | 'file' | 'other' = 'other'
      if (tag === 'a' && element.hasAttribute('href')) kind = 'link'
      else if (tag === 'input' && type === 'password') kind = 'password'
      else if (tag === 'input' && type === 'file') kind = 'file'
      else if (
        (tag === 'button' && (type === '' || type === 'submit') && form) ||
        (tag === 'input' && type === 'submit')
      )
        kind = 'submit'
      else if (tag === 'button' || element.getAttribute('role') === 'button') kind = 'button'
      else if (tag === 'input' || tag === 'textarea' || tag === 'select') kind = 'field'
      return {
        kind,
        formAction: form ? form.action : null,
        formHasPassword: form ? form.querySelector('input[type="password"]') !== null : false
      }
    })
    return {
      page: await info(session),
      found,
      method,
      kind: facts.kind,
      formAction: facts.formAction?.slice(0, 2000) ?? null,
      formHasPassword: facts.formHasPassword
    }
  },
  async read({ sessionId, maxChars }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    const body = page.locator('body')
    const [structure, text] = await guarded(session, () =>
      Promise.all([
        body.ariaSnapshot({ timeout: 10_000 }).catch(() => ''),
        body.innerText({ timeout: 10_000 }).catch(() => '')
      ])
    )
    return {
      page: await info(session),
      structure: structure.slice(0, maxChars),
      text: text.slice(0, maxChars),
      truncated: structure.length > maxChars || text.length > maxChars
    }
  },
  async extract({ sessionId, fields, timeoutMs }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    const data: Record<string, string | string[] | null> = {}
    for (const field of fields) {
      const { locator } = locate(page, field.target)
      const matches = field.all ? locator : locator.nth(field.target.index ?? 0)
      const take = async (item: Locator): Promise<string | null> =>
        field.take === 'text'
          ? (await item.innerText({ timeout: timeoutMs })).trim()
          : field.take === 'href'
            ? await item.evaluate((element) => (element as HTMLAnchorElement).href || null)
            : await item.inputValue({ timeout: timeoutMs })
      if (field.all) {
        const all = await guarded(session, () => matches.all())
        const values: string[] = []
        for (const item of all.slice(0, 200)) {
          const value = await take(item)
          if (value !== null) values.push(value.slice(0, 10_000))
        }
        data[field.name] = values
      } else {
        const present = (await matches.count()) > 0
        data[field.name] = present ? ((await take(matches))?.slice(0, 10_000) ?? null) : null
      }
    }
    return { page: await info(session), data }
  },
  async screenshot({ sessionId, fullPage, path }) {
    const session = sessionOf(sessionId)
    const image = await guarded(session, () => pageOf(session).screenshot({ path, fullPage }))
    return { page: await info(session), bytes: image.length }
  },
  async snapshotHtml({ sessionId, path }) {
    const session = sessionOf(sessionId)
    const html = await guarded(session, () => pageOf(session).content())
    writeFileSync(path, html, 'utf8')
    return { page: await info(session), bytes: Buffer.byteLength(html, 'utf8') }
  },
  async download({ sessionId, target, dir, timeoutMs }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    const { locator } = await find(session, target, timeoutMs)
    const download = await guarded(session, async () => {
      const [started] = await Promise.all([
        page.waitForEvent('download', { timeout: timeoutMs }),
        locator.click({ timeout: timeoutMs })
      ])
      return started
    })
    mkdirSync(dir, { recursive: true })
    // The page's name for the file is not trusted: the quarantine copy gets a name of our own.
    const path = join(dir, `${randomUUID()}.download`)
    await guarded(session, () => download.saveAs(path))
    const failure = await download.failure()
    if (failure !== null)
      throw new RuntimeFailure('DOWNLOAD_FAILED', `The download failed: ${failure}`)
    const { size } = statSync(path)
    return {
      page: await info(session),
      path,
      suggestedName: basename(download.suggestedFilename()).slice(0, 300),
      url: download.url().slice(0, 2000),
      bytes: size
    }
  },
  async upload({ sessionId, target, path, timeoutMs }) {
    const session = sessionOf(sessionId)
    const { locator } = await find(session, target, timeoutMs)
    await guarded(session, () => locator.setInputFiles(path, { timeout: timeoutMs }))
    const attached = await locator.evaluate((element) =>
      Array.from((element as HTMLInputElement).files ?? []).map((file) => file.name)
    )
    return { page: await info(session), attached: attached.slice(0, 20) }
  },
  async clickPoint({ sessionId, x, y }) {
    const session = sessionOf(sessionId)
    const page = pageOf(session)
    const viewport = page.viewportSize() ?? { width: 0, height: 0 }
    if (x >= viewport.width || y >= viewport.height)
      throw new RuntimeFailure(
        'POINT_OUTSIDE_PAGE',
        `The point ${String(x)},${String(y)} is outside the page (${String(viewport.width)}×${String(viewport.height)}).`
      )
    await guarded(session, () => page.mouse.click(x, y))
    await settle(page)
    return { page: await info(session), viewport }
  },
  async stop({ sessionId }) {
    const session = sessions.get(sessionId)
    if (!session) return { stopped: false }
    session.abort.abort()
    session.abort = new AbortController()
    // Stop loading at once, so a slow page does not keep the tab busy.
    const page = session.pages[session.active]
    if (page && !page.isClosed()) {
      const cdp = await session.context.newCDPSession(page).catch(() => null)
      await cdp?.send('Page.stopLoading').catch(() => undefined)
      await cdp?.detach().catch(() => undefined)
    }
    return { stopped: true }
  }
}

/** Playwright's messages carry a call log; only the first line is the error. */
function errorOf(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeFailure)
    return { code: error.code, message: error.message.slice(0, 2000) }
  const text = error instanceof Error ? error.message : String(error)
  const first = (text.split('\n')[0] ?? text).replace(/^[a-zA-Z.]+: /, '').slice(0, 500)
  if (error instanceof Error && error.name === 'TimeoutError')
    return { code: 'BROWSER_TIMEOUT', message: first }
  if (
    /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected/i.test(
      text
    )
  )
    return {
      code: 'BROWSER_CRASHED',
      message: 'The browser or the tab closed during the operation.'
    }
  if (text.includes('net::ERR_')) return { code: 'NAVIGATION_FAILED', message: first }
  return { code: 'BROWSER_OPERATION_FAILED', message: first }
}

async function handle(raw: unknown): Promise<void> {
  const request = RuntimeRequest.safeParse(raw)
  if (!request.success) return
  const { id, op, params } = request.data
  try {
    if (!isRuntimeOp(op)) throw new RuntimeFailure('UNKNOWN_OPERATION', `Unknown operation ${op}.`)
    const parsed = RuntimeOps[op].params.safeParse(params)
    if (!parsed.success)
      throw new RuntimeFailure(
        'INVALID_PAYLOAD',
        `Invalid parameters for ${op}: ${parsed.error.message}`
      )
    const handler = handlers[op] as (input: unknown) => Promise<unknown>
    send({ id, ok: true, result: await handler(parsed.data) })
  } catch (error) {
    send({ id, ok: false, error: errorOf(error) })
  }
}

process.on('message', (message) => {
  // Requests run side by side: `stop` must reach a session while its operation is under way.
  void handle(message)
})
process.on('disconnect', () => {
  void browser?.close().catch(() => undefined)
  process.exit(0)
})
send({ id: 0, ok: true, result: { pid: process.pid } })
