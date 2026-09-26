import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import type { Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, envelope, invoke, query, waitForGateway } from './helpers'

/**
 * SET 4 acceptance tests against the real application: real Electron and
 * renderer, Jupiter Core in its utility process with SQLite, and a real HTTP
 * server speaking the OpenAI-compatible protocol as the model. Missions are
 * created and driven through the interface a person uses. Screenshots are
 * written to test-results/set-04/ as evidence.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-04')

let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page
let model: ProtocolServer

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  model = await startOpenAiCompatibleServer()
  model.setModels([{ id: 'mission-model', name: 'Mission Model' }])
  userDataDir = await createTempDir('jupiter-set04')
  jupiter = await launch()
  page = jupiter.window
  // A local model, set up as in AI Models (SET 3 covers doing this through the interface).
  const provider = await query(page, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: 'Local server',
    baseUrl: model.baseUrl
  })
  await query(page, 'ai.providers.check', { providerId: provider.providerId })
  await query(page, 'ai.models.update', {
    providerId: provider.providerId,
    modelId: 'mission-model',
    enabled: true,
    capabilities: ['chat']
  })
})

afterAll(async () => {
  await jupiter.close()
  await model.close()
  await removeDir(userDataDir)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function launch(): Promise<LaunchedJupiter> {
  const launched = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000)
  })
  await waitForGateway(
    launched.window,
    (status) => status.core.state === 'running' && status.runtime.overall !== 'STARTING'
  )
  return launched
}

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function open(view: string): Promise<void> {
  await page.getByTestId(`nav-${view}`).click()
  await page.getByTestId(`view-${view}`).waitFor()
}

/** Start a Mission through the New Mission dialog; returns its id. */
async function createMission(requestText: string, title?: string): Promise<string> {
  await open('missions')
  await page.getByTestId('mission-new').click()
  const dialog = page.getByTestId('mission-new-dialog')
  await dialog.getByTestId('mission-new-request').fill(requestText)
  if (title) await dialog.getByTestId('mission-new-title').fill(title)
  const create = dialog.getByTestId('mission-new-create')
  await expect.poll(() => create.isEnabled()).toBe(true)
  await create.click()
  await expect.poll(() => dialog.isVisible()).toBe(false)
  const detail = page.getByTestId('mission-detail')
  await detail.waitFor()
  return (await detail.getAttribute('data-mission-id')) ?? ''
}

function detail(): Locator {
  return page.getByTestId('mission-detail')
}

async function statusOf(): Promise<string | null> {
  return detail().getAttribute('data-status')
}

function stepStatuses(): Promise<(string | null)[]> {
  return detail()
    .getByTestId('mission-step')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-status')))
}

function chatRequests() {
  return model.requests.filter((request) => request.method === 'POST')
}

