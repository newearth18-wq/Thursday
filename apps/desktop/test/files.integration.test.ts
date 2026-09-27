import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanDraft } from '@jupiter/contracts'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { checkOffice, copyFixtures } from '@jupiter/testing/documents'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  appDirectory,
  assertBuilt,
  envelope,
  gatewayStatus,
  invoke,
  query,
  waitForGateway
} from './helpers'

/**
 * SET 10 in the real application: the File Agent finds and reads real
 * documents in approved test folders (through the isolated document
 * runtime), a Mission reads the newest PDF and saves verified DOCX and PDF
 * artifacts, deleting one asks for the CRITICAL permission for that exact
 * file, and a damaged file or a path that leaves the folders fails cleanly.
 * Screenshots go to test-results/set-10/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-10')

let model: ProtocolServer
let userDataDir: string
let filesFolder: string
let jupiter: LaunchedJupiter
let page: Page

const at = (iso: string) => new Date(iso)

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  model = await startOpenAiCompatibleServer()
  model.setModels([{ id: 'planner-model', name: 'Planner Model' }])
  userDataDir = await createTempDir('jupiter-set10')
  filesFolder = await createTempDir('jupiter-set10-files')
  const downloads = join(filesFolder, 'downloads')
  for (const name of ['downloads', 'documents', 'desktop', 'workspace'])
    mkdirSync(join(filesFolder, name), { recursive: true })
  copyFixtures(downloads)
  // A controlled "newest" fixture: an older copy of the report and the report itself, with known times.
  copyFixtures(join(filesFolder, 'documents'), ['report.pdf'])
  writeFileSync(join(downloads, 'damaged.docx'), 'This is not a Word document at all.')
  // Every file gets a known modified time; the report is the newest.
  const times: Record<string, string> = {
    'briefing.docx': '2026-09-01T08:00:00.000Z',
    'budget.xlsx': '2026-09-02T08:00:00.000Z',
    'review.pptx': '2026-09-03T08:00:00.000Z',
    'damaged.docx': '2026-09-04T08:00:00.000Z',
    'notes.txt': '2026-09-05T08:00:00.000Z',
    'plan.md': '2026-09-06T08:00:00.000Z',
    'planet.json': '2026-09-07T08:00:00.000Z',
    'planets.csv': '2026-09-08T08:00:00.000Z',
    'chart.png': '2026-09-09T08:00:00.000Z',
    'report.pdf': '2026-09-20T08:30:00.000Z'
  }
  expect(readdirSync(downloads).sort()).toEqual(Object.keys(times).sort())
  for (const [name, time] of Object.entries(times))
    utimesSync(join(downloads, name), at(time), at(time))

  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_FILES_FOLDER: filesFolder }
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
  await removeDir(userDataDir)
  await removeDir(filesFolder)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

/** Answers every permission request the dialog shows, as the person would (Allow once). */
async function answerDialog(first?: string, timeout = 15_000): Promise<string[]> {
  const prompt = page.getByTestId('permission-dialog')
  const capabilities: string[] = []
  for (let answered = 0; answered < 10; answered++) {
    const shown = await prompt
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false)
    if (!shown) break
    if (answered === 0 && first) await evidence(first)
    const facts = prompt.getByTestId('permission-facts')
    const id = await facts.getAttribute('data-request-id')
    capabilities.push((await prompt.getByTestId('permission-capability').textContent()) ?? '')
    await prompt.getByTestId('permission-allow-once').click()
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
  return capabilities
}

async function openFiles(): Promise<void> {
  await page.getByTestId('nav-files').click()
  await page.getByTestId('files-roots').waitFor()
}

async function findIn(root: string, format: string): Promise<void> {
  await page.getByTestId('files-root-select').selectOption(root)
  await page.getByTestId('files-format-select').selectOption(format)
  await page.getByTestId('files-sort-select').selectOption('modified')
  await page.getByTestId('files-find').click()
}

async function readEntry(name: string): Promise<void> {
  await page
    .locator(`[data-testid="files-entry"][data-name="${name}"]`)
    .getByTestId('files-read')
    .click()
}

