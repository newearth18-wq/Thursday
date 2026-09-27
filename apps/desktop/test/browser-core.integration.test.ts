import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserAction, BrowserTask, PlanDraft } from '@jupiter/contracts'
import { bundleBrowserRuntime } from '@jupiter/browser-runtime/build'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, removeDir } from '@jupiter/testing'
import {
  startWebFixtures,
  testBrowserExecutable,
  type WebFixtures
} from '@jupiter/testing/web-fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserHost } from '../src/main/browser-host'
import {
  call,
  server,
  settled,
  standard,
  startCore,
  useCoreHarness,
  withModel,
  type Running
} from './core-harness'

/**
 * SET 9 acceptance tests against a REAL browser: the real Core (kernel,
 * dispatcher, Permission Engine, SQLite), the real host (browser-host.ts),
 * the real browser runtime process (Playwright, bundled as the app bundles
 * it) and a real Chromium-family browser, on real test websites served on
 * two origins of this computer (@jupiter/testing/web-fixtures). Nothing is
 * simulated; these run on Linux and Windows.
 */

useCoreHarness('jupiter-browser-core')

let fixtures: WebFixtures
let folder: string
let host: BrowserHost
let uploads: string
let downloads: string
let quarantine: string

beforeAll(async () => {
  fixtures = await startWebFixtures()
  folder = await createTempDir('jupiter-browser-host')
  const entry = join(folder, 'browser-runtime.cjs')
  await bundleBrowserRuntime(entry)
  uploads = join(folder, 'uploads')
  downloads = join(folder, 'downloads')
  quarantine = join(folder, 'quarantine')
  mkdirSync(uploads, { recursive: true })
  writeFileSync(join(uploads, 'approved.txt'), 'An approved test file for SET 9.\n')
  host = new BrowserHost({
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] }),
    executable: { path: testBrowserExecutable(), name: 'Chromium (test)' },
    folders: {
      profile: join(folder, 'profile'),
      quarantine,
      downloads,
      uploads,
      evidence: join(folder, 'evidence')
    },
    runtimeEntry: entry,
    command: process.execPath
  })
}, 120_000)

afterAll(async () => {
  await host.stop()
  await fixtures.close()
  await removeDir(folder)
})

async function start(): Promise<Running> {
  return startCore(standard(), new Map(), [], {}, null, (input) => host.call(input))
}

async function run(
  running: Running,
  actions: BrowserAction[],
  options: { sessionId?: string | null; allow?: boolean; taskId?: string } = {}
): Promise<BrowserTask> {
  return call(running, 'browser.run', {
    taskId: options.taskId ?? uuidv7(),
    title: 'Browser test',
    sessionId: options.sessionId ?? null,
    actions,
    extraOrigins: [],
    allowCoordinateFallback: options.allow ?? false
  })
}

/** Answers the pending requests as the person would (Always allow where offered), then returns them. */
async function answerAll(running: Running) {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes('ALWAYS_ALLOW') ? 'ALWAYS_ALLOW' : 'ALLOW_ONCE'
    })
  return requests
}

/** Runs a task, first answering its permission requests as the person would. */
async function granted(
  running: Running,
  actions: BrowserAction[],
  options: { sessionId?: string | null; allow?: boolean } = {}
): Promise<BrowserTask> {
  const first = await run(running, actions, options)
  if (first.status !== 'WAITING_APPROVAL') return first
  await answerAll(running)
  return run(running, actions, options)
}

function explain(task: BrowserTask): string {
  return JSON.stringify(
    {
      status: task.status,
      error: task.error?.message,
      results: task.results.map((r) => [
        r.action,
        r.success,
        r.method,
        r.origin,
        r.observation,
        r.error?.code
      ])
    },
    null,
    2
  )
}