describe('SET 4 — Mission System, in the real application', () => {
  it('AT1 + AT3 + AT8: creates a Mission that runs to COMPLETED with a successful verification', async () => {
    model.reset()
    model.enqueue({ chunks: ['Rain taps the window.'] }, { chunks: ['A rainy haiku.'] })
    const missionId = await createMission('Write a haiku about rain', 'Rain haiku')
    expect(missionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(page.url()).toContain(`#/missions/${missionId}`)
    await expect.poll(statusOf).toBe('COMPLETED')

    expect(await detail().getByTestId('mission-title').textContent()).toBe('Rain haiku')
    expect(await detail().getByTestId('mission-request').textContent()).toBe(
      'Write a haiku about rain'
    )
    expect(await stepStatuses()).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'])
    expect(await detail().getByTestId('mission-artifact').first().textContent()).toContain(
      'Rain taps the window.'
    )
    const checks = detail().getByTestId('mission-verification').locator('li')
    expect(
      await checks.evaluateAll((items) => items.map((i) => i.getAttribute('data-passed')))
    ).toEqual(['true', 'true'])
    expect(await detail().getByTestId('mission-model').textContent()).toContain('Mission Model')
    // AT3: the stored transitions are exactly the valid path.
    const stored = await query(page, 'missions.get', { missionId })
    expect(stored.transitions.map((item) => `${item.from}>${item.to}`)).toEqual([
      'CREATED>ANALYZING',
      'ANALYZING>PLANNING',
      'PLANNING>READY',
      'READY>RUNNING',
      'RUNNING>VERIFYING',
      'VERIFYING>COMPLETED'
    ])
    // A human-readable timeline, no developer log by default (newest first, expandable).
    await expect
      .poll(() => detail().getByTestId('mission-timeline').textContent())
      .toContain('Completed')
    const more = detail().getByTestId('mission-timeline').getByRole('button', { name: /Show/ })
    if (await more.count()) await more.first().click()
    // What is visible (technical details stay collapsed until asked for).
    const timeline = await detail().getByTestId('mission-timeline').innerText()
    expect(timeline).toContain('Mission created: Rain haiku')
    expect(timeline).toContain('Started: Answer the request')
    expect(timeline).toContain('Check passed: an answer was produced')
    expect(timeline).toContain('Completed')
    expect(timeline).not.toContain('mission.status_changed')
    await evidence('01-mission-completed')
  })

  it('AT5: Pause waits for the safe boundary between steps; Resume continues from there', async () => {
    model.reset()
    model.enqueue({ chunks: ['Slow ', 'answer.'], gated: true })
    await createMission('Take your time with this one')
    await expect.poll(() => chatRequests().length).toBe(1)
    await expect.poll(statusOf).toBe('RUNNING')

    // Home shows the running Mission with its real progress.
    await open('home')
    const card = page.getByTestId('mission-card')
    await expect.poll(() => card.getAttribute('data-state')).toBe('active')
    expect(await card.getByTestId('mission-progress').getAttribute('data-measurable')).toBe('true')
    // The stage says Jupiter is working only because a Mission really is running.
    expect(await page.getByTestId('stage').getAttribute('data-state')).toBe('working')
    expect(await page.getByTestId('stage-detail').textContent()).toContain(
      'Take your time with this one'
    )
    await evidence('02-home-running-mission')
    await card.getByRole('button', { name: 'Details' }).click()
    await detail().waitFor()

    await detail().getByTestId('mission-pause').click()
    await detail().getByTestId('mission-pausing').waitFor()
    expect(await statusOf()).toBe('RUNNING')
    model.advance()
    model.advance()
    await expect.poll(statusOf).toBe('PAUSED')
    expect(await stepStatuses()).toEqual(['SUCCEEDED', 'PENDING', 'PENDING'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chatRequests()).toHaveLength(1)
    await evidence('03-mission-paused')

    await detail().getByTestId('mission-resume').click()
    await expect.poll(statusOf).toBe('COMPLETED')
    expect(chatRequests()).toHaveLength(2)
  })

  it('AT6: Cancel stops the active step and its provider request', async () => {
    model.reset()
    model.enqueue({ chunks: ['Never ', 'finished'], gated: true })
    await createMission('Something to cancel')
    await expect.poll(() => chatRequests().length).toBe(1)
    model.advance()
    await detail().getByTestId('mission-cancel').click()
    await page.getByTestId('mission-cancel-dialog').getByTestId('confirm-ok').click()
    await expect.poll(statusOf).toBe('CANCELLED')
    expect(await stepStatuses()).toEqual(['CANCELLED', 'SKIPPED', 'SKIPPED'])
    await expect.poll(() => chatRequests()[0]?.abortedAt ?? null).not.toBeNull()
    await evidence('04-mission-cancelled')
  })

  it('AT9: partial success names what was completed and what was not', async () => {
    model.reset()
    model.enqueue({ chunks: ['The main answer.'] }, { status: 503, errorMessage: 'overloaded' })
    await createMission('Answer, then summarise')
    await expect.poll(statusOf).toBe('PARTIAL_SUCCESS')
    const partial = detail().getByTestId('mission-partial')
    expect(await partial.textContent()).toContain('Completed: Answer the request, Check the answer')
    expect(await partial.getByTestId('mission-partial-missing').textContent()).toBe(
      'Not completed: Write a one-line summary (Failed)'
    )
    await evidence('05-mission-partial')
  })

  it('AT7: Retry after a failure creates a linked new attempt and keeps the failed one', async () => {
    model.reset()
    model.enqueue({ status: 503, errorMessage: 'down for maintenance' })
    const missionId = await createMission('Try until it works')
    await expect.poll(statusOf).toBe('FAILED')
    expect(await stepStatuses()).toEqual(['FAILED', 'SKIPPED', 'SKIPPED'])

    model.enqueue({ chunks: ['Works now.'] }, { chunks: ['Fine.'] })
    await detail().getByTestId('mission-retry').click()
    await expect.poll(statusOf).toBe('COMPLETED')
    const history = detail().getByTestId('mission-execution')
    expect(
      await history.evaluateAll((rows) =>
        rows.map((row) => [row.getAttribute('data-attempt'), row.getAttribute('data-status')])
      )
    ).toEqual([
      ['2', 'COMPLETED'],
      ['1', 'FAILED']
    ])
    const stored = await query(page, 'missions.get', { missionId })
    const [first, second] = stored.executionHistory
    expect(second?.retryOf).toBe(first?.executionId)
    expect(first?.steps.map((step) => step.status)).toEqual(['FAILED', 'SKIPPED', 'SKIPPED'])
    await evidence('06-mission-retried')
  })

  it('AT4: an invalid transition is rejected, recorded, shown and audited', async () => {
    const { missions } = await query(page, 'missions.list', { includeArchived: false, limit: 50 })
    const completed = missions.find((mission) => mission.status === 'COMPLETED')
    if (!completed) throw new Error('no completed Mission')
    const result = await invoke(
      page,
      envelope('missions.resume', { missionId: completed.missionId })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_MISSION_TRANSITION')
    const stored = await query(page, 'missions.get', { missionId: completed.missionId })
    expect(stored.mission.status).toBe('COMPLETED')
    expect(stored.transitions.filter((item) => !item.accepted)).toEqual([
      expect.objectContaining({ from: 'COMPLETED', to: 'RUNNING', actor: 'user-interface' })
    ])
    const { entries } = await query(page, 'audit.list', { limit: 100 })
    expect(
      entries.find(
        (entry) =>
          entry.capability === 'missions.resume' &&
          entry.target === `mission:${completed.missionId}`
      )
    ).toMatchObject({
      outcome: 'FAILED',
      metadataRedacted: { errorCode: 'INVALID_MISSION_TRANSITION' }
    })
    // The interface only offers what the state allows, and shows the refusal in the timeline.
    await open('missions')
    await page
      .locator(`[data-testid="mission-item"][data-mission-id="${completed.missionId}"]`)
      .click()
    await expect.poll(statusOf).toBe('COMPLETED')
    expect(
      await detail().getByTestId('mission-actions').locator('button').allTextContents()
    ).toEqual(['Retry', 'Archive'])
    await expect
      .poll(() => detail().getByTestId('mission-timeline').textContent())
      .toContain('Refused: Completed cannot change to Running')
  })

  it('AT2 + AT10: Missions and their timeline are the same after a restart', async () => {
    const before = await query(page, 'missions.list', { includeArchived: true, limit: 50 })
    expect(before.missions.length).toBeGreaterThanOrEqual(5)
    const target = before.missions[0]
    if (!target) throw new Error('no Mission')
    await open('missions')
    await page
      .locator(`[data-testid="mission-item"][data-mission-id="${target.missionId}"]`)
      .click()
    await detail().waitFor()
    // Expand the whole timeline and keep what it says.
    const showAll = detail().getByTestId('mission-timeline').getByRole('button', { name: /Show/ })
    if (await showAll.count()) await showAll.first().click()
    const timelineBefore = await detail()
      .getByTestId('mission-timeline')
      .locator('li')
      .allTextContents()
    const eventsBefore = await query(page, 'missions.timeline', { missionId: target.missionId })

    await jupiter.close()
    jupiter = await launch()
    page = jupiter.window

    const after = await query(page, 'missions.list', { includeArchived: true, limit: 50 })
    expect(after.missions).toEqual(before.missions)
    const eventsAfter = await query(page, 'missions.timeline', { missionId: target.missionId })
    expect(eventsAfter.events).toEqual(eventsBefore.events)
    await open('missions')
    await page
      .locator(`[data-testid="mission-item"][data-mission-id="${target.missionId}"]`)
      .click()
    await detail().waitFor()
    const showAllAgain = detail()
      .getByTestId('mission-timeline')
      .getByRole('button', { name: /Show/ })
    if (await showAllAgain.count()) await showAllAgain.first().click()
    await expect
      .poll(() => detail().getByTestId('mission-timeline').locator('li').allTextContents())
      .toEqual(timelineBefore)
    await evidence('07-mission-after-restart')
  })

  it('archives a finished Mission and hides it from the default list', async () => {
    const { missions } = await query(page, 'missions.list', { includeArchived: false, limit: 50 })
    const finished = missions.find((mission) => mission.status === 'CANCELLED')
    if (!finished) throw new Error('no cancelled Mission')
    await open('missions')
    await page
      .locator(`[data-testid="mission-item"][data-mission-id="${finished.missionId}"]`)
      .click()
    await detail().getByTestId('mission-archive').click()
    await expect
      .poll(() =>
        page
          .locator(`[data-testid="mission-item"][data-mission-id="${finished.missionId}"]`)
          .count()
      )
      .toBe(0)
    await page.getByTestId('missions-show-archived').check()
    await expect
      .poll(() =>
        page
          .locator(`[data-testid="mission-item"][data-mission-id="${finished.missionId}"]`)
          .count()
      )
      .toBe(1)
  })
})