describe('SET 10 — File Agent and Artifact Manager, in the real application', () => {
  it('shows the File Agent as available, with its approved folders', async () => {
    const status = await query(page, 'files.status', {})
    expect(status.available).toBe(true)
    expect(status.roots.map((root) => [root.root, root.available])).toEqual([
      ['downloads', true],
      ['documents', true],
      ['desktop', true],
      ['workspace', true]
    ])
    expect(status.readFormats).toEqual(
      expect.arrayContaining(['txt', 'md', 'csv', 'json', 'pdf', 'docx', 'pptx', 'xlsx'])
    )
    await openFiles()
    expect(await page.getByTestId('files-availability').getAttribute('data-available')).toBe('true')
    expect(await page.getByTestId('files-root').count()).toBe(4)
    await evidence('01-files-available')
  })

  it('AT1 finds the newest PDF from a controlled folder, and AT3 reads it as untrusted content', async () => {
    await openFiles()
    await findIn('downloads', 'pdf')
    expect(await answerDialog('02-permission-list')).toContain('files.list')
    await page.getByTestId('files-results').waitFor()
    const names = await page
      .getByTestId('files-entry')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-name')))
    expect(names).toEqual(['report.pdf'])
    await readEntry('report.pdf')
    await answerDialog()
    const preview = page.getByTestId('files-preview')
    await preview.waitFor()
    expect(await preview.getAttribute('data-format')).toBe('pdf')
    expect(await preview.getByTestId('files-untrusted').count()).toBe(1)
    expect(await preview.getByTestId('files-meta-shape').textContent()).toMatch(/Pages: \d+/)
    expect(((await preview.getByTestId('files-text').textContent()) ?? '').length).toBeGreaterThan(
      20
    )
    await evidence('03-pdf-read')
  })

  it('AT2, AT4, AT5 read TXT, DOCX, PPTX and XLSX with their metadata and content', async () => {
    await openFiles()
    await findIn('downloads', 'any')
    await answerDialog()
    await page.getByTestId('files-results').waitFor()
    // Sorted by modified time, newest first: the report (20 Sept) leads.
    expect(await page.getByTestId('files-entry').first().getAttribute('data-name')).toBe(
      'report.pdf'
    )

    await readEntry('notes.txt')
    await answerDialog()
    await expect
      .poll(() => page.getByTestId('files-preview').getAttribute('data-format'))
      .toBe('txt')

    await readEntry('briefing.docx')
    await answerDialog()
    await expect
      .poll(() => page.getByTestId('files-preview').getAttribute('data-format'))
      .toBe('docx')
    expect((await page.getByTestId('files-text').textContent())?.length).toBeGreaterThan(20)

    await readEntry('review.pptx')
    await answerDialog()
    await expect
      .poll(() => page.getByTestId('files-preview').getAttribute('data-format'))
      .toBe('pptx')
    expect(await page.getByTestId('files-slides').locator('li').count()).toBeGreaterThan(0)
    await evidence('04-pptx-read')

    await readEntry('budget.xlsx')
    await answerDialog()
    await expect
      .poll(() => page.getByTestId('files-preview').getAttribute('data-format'))
      .toBe('xlsx')
    expect(await page.getByTestId('files-sheets').locator('li').count()).toBeGreaterThan(0)
    await evidence('05-xlsx-read')
  })

  it('AT9 a damaged file fails with a clear error and Jupiter keeps running', async () => {
    await openFiles()
    await findIn('downloads', 'docx')
    await answerDialog()
    await page.getByTestId('files-results').waitFor()
    await readEntry('damaged.docx')
    await answerDialog()
    const error = page.getByTestId('files-error')
    await error.waitFor()
    expect(await error.textContent()).toContain('DOCUMENT_INVALID')
    await evidence('06-damaged-file')
    const missing = await invoke(
      page,
      envelope('files.read', {
        location: { root: 'downloads', path: 'not-there.pdf' },
        maxChars: 1000,
        missionId: null
      })
    )
    expect(missing).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } })
    expect(await page.getByTestId('permission-dialog').isVisible()).toBe(false)
    const status = await gatewayStatus(page)
    expect(status.core.state).toBe('running')
  })

  it('AT10 refuses a path that leaves the approved folders, before anything is touched', async () => {
    for (const path of [
      '../outside.txt',
      'a/../../outside.txt',
      '/etc/passwd',
      'C:\\Windows\\win.ini'
    ]) {
      const result = await invoke(
        page,
        envelope('files.read', {
          location: { root: 'downloads', path },
          maxChars: 1000,
          missionId: null
        })
      )
      expect(result.ok, path).toBe(false)
    }
    const status = await gatewayStatus(page)
    expect(status.core.state).toBe('running')
  })

  it('AT6, AT7 a Mission reads the newest PDF and saves verified DOCX and PDF artifacts', async () => {
    const plan: PlanDraft = {
      goal: 'Summarise the newest PDF in Downloads',
      assumptions: [],
      rationale: 'Read the newest PDF, summarise it, save the summary.',
      steps: [
        {
          id: 'read',
          title: 'Read the newest PDF',
          description: 'File Agent',
          skillId: 'document.read_newest',
          dependencies: [],
          input: { root: 'downloads', format: 'pdf' },
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
          input: { prompt: 'Summarise, citing the source file:\n{{read}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'docx',
          title: 'Save the summary as DOCX',
          description: 'Artifact Manager',
          skillId: 'document.create',
          dependencies: ['sum'],
          input: { format: 'docx', name: 'summary.docx', content: '# Summary\n\n{{sum}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'pdf',
          title: 'Save the summary as PDF',
          description: 'Artifact Manager',
          skillId: 'document.create',
          dependencies: ['sum'],
          input: { format: 'pdf', name: 'summary.pdf', content: '# Summary\n\n{{sum}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        }
      ],
      requiredSkills: ['document.read_newest', 'model.generate', 'document.create'],
      requiredPermissions: ['files.list', 'files.read', 'artifacts.create'],
      expectedArtifacts: [
        { step: 'docx', description: 'The summary document' },
        { step: 'pdf', description: 'The summary as PDF' }
      ],
      verificationPlan: { checks: [{ step: 'sum', check: 'non-empty', description: 'Summarised' }] }
    }
    model.enqueue({ chunks: [JSON.stringify(plan)] })
    model.enqueue({
      chunks: ['The Great Red Spot is a storm larger than Earth (source: report.pdf).']
    })

    await page.getByTestId('nav-missions').click()
    await page.getByTestId('mission-new').click()
    const dialog = page.getByTestId('mission-new-dialog')
    await dialog
      .getByTestId('mission-new-request')
      .fill('Find newest PDF in Downloads and summarize it')
    const create = dialog.getByTestId('mission-new-create')
    await expect.poll(() => create.isEnabled()).toBe(true)
    await create.click()

    const detail = page.getByTestId('mission-detail')
    for (let round = 0; round < 6; round++) {
      await answerDialog(round === 0 ? '07-mission-permission' : undefined, 5_000)
      if ((await detail.getAttribute('data-status')) === 'COMPLETED') break
    }
    await expect
      .poll(() => detail.getAttribute('data-status'), { timeout: 120_000 })
      .toBe('COMPLETED')

    // The model got the document only as fenced, labelled, untrusted data, naming the newest file.
    const prompt = JSON.stringify(
      model.requests.filter((request) => request.method === 'POST').at(-1)?.body
    )
    expect(prompt).toContain('BEGIN UNTRUSTED DOCUMENT TEXT')
    expect(prompt).toContain('report.pdf')

    const list = detail.getByTestId('mission-file-list')
    await expect.poll(() => list.getByTestId('artifact').count()).toBe(2)
    const statuses = await list
      .getByTestId('artifact')
      .evaluateAll((items) =>
        items.map((item) => [item.getAttribute('data-type'), item.getAttribute('data-status')])
      )
    expect(statuses.sort()).toEqual([
      ['docx', 'VERIFIED'],
      ['pdf', 'VERIFIED']
    ])
    await list.evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
    await evidence('08-mission-artifacts-verified')

    const missionId = await detail.getAttribute('data-mission-id')
    const { artifacts } = await query(page, 'artifacts.list', {
      missionId,
      includeDeleted: false,
      limit: 20
    })
    const docx = artifacts.find((item) => item.type === 'docx')
    const pdf = artifacts.find((item) => item.type === 'pdf')
    expect(docx?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(docx?.source.transformation).toBeTruthy()
    // An independent parser opens the DOCX Jupiter made.
    expect(checkOffice(docx?.path ?? '', 'docx')).toBeTruthy()
    // The PDF was printed by Chromium and read back by the document runtime.
    expect(pdf?.verificationDetails.every((check) => check.passed)).toBe(true)
    expect(existsSync(pdf?.path ?? '')).toBe(true)
  })

  it('AT8 deleting an artifact asks for the CRITICAL permission for that exact file', async () => {
    await openFiles()
    const item = page
      .getByTestId('files-artifacts')
      .locator('[data-testid="artifact"][data-type="docx"]')
      .first()
    await item.waitFor()
    const path = (await item.getByTestId('artifact-path').textContent()) ?? ''
    expect(existsSync(path)).toBe(true)
    await item.getByTestId('artifact-delete').click()
    await item.getByTestId('artifact-delete-dialog').waitFor()
    await evidence('09-delete-confirm')
    await item.getByTestId('artifact-delete-confirm').click()

    const prompt = page.getByTestId('permission-dialog')
    await prompt.waitFor()
    expect(await prompt.getByTestId('permission-capability').textContent()).toBe('files.delete')
    expect(await prompt.getByTestId('permission-risk').textContent()).toBe('Critical')
    expect(await prompt.getByTestId('permission-target').textContent()).toContain('summary.docx')
    // CRITICAL: only Allow once or Deny.
    expect(await prompt.getByTestId('permission-allow-session').count()).toBe(0)
    await evidence('10-delete-permission-critical')
    await prompt.getByTestId('permission-allow-once').click()

    await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(false)
    const bin = join(filesFolder, 'recycle-bin')
    expect(readdirSync(bin).some((name) => name.endsWith('summary.docx'))).toBe(true)
    await page.getByTestId('artifacts-show-deleted').click()
    await expect
      .poll(() =>
        page
          .getByTestId('files-artifacts')
          .locator('[data-testid="artifact"][data-type="docx"]')
          .first()
          .getAttribute('data-deleted')
      )
      .toBe('true')
    // A deleted file is not shown as verified.
    const deleted = page
      .getByTestId('files-artifacts')
      .locator('[data-testid="artifact"][data-deleted="true"]')
      .first()
    expect(await deleted.getByTestId('artifact-verification').count()).toBe(0)
    await evidence('11-artifact-deleted')
  })
})
