import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { uuidv7 } from '@jupiter/core'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import type { Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, packageJson, query, waitForGateway } from './helpers'

/**
 * SET 6 acceptance tests against the real application: the Skill Registry
 * in Jupiter Core's utility process, Skills running in worker threads, and
 * the Skill Center a person uses. The test environment also registers two
 * test-fixture Skills with known faults (JUPITER_TEST_SKILL_FIXTURES=1),
 * labelled as such. Screenshots go to test-results/set-06/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-06')

let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  userDataDir = await createTempDir('jupiter-set06')
  jupiter = await launch()
  page = jupiter.window
})

afterAll(async () => {
  await jupiter.close()
  await removeDir(userDataDir)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function launch(): Promise<LaunchedJupiter> {
  const launched = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_SKILL_FIXTURES: '1' }
  })
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 1100)
  })
  await waitForGateway(
    launched.window,
    (status) =>
      status.core.state === 'running' &&
      status.runtime.overall !== 'STARTING' &&
      status.runtime.services.some(
        (service) => service.serviceId === 'skill-registry' && service.status === 'HEALTHY'
      )
  )
  return launched
}

async function evidence(name: string, section?: Locator): Promise<void> {
  if (section)
    await section.evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function openSkills(): Promise<void> {
  await page.getByTestId('nav-skills').click()
  await page.getByTestId('skills').waitFor()
}

async function openSkill(skillId: string): Promise<Locator> {
  await openSkills()
  await page.locator(`[data-testid="skill-item"][data-skill-id="${skillId}"]`).click()
  const detail = page.locator(`[data-testid="skill-detail"][data-skill-id="${skillId}"]`)
  await detail.waitFor()
  return detail
}

function listed(): Promise<[string | null, string | null][]> {
  return page
    .getByTestId('skill-item')
    .evaluateAll((items) =>
      items.map((item) => [item.getAttribute('data-skill-id'), item.getAttribute('data-health')])
    )
}

describe('SET 6 — Skill System, in the real application', () => {
  it('AT10: the Skill Center shows each Skill and its health exactly as Core reports it', async () => {
    await openSkills()
    // No "Coming later" label: the Skill Center is built.
    expect(await page.getByTestId('feature-view').count()).toBe(0)
    const { skills } = await query(page, 'skills.list', { filter: {} })
    await expect
      .poll(listed)
      .toEqual(skills.map((skill) => [skill.definition.skillId, skill.health.status]))
    expect(Object.fromEntries(await listed())).toEqual({
      echo_text: 'HEALTHY',
      fixture_broken_health: 'UNHEALTHY',
      fixture_slow: 'HEALTHY',
      get_app_version: 'HEALTHY',
      get_system_time: 'HEALTHY',
      list_available_skills: 'HEALTHY'
    })
    await evidence('01-skill-center', page.getByTestId('skills'))

    // The unhealthy fixture: its reason, when it was checked, and that it cannot run.
    const broken = await openSkill('fixture_broken_health')
    const stored = skills.find((skill) => skill.definition.skillId === 'fixture_broken_health')
    expect(await broken.getByTestId('skill-health').textContent()).toBe('Unhealthy')
    expect(await broken.getByTestId('skill-health-detail').textContent()).toBe(
      stored?.health.detail
    )
    expect(await broken.getByTestId('skill-health-detail').textContent()).toContain(
      'FIXTURE_BROKEN'
    )
    expect(await broken.getByTestId('skill-blocked').textContent()).toContain(
      'Its last health check failed.'
    )
    expect(await broken.getByTestId('skill-not-testable').count()).toBe(1)
    await evidence('02-unhealthy-skill', broken)

    // "Check health now" runs a real check: the time shown is the time Core recorded.
    const before = await broken.getByTestId('skill-last-check').textContent()
    await broken.getByTestId('skill-health-check').click()
    await expect.poll(() => broken.getByTestId('skill-last-check').textContent()).not.toBe(before)
    const checked = await query(page, 'skills.get', { skillId: 'fixture_broken_health' })
    expect(checked.health.status).toBe('UNHEALTHY')
    expect(Date.parse(checked.health.checkedAt ?? '')).toBeGreaterThan(
      Date.parse(stored?.health.checkedAt ?? '')
    )
  })

  it('shows provider, category, permissions, version, runtime and versions', async () => {
    const detail = await openSkill('get_app_version')
    expect(await detail.getByTestId('skill-name').textContent()).toBe('Get app version')
    expect(await detail.getByTestId('skill-runtime').textContent()).toBe(
      'Compatible: needs sandbox@1, this build has sandbox@1'
    )
    expect(await detail.locator('[data-permission="app.version.read"]').textContent()).toContain(
      'granted to its runs'
    )
    expect(await detail.getByTestId('skill-versions').textContent()).toBe('1.0.0')
    // Its test run is real: the version is this build's.
    await detail.getByTestId('skill-run').click()
    const result = detail.getByTestId('skill-result')
    await expect.poll(() => result.getAttribute('data-status')).toBe('SUCCESS')
    expect(await detail.getByTestId('skill-output').textContent()).toContain(
      `"version": "${packageJson.version}"`
    )
  })

  it('AT3: echo_text returns exactly the text typed, and the run appears in the history', async () => {
    const detail = await openSkill('echo_text')
    const text = 'Hello, Jupiter — สวัสดี 🪐'
    await detail.getByTestId('skill-input-text').fill(text)
    await detail.getByTestId('skill-run').click()
    const result = detail.getByTestId('skill-result')
    await expect.poll(() => result.getAttribute('data-status')).toBe('SUCCESS')
    const output = JSON.parse((await detail.getByTestId('skill-output').textContent()) ?? '') as {
      text: string
    }
    expect(output).toEqual({ text })
    await expect.poll(() => detail.getByTestId('skill-execution').count()).toBeGreaterThan(0)
    const row = detail.getByTestId('skill-execution').first()
    expect(await row.getAttribute('data-status')).toBe('SUCCESS')
    // History shows the shape, never the text.
    expect(await detail.getByTestId('skill-history').textContent()).not.toContain('Hello, Jupiter')
    await evidence('03-echo-text', detail.getByTestId('skill-test-form'))
  })

  it('AT6: a disabled Skill cannot run', async () => {
    const detail = await openSkill('echo_text')
    await detail.getByTestId('skill-enabled').uncheck()
    await expect.poll(() => detail.getAttribute('data-enabled')).toBe('false')
    expect(await detail.getByTestId('skill-blocked').textContent()).toContain('Disabled.')
    await detail.getByTestId('skill-input-text').fill('should not run')
    await detail.getByTestId('skill-run').click()
    const result = detail.getByTestId('skill-result')
    await expect.poll(() => result.getAttribute('data-status')).toBe('FAILED')
    expect(await detail.getByTestId('skill-result-error').textContent()).toContain('SKILL_DISABLED')
    await evidence('04-disabled-skill', detail)
    await detail.getByTestId('skill-enabled').check()
    await expect.poll(() => detail.getAttribute('data-enabled')).toBe('true')
  })

  it('AT4 + AT5: timeout and cancel end the Skill in Core, and Core keeps answering', async () => {
    const timedOut = await query(page, 'skills.invoke', {
      executionId: uuidv7(),
      skillId: 'fixture_slow',
      input: {},
      timeoutMs: 800
    })
    expect(timedOut).toMatchObject({ status: 'TIMEOUT', error: { code: 'SKILL_TIMEOUT' } })

    const executionId = uuidv7()
    const pending = query(page, 'skills.invoke', {
      executionId,
      skillId: 'fixture_slow',
      input: {}
    })
    await expect
      .poll(async () => {
        const { executions } = await query(page, 'skills.executions', {
          skillId: 'fixture_slow',
          limit: 5
        })
        return executions.find((item) => item.executionId === executionId)?.status ?? null
      })
      .toBe('RUNNING')
    expect(await query(page, 'skills.cancel', { executionId })).toEqual({ cancelled: true })
    expect(await pending).toMatchObject({ status: 'CANCELLED' })
    expect(
      await query(page, 'skills.invoke', {
        executionId: uuidv7(),
        skillId: 'echo_text',
        input: { text: 'alive' }
      })
    ).toMatchObject({ status: 'SUCCESS', output: { text: 'alive' } })

    const detail = await openSkill('fixture_slow')
    await expect
      .poll(() =>
        detail
          .getByTestId('skill-execution')
          .evaluateAll((rows) => rows.slice(0, 2).map((row) => row.getAttribute('data-status')))
      )
      .toEqual(['CANCELLED', 'TIMEOUT'])
    await evidence('05-timeout-and-cancel', detail.getByTestId('skill-history'))
  })

  it('searches and filters the list', async () => {
    await openSkills()
    await page.getByTestId('skills-search').fill('system time')
    await expect.poll(async () => (await listed()).map(([id]) => id)).toEqual(['get_system_time'])
    await page.getByTestId('skills-search').fill('')
    await page.getByTestId('skills-filter-health').selectOption('UNHEALTHY')
    await expect
      .poll(async () => (await listed()).map(([id]) => id))
      .toEqual(['fixture_broken_health'])
    await page.getByTestId('skills-filter-health').selectOption('any')
    await page.getByTestId('skills-filter-provider').selectOption('internal')
    await expect.poll(async () => (await listed()).length).toBe(4)
    await page.getByTestId('skills-filter-provider').selectOption('any')
  })

  it('keeps enabled state and health across an app restart', async () => {
    await query(page, 'skills.disable', { skillId: 'get_system_time' })
    await jupiter.close()
    jupiter = await launch()
    page = jupiter.window
    const info = await query(page, 'skills.get', { skillId: 'get_system_time' })
    expect(info.enabled).toBe(false)
    const detail = await openSkill('get_system_time')
    expect(await detail.getAttribute('data-enabled')).toBe('false')
    await query(page, 'skills.enable', { skillId: 'get_system_time' })
  })
})
