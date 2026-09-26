import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanDraft } from '@jupiter/contracts'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, gatewayStatus, query, waitForGateway } from './helpers'

/**
 * SET 8 against the real application. On Windows: the required
 * demonstration — "Open Notepad, type Hello Jupiter, save it to Desktop" —
 * as a Mission a person creates, with the permission requests answered in
 * the real dialog, the real Notepad driven by the agent runtime, and the file
 * checked on disk. (The test environment points "Desktop" at a temporary
 * folder, JUPITER_TEST_COMPUTER_FOLDER.) On other systems: the agent is
 * shown as Unavailable, with the reason, and nothing pretends to work.
 * Screenshots go to test-results/set-08/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-08')
const onWindows = process.platform === 'win32'

let userDataDir: string
let desktop: string
let jupiter: LaunchedJupiter
let page: Page
let model: ProtocolServer

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  model = await startOpenAiCompatibleServer()
  model.setModels([{ id: 'planner-model', name: 'Planner Model' }])
  userDataDir = await createTempDir('jupiter-set08')
  desktop = await createTempDir('jupiter-set08-desktop')
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_COMPUTER_FOLDER: desktop }
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
})

afterAll(async () => {
  await jupiter.close()
  await model.close()
  await removeDir(userDataDir)
  await removeDir(desktop)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function openDiagnostics(): Promise<void> {
  await page.getByTestId('nav-diagnostics').click()
  await page.getByTestId('diag-computer').waitFor()
}

const DEMO: PlanDraft = {
  goal: 'Save "Hello Jupiter" as a text file on the Desktop',
  assumptions: ['Notepad is available'],
  rationale: 'One Computer Agent step does it and checks the saved file.',
  steps: [
    {
      id: 'save',
      title: 'Write Hello Jupiter to hello-jupiter.txt',
      description: 'Open Notepad, type the text, save it, check it.',
      skillId: 'computer.notepad_write',
      dependencies: [],
      input: { text: 'Hello Jupiter', fileName: 'hello-jupiter.txt' },
      condition: null,
      timeoutMs: 180_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
      verification: null,
      required: true
    }
  ],
  requiredSkills: ['computer.notepad_write'],
  requiredPermissions: [
    'computer.open_app',
    'computer.manage_window',
    'computer.type',
    'files.write'
  ],
  expectedArtifacts: [{ step: 'save', description: 'The saved, verified file' }],
  verificationPlan: {
    checks: [{ step: 'save', check: 'non-empty', description: 'Saved and verified' }]
  }
}

describe('SET 8 — Windows Computer Agent, in the real application', () => {
  it.runIf(!onWindows)(
    'is shown as Unavailable, with the reason, where Windows is not available',
    async () => {
      const status = await query(page, 'computer.status', {})
      expect(status).toMatchObject({ available: false, runtime: { state: 'unavailable' } })
      expect(status.reason).toContain('needs Windows')
      const gateway = await gatewayStatus(page)
      expect(
        gateway.runtime.services.find((service) => service.serviceId === 'agent-runtime')
      ).toMatchObject({
        status: 'UNAVAILABLE',
        plannedSet: 8
      })
      await openDiagnostics()
      const availability = page.getByTestId('computer-availability')
      expect(await availability.getAttribute('data-available')).toBe('false')
      expect(await availability.textContent()).toContain('Unavailable')
      await page.getByTestId('diag-computer').evaluate((element) => {
        element.scrollIntoView({ block: 'start' })
      })
      await evidence('01-unavailable-here')
      // The Notepad step is not offered as runnable.
      const { stepTypes } = await query(page, 'missions.step-types', {})
      expect(stepTypes.find((type) => type.skillId === 'computer.notepad_write')).toMatchObject({
        available: false
      })
    }
  )

  it.runIf(onWindows)(
    'the required demonstration: permission, real Notepad, exact text, semantic save to the approved path, verified file',
    async () => {
      const gateway = await gatewayStatus(page)
      expect(
        gateway.runtime.services.find((service) => service.serviceId === 'agent-runtime')?.status
      ).toBe('HEALTHY')
      const status = await query(page, 'computer.status', {})
      expect(status).toMatchObject({ available: true, saveFolder: desktop })

      model.enqueue({ chunks: [JSON.stringify(DEMO)] })
      await page.getByTestId('nav-missions').click()
      await page.getByTestId('mission-new').click()
      const dialog = page.getByTestId('mission-new-dialog')
      await dialog
        .getByTestId('mission-new-request')
        .fill('Open Notepad, type Hello Jupiter, save it to Desktop')
      const create = dialog.getByTestId('mission-new-create')
      await expect.poll(() => create.isEnabled()).toBe(true)
      await create.click()

      // 1. Permission: each request names the exact target; the person allows it once.
      const path = join(desktop, 'hello-jupiter.txt')
      let first = true
      for (let answered = 0; answered < 8; answered++) {
        const prompt = page.getByTestId('permission-dialog')
        const shown = await prompt
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => true)
          .catch(() => false)
        if (!shown) break
        const capability = await prompt.getByTestId('permission-capability').textContent()
        if (capability === 'files.write')
          expect(await prompt.getByTestId('permission-target').textContent()).toBe(path)
        if (first) {
          await evidence('02-permission-request')
          first = false
        }
        await prompt.getByTestId('permission-allow-once').click()
        await prompt.waitFor({ state: 'hidden' })
      }

      // 2–8. The Mission completes only when the file on disk is verified.
      const detail = page.getByTestId('mission-detail')
      await expect
        .poll(() => detail.getAttribute('data-status'), { timeout: 120_000 })
        .toBe('COMPLETED')
      await evidence('03-mission-completed')
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')).toBe('Hello Jupiter')

      const { tasks } = await query(page, 'computer.tasks', { limit: 5 })
      const done = tasks.find((task) => task.status === 'SUCCEEDED')
      expect(done?.results.map((result) => [result.action, result.success, result.method])).toEqual(
        [
          ['OPEN_APP', true, 'system'],
          ['TYPE_TEXT', true, done?.results[1]?.method],
          ['SAVE_FILE', true, 'semantic'],
          ['CLOSE_APP', true, 'semantic']
        ]
      )
      expect(done?.results[1]?.method).not.toBe('coordinate')
      expect(done?.results[2]?.evidence).toMatchObject({ kind: 'file', path })

      await openDiagnostics()
      await page.getByTestId('diag-computer').evaluate((element) => {
        element.scrollIntoView({ block: 'start' })
      })
      await expect.poll(() => page.getByTestId('computer-task').count()).toBeGreaterThan(0)
      await evidence('04-computer-agent-diagnostics')
    }
  )
})