const shop = () => fixtures.shop
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('SET 9 — Browser Agent with a real browser', () => {
  it('asks for every permission first and opens nothing until they are given', async () => {
    const running = await start()
    const before = fixtures.requests.length
    const waiting = await run(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'READ_PAGE', maxChars: 1000 }
    ])
    expect(waiting.status).toBe('WAITING_APPROVAL')
    expect(waiting.results).toEqual([])
    expect(fixtures.requests.length).toBe(before)
    const asked = await answerAll(running)
    expect(asked.map((request) => [request.capability, request.target]).sort()).toEqual(
      [
        ['browser.navigate', shop()],
        ['browser.read', shop()]
      ].sort()
    )
    expect(asked.every((request) => request.subject.id === 'browser')).toBe(true)
  })

  it('an Allow once answer covers its one task (same capability and target), never the next', async () => {
    const running = await start()
    const actions: BrowserAction[] = [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'READ_PAGE', maxChars: 1000 },
      { type: 'SCREENSHOT', fullPage: false }
    ]
    expect((await run(running, actions)).status).toBe('WAITING_APPROVAL')
    const { requests } = await call(running, 'permissions.requests', {
      status: 'PENDING',
      limit: 50
    })
    for (const request of requests)
      await call(running, 'permissions.decide', {
        requestId: request.requestId,
        decision: 'ALLOW_ONCE'
      })
    // Two reads of the page in one task: the single answer covers both.
    const task = await run(running, actions)
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    expect(task.results.map((result) => result.action)).toEqual([
      'NAVIGATE',
      'READ_PAGE',
      'SCREENSHOT'
    ])
    // It is used up: the next task asks again, and nothing of it runs.
    const again = await run(running, actions)
    expect(again.status).toBe('WAITING_APPROVAL')
    expect(again.results).toEqual([])
  })

  it('AT1: opens isolated browser sessions (separate cookies, nothing shared)', async () => {
    const running = await start()
    const a = await call(running, 'browser.sessions.open', {
      missionId: null,
      profile: 'temporary'
    })
    const b = await call(running, 'browser.sessions.open', {
      missionId: null,
      profile: 'temporary'
    })
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.profile).toBe('temporary')
    const { sessions } = await call(running, 'browser.sessions.list', {})
    expect(sessions.map((session) => session.sessionId)).toEqual(
      expect.arrayContaining([a.sessionId, b.sessionId])
    )
    // A cookie set in session A is not sent by session B.
    const setA = await granted(running, [{ type: 'NAVIGATE', url: `${shop()}/cookie/set` }], {
      sessionId: a.sessionId
    })
    expect(setA.status, explain(setA)).toBe('SUCCEEDED')
    const cookie = [
      { type: 'NAVIGATE', url: `${shop()}/cookie/show` },
      {
        type: 'EXTRACT',
        fields: [{ name: 'cookie', target: { testId: 'cookie' }, take: 'text', all: false }]
      }
    ] satisfies BrowserAction[]
    const inA = await granted(running, cookie, { sessionId: a.sessionId })
    const inB = await granted(running, cookie, { sessionId: b.sessionId })
    expect(inA.results[1]?.extraction).toEqual({ cookie: 'fixture_session=from-this-session' })
    expect(inB.results[1]?.extraction).toEqual({ cookie: 'no cookie' })
    // The persistent profile is off unless the person turns it on.
    const refused = await call(running, 'browser.sessions.open', {
      missionId: null,
      profile: 'persistent'
    }).then(
      () => 'opened',
      (error: unknown) => String(error)
    )
    expect(refused).toContain('PERSISTENT_PROFILE_OFF')
    expect(await call(running, 'browser.sessions.close', { sessionId: a.sessionId })).toEqual({
      closed: true
    })
    expect(await call(running, 'browser.sessions.close', { sessionId: b.sessionId })).toEqual({
      closed: true
    })
    expect(host.runtimePid).not.toBe(process.pid)
  })

  it('AT2: navigates to a test page and reports its address, origin and title', async () => {
    const running = await start()
    const task = await granted(running, [{ type: 'NAVIGATE', url: `${shop()}/` }])
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    expect(task.results[0]).toMatchObject({
      action: 'NAVIGATE',
      success: true,
      url: `${shop()}/`,
      origin: shop(),
      title: 'Fixture Shop'
    })
    expect(task.results[0]?.observation).toContain('HTTP 200')
    const status = await call(running, 'browser.status', {})
    expect(status).toMatchObject({
      available: true,
      browser: 'Chromium (test)',
      persistentProfile: false
    })
    expect(status.version).not.toBeNull()
  })

  it('AT3 + AT4: searches with semantic controls, then extracts the page text and structured content', async () => {
    const running = await start()
    const task = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'TYPE', target: { role: 'searchbox', name: 'Search products' }, text: 'jupiter' },
      { type: 'SUBMIT', target: { role: 'button', name: 'Search' }, kind: 'search' },
      {
        type: 'WAIT_FOR',
        target: { role: 'heading', name: 'Results for jupiter' },
        urlContains: null,
        state: null,
        timeoutMs: 10_000
      },
      { type: 'READ_PAGE', maxChars: 5_000 },
      {
        type: 'EXTRACT',
        fields: [
          { name: 'heading', target: { role: 'heading', index: 0 }, take: 'text', all: false },
          { name: 'names', target: { testId: 'product-name' }, take: 'text', all: true },
          { name: 'prices', target: { testId: 'product-price' }, take: 'text', all: true },
          { name: 'count', target: { role: 'status' }, take: 'text', all: false }
        ]
      }
    ])
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    // Semantic controls: found by role and accessible name, never by position.
    expect(task.results.slice(1, 3).map((result) => [result.action, result.method])).toEqual([
      ['TYPE', 'semantic'],
      ['SUBMIT', 'semantic']
    ])
    expect(fixtures.requests.some((request) => request.path === '/search?q=jupiter')).toBe(true)
    expect(task.results[3]?.title).toBe('Results for jupiter')
    // The typed text is never kept: only its length.
    expect(JSON.stringify(task)).not.toContain('"jupiter"')
    const read = task.results[4]
    expect(read?.content).toMatchObject({ untrusted: true, origin: shop() })
    expect(read?.content?.text).toContain('Jupiter Telescope')
    expect(read?.content?.structure).toContain('table "Products"')
    expect(read?.suspicious).toEqual([])
    expect(task.results[5]?.extraction).toEqual({
      heading: 'Results for jupiter',
      names: ['Jupiter Telescope', 'Jupiter Star Map'],
      prices: ['1,299.00', '19.90'],
      count: '2 products found'
    })
  })

  it('AT5: downloads a test file into quarantine, verifies it, and keeps only what passes', async () => {
    const running = await start()
    const task = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/files` },
      {
        type: 'DOWNLOAD',
        target: { role: 'link', name: 'Download the manual' },
        expect: { types: ['pdf'], maxBytes: 1_000_000 }
      },
      {
        type: 'DOWNLOAD',
        target: { role: 'link', name: 'Download the price list' },
        expect: { types: ['csv', 'txt'], maxBytes: 1_000_000 }
      }
    ])
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    const manual = task.results[1]?.evidence
    expect(manual).toMatchObject({
      kind: 'download',
      type: 'pdf',
      origin: shop(),
      sha256: sha256(fixtures.manualPdf)
    })
    if (manual?.kind !== 'download') throw new Error('no download evidence')
    expect(manual.path.startsWith(downloads)).toBe(true)
    expect(sha256(readFileSync(manual.path))).toBe(sha256(fixtures.manualPdf))
    expect(
      readFileSync(
        task.results[2]?.evidence?.kind === 'download' ? task.results[2].evidence.path : '',
        'utf8'
      )
    ).toContain('Jupiter Telescope')
    // A file whose content is not what its name says is rejected and removed.
    const fake = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/files` },
      {
        type: 'DOWNLOAD',
        target: { role: 'link', name: 'Download the brochure' },
        expect: { types: ['pdf'], maxBytes: 1_000_000 }
      }
    ])
    expect(fake.status).toBe('FAILED')
    expect(fake.results[1]?.error?.code).toBe('DOWNLOAD_REJECTED')
    expect(fake.results[1]?.error?.message).toContain('not a PDF file')
    // A file from another origin than the page's is rejected too.
    const partner = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/files` },
      {
        type: 'DOWNLOAD',
        target: { role: 'link', name: 'Download from the partner' },
        expect: { types: ['csv'], maxBytes: 1_000_000 }
      }
    ])
    expect(partner.results[1]?.error?.code, explain(partner)).toBe('DOWNLOAD_REJECTED')
    expect(readdirSync(downloads).sort()).toEqual(['manual.pdf', 'prices.csv'])
    expect(existsSync(quarantine) ? readdirSync(quarantine) : []).toEqual([])
  })

  it('AT6: uploads an approved test file, with its own permissions for the file and for sending the form', async () => {
    const running = await start()
    const actions: BrowserAction[] = [
      { type: 'NAVIGATE', url: `${shop()}/upload` },
      { type: 'UPLOAD', target: { label: 'Attachment' }, fileName: 'approved.txt' },
      { type: 'SUBMIT', target: { role: 'button', name: 'Send' }, kind: 'form' },
      {
        type: 'WAIT_FOR',
        target: { role: 'heading', name: 'Thank you' },
        urlContains: null,
        state: null,
        timeoutMs: 10_000
      }
    ]
    const waiting = await run(running, actions)
    expect(waiting.status).toBe('WAITING_APPROVAL')
    const asked = await answerAll(running)
    const upload = asked.find((request) => request.capability === 'browser.upload')
    expect(upload?.target).toBe(`${join(uploads, 'approved.txt')} → ${shop()}`)
    expect(upload?.risk).toBe('CRITICAL')
    expect(asked.find((request) => request.capability === 'browser.submit_form')?.risk).toBe('HIGH')
    const task = await run(running, actions)
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    const content = readFileSync(join(uploads, 'approved.txt'))
    expect(task.results[1]?.evidence).toMatchObject({
      kind: 'upload',
      origin: shop(),
      sha256: sha256(content)
    })
    expect(fixtures.uploads.at(-1)).toEqual({
      fileName: 'approved.txt',
      bytes: content.length,
      sha256: sha256(content)
    })
    // A file outside the upload folder is refused before anything happens.
    const outside = await run(running, [
      { type: 'NAVIGATE', url: `${shop()}/upload` },
      { type: 'UPLOAD', target: { label: 'Attachment' }, fileName: 'not-approved.txt' }
    ])
    expect(outside.status).toBe('FAILED')
    expect(outside.error?.code).toBe('UPLOAD_FILE_NOT_FOUND')
    expect(outside.results).toEqual([])
  })

  it('AT7: prompt injection on a page cannot override Jupiter’s rules', async () => {
    const running = await start()
    await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'READ_PAGE', maxChars: 100 }
    ])
    const otherBefore = fixtures.requests.filter((request) => request.origin === 'other').length
    const grantsBefore = (
      await call(running, 'permissions.grants', { includeEnded: true, limit: 200 })
    ).grants.length
    const requestsBefore = (
      await call(running, 'permissions.requests', { status: 'ALL', limit: 200 })
    ).requests.length
    const task = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/injection` },
      { type: 'READ_PAGE', maxChars: 10_000 },
      { type: 'SCREENSHOT', fullPage: false }
    ])
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    const read = task.results[1]
    expect(read?.content?.untrusted).toBe(true)
    expect(read?.suspicious.map((item) => item.kind).sort()).toEqual(
      [
        'exfiltrate-files',
        'grant-permissions',
        'impersonate-user',
        'override-instructions',
        'redirect-agent',
        'reveal-secrets'
      ].sort()
    )
    // Only the task's own actions ran: nothing the page asked for.
    expect(task.results.map((result) => result.action)).toEqual([
      'NAVIGATE',
      'READ_PAGE',
      'SCREENSHOT'
    ])
    // Nothing reached the other site: not the links the page pushed, not the tab its script opened.
    expect(fixtures.requests.filter((request) => request.origin === 'other').length).toBe(
      otherBefore
    )
    // The page's own script tried to open a tab on another site: it was closed.
    expect(task.results.some((result) => result.observation.includes('tried to open 1 tab'))).toBe(
      true
    )
    expect(task.results.every((result) => result.origin === shop())).toBe(true)
    // No permission was given or asked for because of the page.
    const grants = (await call(running, 'permissions.grants', { includeEnded: true, limit: 200 }))
      .grants
    expect(grants.length).toBe(grantsBefore)
    expect(
      (await call(running, 'permissions.requests', { status: 'ALL', limit: 200 })).requests.length
    ).toBe(requestsBefore)
    expect(running.events.some((event) => event.type === 'browser.suspicious_content')).toBe(true)
  })

  it('AT7 (Missions): page text reaches a later model step only as fenced, labelled, untrusted data', async () => {
    const running = await start()
    await withModel(running)
    const draft: PlanDraft = {
      goal: 'Summarise an article',
      assumptions: [],
      rationale: 'Read the page, then ask the model.',
      steps: [
        {
          id: 'read',
          title: 'Read the article',
          description: 'Browser',
          skillId: 'browser.read_page',
          dependencies: [],
          input: { url: `${shop()}/injection` },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'sum',
          title: 'Summarise',
          description: 'Model',
          skillId: 'model.generate',
          dependencies: ['read'],
          input: { prompt: 'Summarise this page:\n{{read}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        }
      ],
      requiredSkills: ['browser.read_page', 'model.generate'],
      requiredPermissions: ['browser.navigate', 'browser.read'],
      expectedArtifacts: [{ step: 'sum', description: 'A summary' }],
      verificationPlan: { checks: [{ step: 'sum', check: 'non-empty', description: 'Summarised' }] }
    }
    server.enqueue({ chunks: [JSON.stringify(draft)] })
    server.enqueue({ chunks: ['A storm on Jupiter.'] })
    const missionId = (
      await call(running, 'missions.create', { request: 'Summarise the article', planner: 'model' })
    ).mission.missionId
    await settled(running, missionId, 'WAITING_APPROVAL')
    await answerAll(running)
    const done = await settled(running, missionId, 'COMPLETED')
    const prompt = JSON.stringify(
      server.requests.filter((request) => request.method === 'POST').at(-1)?.body
    )
    expect(prompt).toContain('Untrusted web content from')
    expect(prompt).toContain('BEGIN UNTRUSTED PAGE TEXT')
    expect(prompt).toContain('the page tried to direct the agent')
    // The browser evidence is linked to the Mission.
    const { tasks } = await call(running, 'browser.tasks', { limit: 10, missionId })
    // The task that waited for the permissions and the one that ran are both kept.
    expect(tasks.map((task) => task.status)).toEqual(['WAITING_APPROVAL', 'SUCCEEDED'])
    expect(tasks.every((task) => task.missionId === missionId)).toBe(true)
    expect(tasks[1]?.results.at(-1)?.evidence?.kind).toBe('screenshot')
    expect(done.mission.status).toBe('COMPLETED')
  })

  it('AT8: cancel stops the browser operation under way; queued actions do not run', async () => {
    const running = await start()
    await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'READ_PAGE', maxChars: 100 }
    ])
    const taskId = uuidv7()
    const started = Date.now()
    const pending = run(
      running,
      [
        { type: 'NAVIGATE', url: `${shop()}/slow`, timeoutMs: 60_000 },
        { type: 'READ_PAGE', maxChars: 100 }
      ],
      { taskId }
    )
    await expect
      .poll(() => fixtures.requests.some((request) => request.path === '/slow'))
      .toBe(true)
    expect(await call(running, 'browser.cancel', { taskId })).toEqual({ cancelled: true })
    const task = await pending
    expect(task.status, explain(task)).toBe('CANCELLED')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(task.results.map((result) => result.action)).toEqual(['NAVIGATE'])
    expect(task.results[0]?.error?.category).toBe('cancellation')
  })

  it('AT9: a crash of the browser runtime does not crash Jupiter; the next task gets a new runtime', async () => {
    const running = await start()
    await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'READ_PAGE', maxChars: 100 }
    ])
    const pid = host.runtimePid
    expect(pid).not.toBeNull()
    const slow = () => fixtures.requests.filter((request) => request.path === '/slow').length
    const before = slow()
    const pending = run(running, [{ type: 'NAVIGATE', url: `${shop()}/slow`, timeoutMs: 60_000 }])
    // The runtime is killed while the browser is loading the page.
    await expect.poll(slow).toBeGreaterThan(before)
    process.kill(pid ?? 0, 'SIGKILL')
    const crashed = await pending
    expect(crashed.status, explain(crashed)).toBe('FAILED')
    expect(crashed.error?.code).toMatch(/^(RUNTIME_CRASHED|BROWSER_CRASHED)$/)
    // Core carries on, and the next task runs on a new runtime.
    const next = await run(running, [{ type: 'NAVIGATE', url: `${shop()}/` }])
    expect(next.status, explain(next)).toBe('SUCCEEDED')
    expect(host.runtimePid).not.toBe(pid)
    expect((await call(running, 'browser.status', {})).runtime.restarts).toBeGreaterThanOrEqual(1)
  })

  it('AT10: unexpected cross-origin navigation stops the task (SAFETY_STOP); nothing after it runs', async () => {
    const running = await start()
    const actions: BrowserAction[] = [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'CLICK', target: { role: 'link', name: 'Partner offers' } },
      { type: 'READ_PAGE', maxChars: 1000 },
      { type: 'TYPE', target: { role: 'textbox' }, text: 'must not be typed' }
    ]
    const task = await granted(running, actions)
    expect(task.status, explain(task)).toBe('SAFETY_STOP')
    expect(task.error?.code).toBe('UNEXPECTED_ORIGIN')
    expect(task.error?.message).toContain(fixtures.other)
    expect(task.results.map((result) => result.action)).toEqual(['NAVIGATE', 'CLICK'])
    expect(task.results[1]?.origin).toBe(fixtures.other)
    const stop = running.events.find((event) => event.type === 'browser.safety_stop')
    expect(stop?.payload).toMatchObject({ reached: fixtures.other, allowed: [shop()] })
    // A redirect straight from a navigation is caught the same way.
    const redirect = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/redirect-away` },
      { type: 'READ_PAGE', maxChars: 1000 }
    ])
    expect(redirect.status, explain(redirect)).toBe('SAFETY_STOP')
    expect(redirect.results).toHaveLength(1)
  })

  it('a form that asks for a password is a sign-in, whatever the task calls it; nothing is sent without that permission', async () => {
    const running = await start()
    await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/login` },
      { type: 'READ_PAGE', maxChars: 100 }
    ])
    const task = await granted(running, [
      { type: 'NAVIGATE', url: `${shop()}/login` },
      { type: 'TYPE', target: { label: 'Order search' }, text: 'order 42' },
      { type: 'SUBMIT', target: { role: 'button', name: 'Find' }, kind: 'search' }
    ])
    expect(task.status, explain(task)).toBe('FAILED')
    expect(task.results[2]?.error?.code).toBe('PERMISSION_REQUIRED')
    const { requests } = await call(running, 'permissions.requests', {
      status: 'PENDING',
      limit: 50
    })
    expect(
      requests.some(
        (request) => request.capability === 'browser.submit_login' && request.risk === 'MEDIUM'
      )
    ).toBe(true)
    expect(fixtures.requests.some((request) => request.path === '/orders')).toBe(false)
  })

  it('refuses a credential typed into a page, and a coordinate click unless allowed (then labels it)', async () => {
    const running = await start()
    const secret = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-')
    const typed = await run(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'TYPE', target: { role: 'searchbox' }, text: secret }
    ])
    expect(typed.error?.code).toBe('SECRET_IN_INPUT')
    expect(JSON.stringify(typed)).not.toContain(secret)
    const refused = await run(running, [
      { type: 'NAVIGATE', url: `${shop()}/` },
      { type: 'CLICK_POINT', x: 10, y: 10, reason: 'test' }
    ])
    expect(refused.error?.code).toBe('COORDINATE_FALLBACK_DISABLED')
    const point = await granted(
      running,
      [
        { type: 'NAVIGATE', url: `${shop()}/` },
        { type: 'CLICK_POINT', x: 10, y: 10, reason: 'no control for this spot' }
      ],
      { allow: true }
    )
    expect(point.status, explain(point)).toBe('SUCCEEDED')
    expect(point.results[1]).toMatchObject({ method: 'coordinate', success: true })
    expect(point.results[1]?.observation).toContain('Coordinate fallback')
    const { entries } = await call(running, 'permissions.audit', { limit: 200 })
    expect(
      entries.some(
        (entry) => entry.capability === 'browser.click_point' && entry.outcome === 'ALLOWED'
      )
    ).toBe(true)
  })
})
