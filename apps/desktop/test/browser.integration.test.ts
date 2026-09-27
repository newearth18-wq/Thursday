import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserAction, PlanDraft } from '@jupiter/contracts'
import { uuidv7 } from '@jupiter/core'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import {
  startWebFixtures,
  testBrowserExecutable,
  type WebFixtures
} from '@jupiter/testing/web-fixtures'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, query, waitForGateway } from './helpers'

/**
 * SET 9 in the real application: the Browser Agent drives a real browser
 * (in its own runtime process) on real test websites, a person answers its
 * permission requests in the real dialog, and Diagnostics shows what each
 * action observed — page content marked untrusted, text that tried to direct
 * the agent labelled, a stop for an unexpected site. Screenshots go to
 * test-results/set-09/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-09')

let fixtures: WebFixtures
let model: ProtocolServer
let userDataDir: string
let browserFolder: string
let jupiter: LaunchedJupiter
let page: Page

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  fixtures = await startWebFixtures()
  model = await startOpenAiCompatibleServer()
  model.setModels([{ id: 'planner-model', name: 'Planner Model' }])
  userDataDir = await createTempDir('jupiter-set09')
  browserFolder = await createTempDir('jupiter-set09-browser')
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: {
      JUPITER_TEST_BROWSER_EXECUTABLE: testBrowserExecutable(),
      JUPITER_TEST_BROWSER_FOLDER: browserFolder
    }
  })
  page = jupiter.window
  await jupiter.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 1100)
  })
  await waitForGateway(
    page,
    (status) => status.core.state === 'running' && status.runtime.overall !== 'STARTING',
    60_000
  )
  const provider = await query(page, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: 'Local server',
    baseUrl: model.baseUrl
  })
  await query(page, 'ai.providers.check', { providerId: provider.providerId })
  await query(page, 'ai.models.update', {
    providerId: provider.providerId,
    modelId: 'planner-model',
    enabled: true,
    capabilities: ['chat']
  })
}, 120_000)

afterAll(async () => {
  await jupiter.close()
  await model.close()
  await fixtures.close()
  await removeDir(userDataDir)
  await removeDir(browserFolder)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function openBrowserCard(): Promise<void> {
  await page.getByTestId('nav-diagnostics').click()
  await page.getByTestId('diag-browser').waitFor()
  await page.getByTestId('diag-browser').evaluate((element) => {
    element.scrollIntoView({ block: 'start' })
  })
}

/** Answers every permission request the dialog shows, as the person would (Allow once). */
async function answerDialog(first?: string): Promise<number> {
  const prompt = page.getByTestId('permission-dialog')
  let answered = 0
  for (; answered < 10; answered++) {
    const shown = await prompt
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (!shown) break
    if (answered === 0 && first) await evidence(first)
    const id = await prompt.getByTestId('permission-facts').getAttribute('data-request-id')
    await prompt.getByTestId('permission-allow-once').click()
    // Read without waiting: the dialog may close between two looks.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector('[data-testid="permission-dialog"] [data-testid="permission-facts"]')
              ?.getAttribute('data-request-id') ?? 'closed'
        )
      )
      .not.toBe(id)
  }
  return answered
}

