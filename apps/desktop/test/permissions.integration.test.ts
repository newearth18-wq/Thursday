import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { uuidv7 } from '@jupiter/core'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import type { Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, query, waitForGateway } from './helpers'

/**
 * SET 7 acceptance tests against the real application: the Permission
 * Engine in Jupiter Core's utility process, the permission request the
 * person answers, and Settings › Permissions. The test environment registers
 * the fixture Skills (JUPITER_TEST_SKILL_FIXTURES=1): one writes a note to a
 * list kept in memory (memory.write, MEDIUM), one deletes all notes at once
 * (files.delete_bulk, CRITICAL). Screenshots go to test-results/set-07/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-07')

let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  userDataDir = await createTempDir('jupiter-set07')
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
        (service) => service.serviceId === 'permission-engine' && service.status === 'HEALTHY'
      ) &&
      status.runtime.services.some(
        (service) => service.serviceId === 'skill-registry' && service.status === 'HEALTHY'
      )
  )
  return launched
}

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

/** Runs a Skill the way the interface does (through `request`), without waiting for the answer. */
function invoke(skillId: string, input: unknown) {
  return query(page, 'skills.invoke', { executionId: uuidv7(), skillId, input })
}

async function dialog(): Promise<Locator> {
  const shown = page.getByTestId('permission-dialog')
  await shown.waitFor({ state: 'visible' })
  return shown
}

async function dialogClosed(): Promise<void> {
  await page.getByTestId('permission-dialog').waitFor({ state: 'hidden' })
}

async function footerButtons(shown: Locator): Promise<string[]> {
  return shown.locator('.dialog-footer button').allTextContents()
}

async function openPermissions(): Promise<Locator> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('tab-permissions').click()
  const panel = page.getByTestId('permissions-panel')
  await panel.waitFor()
  return panel
}

describe('SET 7 — Permission Engine, in the real application', () => {
  it('AT1 + AT4: an action without permission waits for the person; Allow once allows exactly one run', async () => {
    const first = await invoke('fixture_note_writer', { text: 'hello' })
    expect(first).toMatchObject({
      status: 'WAITING_APPROVAL',
      error: { code: 'PERMISSION_REQUIRED' }
    })

    const shown = await dialog()
    expect(await shown.getAttribute('role')).toBe('alertdialog')
    expect(await shown.getByTestId('permission-capability').textContent()).toBe('memory.write')
    expect(await shown.getByTestId('permission-target').textContent()).toBe('fixture:notes')
    expect(await shown.getByTestId('permission-risk').textContent()).toBe('Medium')
    expect(await shown.getByTestId('permission-subject').textContent()).toBe(
      'Skill Note writer fixture'
    )
    expect(await shown.getByTestId('permission-consequence').textContent()).toBe(
      'A memory is added or changed.'
    )
    expect(await shown.getByTestId('permission-reversible').textContent()).toBe('Yes')
    expect(await shown.getByTestId('permission-data').textContent()).toBe(
      'Nothing leaves this computer'
    )
    expect(await footerButtons(shown)).toEqual([
      'Deny',
      'Allow once',
      'Allow until Jupiter closes',
      'Always allow'
    ])
    // Deny has the first focus; Escape does not answer.
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
    ).toBe('permission-deny')
    await page.keyboard.press('Escape')
    await expect.poll(() => shown.isVisible()).toBe(true)
    await evidence('01-permission-request')

    await shown.getByTestId('permission-allow-once').click()
    await dialogClosed()
    expect(await invoke('fixture_note_writer', { text: 'hello' })).toMatchObject({
      status: 'SUCCESS',
      output: { count: 1 }
    })
    // Used up: the next run asks again.
    expect((await invoke('fixture_note_writer', { text: 'again' })).status).toBe('WAITING_APPROVAL')
    await dialog()
  })

  it('AT3: Deny blocks the action', async () => {
    const shown = await dialog()
    await shown.getByTestId('permission-deny').click()
    await dialogClosed()
    const { requests } = await query(page, 'permissions.requests', { status: 'ALL', limit: 10 })
    expect(requests[0]).toMatchObject({ status: 'DENIED', decision: 'DENY' })
    const { grants } = await query(page, 'permissions.grants', { includeEnded: true, limit: 50 })
    expect(grants.filter((grant) => grant.capability === 'memory.write')).toHaveLength(1)
    // Only the earlier single-use grant exists, and it is used.
    expect(grants.find((grant) => grant.capability === 'memory.write')?.state).toBe('USED')
  })

  it('AT6: a critical action offers only Allow once and Deny, and asks every time', async () => {
    expect((await invoke('fixture_notes_clearer', {})).status).toBe('WAITING_APPROVAL')
    const shown = await dialog()
    expect(await shown.getByTestId('permission-risk').textContent()).toBe('Critical')
    expect(await footerButtons(shown)).toEqual(['Deny', 'Allow once'])
    expect(await shown.getByTestId('permission-always-allow').count()).toBe(0)
    expect(await shown.getByTestId('permission-critical').isVisible()).toBe(true)
    expect(await shown.getByTestId('permission-reversible').textContent()).toBe(
      'No — it cannot be undone'
    )
    await evidence('02-critical-request')
    await shown.getByTestId('permission-allow-once').click()
    await dialogClosed()
    expect(await invoke('fixture_notes_clearer', {})).toMatchObject({
      status: 'SUCCESS',
      output: { cleared: 1 }
    })
    expect((await invoke('fixture_notes_clearer', {})).status).toBe('WAITING_APPROVAL')
    await (await dialog()).getByTestId('permission-deny').click()
    await dialogClosed()
  })

  it('AT7 + AT10: a permission given always is listed, can be revoked, and the audit trail shows it all', async () => {
    expect((await invoke('fixture_note_writer', { text: 'kept' })).status).toBe('WAITING_APPROVAL')
    await (await dialog()).getByTestId('permission-always-allow').click()
    await dialogClosed()
    expect((await invoke('fixture_note_writer', { text: 'kept' })).status).toBe('SUCCESS')
    expect((await invoke('fixture_note_writer', { text: 'kept too' })).status).toBe('SUCCESS')

    const panel = await openPermissions()
    const row = panel.locator(
      '[data-testid="permission-grant"][data-capability="memory.write"][data-state="ACTIVE"]'
    )
    await row.waitFor()
    expect(await row.textContent()).toContain('Always')
    // Jupiter's default grants are listed too, as the default policy.
    const clock = panel.locator(
      '[data-testid="permission-grant"][data-capability="system.time.read"][data-subject="get_system_time"]'
    )
    expect(await clock.textContent()).toContain('Jupiter’s default')
    await evidence('03-permissions-settings')

    await row.getByTestId('permission-revoke').click()
    const confirm = page.getByTestId('permission-revoke-dialog')
    await confirm.waitFor()
    await evidence('04-revoke-confirm')
    await confirm.getByTestId('confirm-ok').click()
    await row.waitFor({ state: 'detached' })
    const { grants } = await query(page, 'permissions.grants', { includeEnded: true, limit: 50 })
    expect(
      grants.find((grant) => grant.capability === 'memory.write' && grant.kind === 'ALWAYS_ALLOW')
        ?.state
    ).toBe('REVOKED')
    expect((await invoke('fixture_note_writer', { text: 'after' })).status).toBe('WAITING_APPROVAL')
    await (await dialog()).getByTestId('permission-deny').click()
    await dialogClosed()

    // The audit trail, as shown.
    const table = panel.getByTestId('permissions-audit-table')
    await expect
      .poll(async () =>
        table
          .getByTestId('permission-audit-row')
          .evaluateAll((rows) => rows.map((item) => item.getAttribute('data-action')))
      )
      .toEqual(
        expect.arrayContaining([
          'requested',
          'decided',
          'grant-created',
          'grant-used',
          'grant-revoked',
          'evaluated'
        ])
      )
    await table.evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
    await evidence('05-audit-trail')
  })

  it('AT5: a session permission ends when the app restarts', async () => {
    expect((await invoke('fixture_note_writer', { text: 's' })).status).toBe('WAITING_APPROVAL')
    await (await dialog()).getByTestId('permission-allow-session').click()
    await dialogClosed()
    expect((await invoke('fixture_note_writer', { text: 's1' })).status).toBe('SUCCESS')
    expect((await invoke('fixture_note_writer', { text: 's2' })).status).toBe('SUCCESS')

    await jupiter.close()
    jupiter = await launch()
    page = jupiter.window

    const { grants } = await query(page, 'permissions.grants', { includeEnded: true, limit: 50 })
    expect(grants.find((grant) => grant.kind === 'ALLOW_SESSION')?.state).toBe('EXPIRED')
    expect((await invoke('fixture_note_writer', { text: 's3' })).status).toBe('WAITING_APPROVAL')
    const shown = await dialog()
    await evidence('06-asks-again-after-restart')
    await shown.getByTestId('permission-deny').click()
    await dialogClosed()

    const panel = await openPermissions()
    await panel.getByTestId('permissions-show-ended').click()
    await panel
      .locator(
        '[data-testid="permission-grant"][data-capability="memory.write"][data-state="EXPIRED"]'
      )
      .waitFor()
  })

  it('shows in the Skill Center which permissions are granted', async () => {
    await page.getByTestId('nav-skills').click()
    await page.locator('[data-testid="skill-item"][data-skill-id="get_system_time"]').click()
    const detail = page.locator('[data-testid="skill-detail"][data-skill-id="get_system_time"]')
    await detail.waitFor()
    expect(await detail.getByTestId('skill-permissions').textContent()).toContain(
      'granted to its runs'
    )
    await page.locator('[data-testid="skill-item"][data-skill-id="fixture_note_writer"]').click()
    const writer = page.locator('[data-testid="skill-detail"][data-skill-id="fixture_note_writer"]')
    await writer.waitFor()
    expect(await writer.getByTestId('skill-permissions').textContent()).toContain(
      'asks for permission when used'
    )
  })
})