describe('SET 9 — Browser Agent, in the real application', () => {
  it('shows the Browser Agent as available, with the browser it drives', async () => {
    const status = await query(page, 'browser.status', {})
    expect(status).toMatchObject({
      available: true,
      browser: 'Chromium (test)',
      persistentProfile: false
    })
    await openBrowserCard()
    const availability = page.getByTestId('browser-availability')
    expect(await availability.getAttribute('data-available')).toBe('true')
    expect(await page.getByTestId('browser-name').textContent()).toContain('Chromium (test)')
    expect(await page.getByTestId('browser-profile').textContent()).toContain('Temporary')
    await evidence('01-browser-agent-available')
  })

  it('a Mission reads a hostile page: permissions asked first, page text kept as labelled untrusted data, nothing it says is followed', async () => {
    const plan: PlanDraft = {
      goal: 'Summarise the article',
      assumptions: [],
      rationale: 'Read the page with the Browser Agent, then ask the model.',
      steps: [
        {
          id: 'read',
          title: 'Read the article',
          description: 'Browser Agent',
          skillId: 'browser.read_page',
          dependencies: [],
          input: { url: `${fixtures.shop}/injection` },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'sum',
          title: 'Summarise it',
          description: 'Model',
          skillId: 'model.generate',
          dependencies: ['read'],
          input: { prompt: 'Summarise this page in one sentence:\n{{read}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        }
      ],
      requiredSkills: ['browser.read_page', 'model.generate'],
      requiredPermissions: ['browser.navigate', 'browser.read'],
      expectedArtifacts: [{ step: 'sum', description: 'A one-sentence summary' }],
      verificationPlan: {
        checks: [{ step: 'sum', check: 'non-empty', description: 'Summarised' }]
      }
    }
    model.enqueue({ chunks: [JSON.stringify(plan)] })
    model.enqueue({ chunks: ['A storm larger than Earth rages on Jupiter.'] })
    const otherBefore = fixtures.requests.filter((request) => request.origin === 'other').length
    const grantsBefore = new Set(
      (await query(page, 'permissions.grants', { includeEnded: true, limit: 200 })).grants.map(
        (grant) => grant.grantId
      )
    )

    await page.getByTestId('nav-missions').click()
    await page.getByTestId('mission-new').click()
    const dialog = page.getByTestId('mission-new-dialog')
    await dialog.getByTestId('mission-new-request').fill('Summarise the article about Jupiter')
    const create = dialog.getByTestId('mission-new-create')
    await expect.poll(() => create.isEnabled()).toBe(true)
    await create.click()

    // The two permissions the step needs (open the page, read it), for the exact origin.
    expect(await answerDialog('02-permission-request')).toBe(2)
    const detail = page.getByTestId('mission-detail')
    await expect
      .poll(() => detail.getAttribute('data-status'), { timeout: 120_000 })
      .toBe('COMPLETED')
    await evidence('03-mission-completed')
    expect(await detail.getByTestId('mission-agents').textContent()).toBe('Browser Agent')
    const asked = detail.getByTestId('mission-permissions').locator('[data-decision]')
    expect(await asked.count()).toBe(2)
    for (const decision of await asked.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-decision'))
    ))
      expect(decision).toBe('granted')

    // The model got the page only as fenced, labelled, untrusted data.
    const prompt = JSON.stringify(
      model.requests.filter((request) => request.method === 'POST').at(-1)?.body
    )
    expect(prompt).toContain('BEGIN UNTRUSTED PAGE TEXT')
    expect(prompt).toContain('the page tried to direct the agent')
    // Nothing the page asked for happened: no request to the other site, no new permission.
    expect(fixtures.requests.filter((request) => request.origin === 'other').length).toBe(
      otherBefore
    )
    const grants = (
      await query(page, 'permissions.grants', { includeEnded: true, limit: 200 })
    ).grants.filter((grant) => !grantsBefore.has(grant.grantId))
    expect(grants.map((grant) => grant.capability).sort()).toEqual([
      'browser.navigate',
      'browser.read'
    ])

    await openBrowserCard()
    const task = page.getByTestId('browser-task').first()
    await expect.poll(() => task.getAttribute('data-status')).toBe('SUCCEEDED')
    await expect
      .poll(() => task.locator('[data-action="READ_PAGE"]').getAttribute('data-suspicious'))
      .toBe('6')
    expect(await task.getByTestId('browser-untrusted').count()).toBeGreaterThan(0)
    expect(await task.getByTestId('browser-suspicious').textContent()).toContain(
      'Tried to override instructions'
    )
    await task.evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
    await evidence('04-untrusted-content-labelled')
  })

  it('an unexpected cross-origin navigation stops the task, and the interface says so', async () => {
    const actions: BrowserAction[] = [
      { type: 'NAVIGATE', url: `${fixtures.shop}/` },
      { type: 'CLICK', target: { role: 'link', name: 'Partner offers' } },
      { type: 'READ_PAGE', maxChars: 1000 }
    ]
    const request = (taskId: string) =>
      query(page, 'browser.run', {
        taskId,
        title: 'Look at the partner offers',
        sessionId: null,
        actions,
        extraOrigins: [],
        allowCoordinateFallback: false
      })
    const first = await request(uuidv7())
    expect(first.status).toBe('WAITING_APPROVAL')
    await answerDialog()
    const task = await request(uuidv7())
    expect(task.status).toBe('SAFETY_STOP')
    expect(task.error?.code).toBe('UNEXPECTED_ORIGIN')
    expect(task.results.map((result) => result.action)).toEqual(['NAVIGATE', 'CLICK'])
    await openBrowserCard()
    const shown = page.getByTestId('browser-task').first()
    await expect.poll(() => shown.getAttribute('data-status')).toBe('SAFETY_STOP')
    expect(await shown.textContent()).toContain('Stopped for safety')
    await shown.evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
    await evidence('05-safety-stop')
  })

  it('the persistent profile is off by default and is turned on only by the person', async () => {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('tab-permissions').click()
    const toggle = page.getByTestId('setting-browser-profile')
    await toggle.waitFor()
    expect(await toggle.isChecked()).toBe(false)
    await evidence('06-browser-profile-setting')
    await toggle.click()
    await expect
      .poll(() => page.getByTestId('browser-profile-save-status').textContent())
      .toContain('Saved')
    expect((await query(page, 'browser.status', {})).persistentProfile).toBe(true)
    await toggle.click()
    await expect
      .poll(async () => (await query(page, 'browser.status', {})).persistentProfile)
      .toBe(false)
  })
})
