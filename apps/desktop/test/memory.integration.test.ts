import {
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { checkMarkdown } from '@jupiter/testing/documents'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import {
  nonLoopbackAddress,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, query, waitForGateway } from './helpers'

/**
 * SET 11 in the real application: the person adds memories on the Memory
 * screen and the policy decides (SAVE, DO_NOT_SAVE, ASK_USER) with reasons;
 * a saved memory is still there after a restart; a sensitive one waits for
 * the person and is then kept sealed; the person corrects, forgets and
 * deletes; an Obsidian vault the person chose is connected and a new note
 * with backlinks is written without harming the existing notes; semantic
 * search under Local only never calls the cloud. Screenshots go to
 * test-results/set-11/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-11')
const CARD = '4111 1111 1111 1111'
const KEY = fakeCredentials()[1]?.value ?? ''

let local: ProtocolServer
let cloud: ProtocolServer
let userDataDir: string
let vault: string
let jupiter: LaunchedJupiter
let page: Page

async function launch(): Promise<void> {
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_VAULT_FOLDER: vault }
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
}

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('This test needs a non-loopback network interface for the "cloud" server')
  local = await startOpenAiCompatibleServer()
  cloud = await startOpenAiCompatibleServer({ host: address })
  userDataDir = await createTempDir('jupiter-set11')
  // The real long path: Windows may hand out a short (8.3) temporary path.
  vault = realpathSync.native(await createTempDir('jupiter-set11-vault'))
  // An existing Obsidian vault: its settings folder, a note with a BOM, CRLF line endings and
  // frontmatter, and a plain note.
  mkdirSync(join(vault, '.obsidian'))
  writeFileSync(join(vault, '.obsidian', 'app.json'), '{}')
  mkdirSync(join(vault, 'Space'))
  writeFileSync(
    join(vault, 'Space', 'Jupiter.md'),
    '﻿---\r\naliases: [Jove]\r\nrating: 5\r\n---\r\n# Jupiter\r\n\r\nThe largest planet. See [[Saturn]].\r\n'
  )
  writeFileSync(join(vault, 'Saturn.md'), '# Saturn\n\nThe ringed planet.\n')
  await launch()
}, 120_000)

afterAll(async () => {
  await jupiter.close()
  await local.close()
  await cloud.close()
  await removeDir(userDataDir)
  await removeDir(vault)
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
    timeout = 3_000
  }
  return capabilities
}

/** Every byte Jupiter keeps for this profile: database, WAL, logs, settings, vault state. */
function everythingStored(): string {
  const parts: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      // Chromium's lock files and sockets come and go; only real files and folders are read.
      let info: ReturnType<typeof lstatSync>
      try {
        info = lstatSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(path)
      else if (info.isFile() && info.size < 50_000_000) {
        const bytes = readFileSync(path)
        parts.push(bytes.toString('latin1'), bytes.toString('utf8'))
      }
    }
  }
  walk(userDataDir)
  return parts.join('\n')
}

async function openMemory(tab: 'memories' | 'add' | 'waiting' | 'policy' | 'obsidian') {
  await page.getByTestId('nav-memory').click()
  await page.getByTestId('memory-tabs').waitFor()
  await page.getByTestId(`tab-${tab}`).click()
}

async function propose(content: string, type = 'facts'): Promise<string | null> {
  await openMemory('add')
  await page.getByTestId('memory-add-content').fill(content)
  await page.getByTestId('memory-add-type').selectOption(type)
  const decision = page.getByTestId('memory-decision')
  // Wait for the answer to this request, not the one still on screen from the last.
  const before = (await decision.count()) ? Number(await decision.getAttribute('data-sequence')) : 0
  await page.getByTestId('memory-add-submit').click()
  await expect.poll(() => decision.getAttribute('data-sequence')).toBe(String(before + 1))
  return decision.getAttribute('data-decision')
}

async function reasons(): Promise<(string | null)[]> {
  return page
    .getByTestId('memory-reason')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-code')))
}

function item(text: string) {
  return page.getByTestId('memory-item').filter({ hasText: text })
}

async function memoriesNamed(text: string, includeForgotten = false) {
  const result = await query(page, 'memory.search', {
    mode: 'keyword',
    text,
    types: [],
    tags: [],
    sensitivity: null,
    relatedTo: null,
    includeForgotten,
    minConfidence: 0,
    limit: 50
  })
  return result.hits.map((hit) => hit.memory)
}

describe('SET 11 — Memory System and Obsidian, in the real application', () => {
  it('shows the Memory screen as working, with secure storage for sensitive memories', async () => {
    await openMemory('memories')
    expect(await page.getByTestId('view-availability').count()).toBe(0)
    expect(await page.getByTestId('memory-secure-storage').getAttribute('data-available')).toBe(
      'true'
    )
    expect(await page.getByTestId('memory-count-long-term').textContent()).toBe('0')
    await evidence('01-memory-screen')
  })

  it('AT1: saves an allowed memory, with its reasons', async () => {
    expect(await propose('My favourite editor theme is Solarized Dark.', 'preferences')).toBe(
      'SAVE'
    )
    expect(await reasons()).toContain('explicit-request')
    await page.getByTestId('memory-decision').scrollIntoViewIfNeeded()
    await evidence('02-at1-saved')
    await openMemory('memories')
    await item('Solarized Dark').waitFor()
    expect(await item('Solarized Dark').getAttribute('data-layer')).toBe('long-term')
    expect(await page.getByTestId('memory-count-long-term').textContent()).toBe('1')
  })

  it('AT2: the memory is still there after a restart', async () => {
    await jupiter.close()
    await launch()
    await openMemory('memories')
    await item('Solarized Dark').waitFor()
    expect(await item('Solarized Dark').getByTestId('memory-content').textContent()).toBe(
      'My favourite editor theme is Solarized Dark.'
    )
    await evidence('03-at2-after-restart')
  })

  it('AT3: DO_NOT_SAVE is respected — a key is never kept, stored or logged', async () => {
    expect(KEY.length).toBeGreaterThan(20)
    expect(await propose(`My OpenAI key is ${KEY}`)).toBe('DO_NOT_SAVE')
    expect(await reasons()).toEqual(['credential'])
    // The key does not stay in the form once Core has answered.
    expect(await page.getByTestId('memory-add-content').inputValue()).toBe('')
    await page.getByTestId('memory-decision').scrollIntoViewIfNeeded()
    await evidence('04-at3-do-not-save')
    // Nor a duplicate of what is already remembered.
    expect(await propose('My favourite editor theme is Solarized Dark.', 'preferences')).toBe(
      'DO_NOT_SAVE'
    )
    expect(await reasons()).toContain('duplicate')
    expect(await page.getByTestId('memory-count-long-term').textContent()).toBe('1')
    const stored = everythingStored()
    expect(stored.includes(KEY)).toBe(false)
    expect(stored.includes(KEY.slice(0, 16))).toBe(false)
    // The policy log records the decision and its reason, never the content.
    await openMemory('policy')
    const rows = page.getByTestId('memory-policy-row')
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3)
    expect(await page.getByTestId('memory-policy').textContent()).not.toContain('OpenAI key')
  })

  it('AT4 + AT10: ASK_USER waits for the person; nothing is stored until then, and then only sealed', async () => {
    expect(await propose(`My credit card number is ${CARD}.`)).toBe('ASK_USER')
    expect(await reasons()).toContain('financial')
    // Waiting: not in the database, the logs or anywhere else on disk.
    expect(everythingStored().includes('4111')).toBe(false)
    expect(await page.getByTestId('memory-count-long-term').textContent()).toBe('1')
    await openMemory('waiting')
    const candidate = page.getByTestId('memory-candidate')
    await candidate.waitFor()
    expect(await candidate.getByTestId('memory-candidate-kind').textContent()).toBe(
      'Financial information'
    )
    await evidence('05-at4-waiting-for-you')
    // Only the person's answer keeps it.
    await candidate.getByTestId('memory-candidate-save').click()
    await page.getByTestId('memory-candidates-empty').waitFor()
    await expect.poll(() => page.getByTestId('memory-count-sensitive').textContent()).toBe('1')
    // AT10: kept sealed by the operating system's secure storage — not in any file, log or event.
    expect(everythingStored().includes('4111')).toBe(false)
    const events = await query(page, 'events.list', {
      afterSequence: null,
      limit: 200,
      filter: {
        types: ['memory.decided', 'memory.saved', 'memory.changed'],
        streams: null,
        missionId: null
      }
    })
    expect(events.events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events).includes('4111')).toBe(false)
    // Hidden in the list until the person reveals it.
    await openMemory('memories')
    const sealed = page.locator('[data-testid="memory-item"][data-sensitivity="sensitive"]')
    await sealed.waitFor()
    expect(await sealed.getByTestId('memory-hidden').count()).toBe(1)
    await evidence('06-at10-sealed')
    await sealed.getByTestId('memory-reveal').click()
    await expect
      .poll(() => sealed.getByTestId('memory-content').textContent())
      .toBe(`My credit card number is ${CARD}.`)
    await evidence('07-at10-revealed')
    // The person can also decline: a health note is then discarded without a trace.
    expect(await propose('I was diagnosed with a heart condition last year.')).toBe('ASK_USER')
    await openMemory('waiting')
    await page.getByTestId('memory-candidate-discard').click()
    await page.getByTestId('memory-candidates-empty').waitFor()
    expect(everythingStored().includes('heart condition')).toBe(false)
  })

  it('AT5: the person corrects, forgets and deletes a memory', async () => {
    expect(await propose('The team meeting is every Tuesday at 10:00.', 'routines')).toBe('SAVE')
    await openMemory('memories')
    const meeting = item('team meeting')
    await meeting.waitFor()
    await meeting.getByTestId('memory-correct').click()
    const correcting = page.locator('[data-testid="memory-correct-dialog"]:visible')
    await correcting.waitFor()
    await correcting
      .getByTestId('memory-correct-text')
      .fill('The team meeting is every Wednesday at 10:00.')
    await evidence('08-at5-correct')
    await correcting.getByTestId('memory-correct-save').click()
    await expect
      .poll(() => item('team meeting').getByTestId('memory-content').textContent())
      .toBe('The team meeting is every Wednesday at 10:00.')
    const [corrected] = await memoriesNamed('Wednesday')
    expect(corrected).toMatchObject({ corrections: 1, state: 'active' })

    // Forget: kept, but never recalled, and out of the normal list.
    await item('team meeting').getByTestId('memory-forget').click()
    await expect.poll(() => item('team meeting').count()).toBe(0)
    expect(await memoriesNamed('Wednesday')).toHaveLength(0)
    expect((await memoriesNamed('Wednesday', true))[0]?.state).toBe('forgotten')

    // Delete: shown again with forgotten memories, then removed for good after the HIGH permission.
    await page.getByTestId('memory-include-forgotten').click()
    const forgotten = item('team meeting')
    await forgotten.waitFor()
    await forgotten.getByTestId('memory-delete').click()
    // Every memory has its own (closed) dialogs; only the open one is visible.
    const confirm = page.locator('[data-testid="memory-delete-dialog"]:visible')
    await confirm.waitFor()
    await evidence('09-at5-delete-confirm')
    await confirm.getByTestId('memory-delete-confirm').click()
    expect(await answerDialog('10-at5-delete-permission')).toContain('memory.delete')
    await expect.poll(() => item('team meeting').count()).toBe(0)
    expect(await memoriesNamed('Wednesday', true)).toHaveLength(0)
    // Gone from the database file and its journal as well, not just hidden.
    expect(everythingStored().includes('every Wednesday')).toBe(false)
    expect(everythingStored().includes('every Tuesday')).toBe(false)
    await page.getByTestId('memory-include-forgotten').click()
  })

  it('AT6: connects the Obsidian vault the person chose', async () => {
    await openMemory('obsidian')
    await page.getByTestId('notes-not-connected').waitFor()
    await evidence('11-at6-not-connected')
    await page.getByTestId('notes-connect-vault').click()
    await page.getByTestId('notes-vault').waitFor()
    expect(await page.getByTestId('notes-vault-path').textContent()).toBe(vault)
    // Nothing is read until the person asks; seeing the list asks for notes.read on this vault.
    expect(await page.getByTestId('notes-list').count()).toBe(0)
    await page.getByTestId('notes-show-recent').click()
    expect(await answerDialog('12-at6-read-permission')).toEqual(['notes.read'])
    await page.getByTestId('notes-list').waitFor()
    const listed = await page
      .getByTestId('notes-entry')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path')))
    expect(listed.sort()).toEqual(['Saturn.md', 'Space/Jupiter.md'])
    await evidence('13-at6-connected')
  })

  it('AT7 + AT8: creates a valid Markdown note with valid backlinks; existing notes stay intact', async () => {
    const original = readFileSync(join(vault, 'Space', 'Jupiter.md'))
    const saturnBefore = readFileSync(join(vault, 'Saturn.md'))
    await openMemory('obsidian')
    await page.getByTestId('notes-create-title').fill('Great Red Spot')
    await page.getByTestId('notes-create-folder').fill('Space')
    await page.getByTestId('notes-create-body').fill('A storm larger than Earth.')
    await page.getByTestId('notes-create-tags').fill('storm')
    await page.getByTestId('notes-create-links').fill('Jupiter, Saturn')
    await page.getByTestId('notes-create-submit').click()
    const asked = await answerDialog('14-at7-write-permission')
    expect(asked.every((capability) => capability === 'notes.write')).toBe(true)
    await expect
      .poll(async () =>
        (await page.getByTestId('notes-create-error').count())
          ? await page.getByTestId('notes-create-error').textContent()
          : await page.getByTestId('notes-create-status').textContent()
      )
      .toBe('Created Space/Great Red Spot.md.')
    const backlinks = await page
      .getByTestId('notes-backlinks')
      .locator('li')
      .evaluateAll((items) => items.map((li) => li.getAttribute('data-added')))
    expect(backlinks).toEqual(['true', 'true'])
    await evidence('15-at7-created')

    // AT7: valid Markdown and YAML, read by an independent parser; every link resolves.
    const note = checkMarkdown(join(vault, 'Space', 'Great Red Spot.md'))
    expect(note.frontmatter).toMatchObject({
      title: 'Great Red Spot',
      source: 'Jupiter',
      tags: ['jupiter', 'storm']
    })
    expect(note.links).toEqual(['Jupiter', 'Saturn'])
    expect(checkMarkdown(join(vault, 'Saturn.md')).links).toEqual(['Great Red Spot'])

    // AT8: the existing notes keep every byte they had, their BOM, line endings and frontmatter.
    const jupiterNote = checkMarkdown(join(vault, 'Space', 'Jupiter.md'))
    expect(jupiterNote).toMatchObject({ bom: true, crlf: true })
    expect(jupiterNote.frontmatter).toEqual({ aliases: ['Jove'], rating: 5 })
    expect(jupiterNote.links).toEqual(['Saturn', 'Great Red Spot'])
    const after = readFileSync(join(vault, 'Space', 'Jupiter.md'))
    expect(after.subarray(0, original.length).equals(original)).toBe(true)
    const saturnAfter = readFileSync(join(vault, 'Saturn.md'))
    expect(saturnAfter.subarray(0, saturnBefore.length).equals(saturnBefore)).toBe(true)
    // A copy of each note as it was, kept outside the vault before the change.
    const backups = join(userDataDir, 'notes-backups')
    const copies = readdirSync(backups, { recursive: true }).map(String)
    const copyOf = (name: string) =>
      readFileSync(join(backups, copies.find((path) => path.endsWith(name)) ?? 'missing'))
    expect(copyOf('Jupiter.md').equals(original)).toBe(true)
    expect(copyOf('Saturn.md').equals(saturnBefore)).toBe(true)

    // Creating it again never overwrites: the second note gets a free name.
    await page.getByTestId('notes-create-submit').click()
    await answerDialog()
    await expect
      .poll(async () =>
        (await page.getByTestId('notes-create-error').count())
          ? await page.getByTestId('notes-create-error').textContent()
          : await page.getByTestId('notes-create-status').textContent()
      )
      .toBe('Created Space/Great Red Spot (2).md.')
    expect(checkMarkdown(join(vault, 'Space', 'Great Red Spot.md')).body).toContain(
      'A storm larger than Earth.'
    )
    // …and the backlinks already there are not duplicated.
    expect(checkMarkdown(join(vault, 'Saturn.md')).links).toEqual([
      'Great Red Spot',
      'Great Red Spot (2)'
    ])
  })

  it('AT9: with Local only, semantic search makes no cloud call; with a local model it runs here', async () => {
    const add = async (target: ProtocolServer, name: string) => {
      target.setModels([{ id: 'embed-model' }])
      target.embedByWords(true)
      const provider = await query(page, 'ai.providers.add', {
        adapterId: 'openai-compatible',
        displayName: name,
        baseUrl: target.baseUrl
      })
      await query(page, 'ai.providers.check', { providerId: provider.providerId })
      await query(page, 'ai.models.update', {
        providerId: provider.providerId,
        modelId: 'embed-model',
        enabled: true,
        capabilities: ['embeddings']
      })
    }
    await add(cloud, 'Cloud embeddings')
    await query(page, 'settings.update', { key: 'ai.routingMode', value: 'LOCAL_ONLY' })
    cloud.reset()
    await openMemory('memories')
    await page.getByTestId('memory-semantic-setting').click()
    await expect
      .poll(() => page.getByTestId('memory-semantic-status').getAttribute('data-available'))
      .toBe('false')
    await page.getByTestId('memory-search-mode').selectOption('semantic')
    await page.getByTestId('memory-search-text').fill('editor colours')
    await page.getByTestId('memory-memories').locator('button[type="submit"]').click()
    const result = page.getByTestId('memory-semantic-result')
    await result.waitFor()
    expect(await result.getAttribute('data-used')).toBe('false')
    await evidence('16-at9-local-only-no-cloud')
    expect(cloud.connections()).toBe(0)

    await add(local, 'Local embeddings')
    cloud.reset()
    await page.getByTestId('memory-search-text').fill('Solarized theme')
    await page.getByTestId('memory-memories').locator('button[type="submit"]').click()
    await expect.poll(() => result.getAttribute('data-used')).toBe('true')
    expect(await result.textContent()).toContain('on this computer')
    await item('Solarized Dark').waitFor()
    expect(cloud.connections()).toBe(0)
    const embedded = local.requests.filter((request) => request.path === '/v1/embeddings')
    expect(embedded.length).toBeGreaterThan(0)
    // Sensitive memories never go to any model.
    expect(JSON.stringify(embedded.map((request) => request.body))).not.toContain('4111')
    await evidence('17-at9-local-semantic')
  })

  it('shows the Memory screen in Thai too', async () => {
    const language = async (value: 'th' | 'en') => {
      await page.getByTestId('nav-settings').click()
      await page.getByTestId('tab-general').click()
      await page.getByTestId(`setting-language-${value}`).check()
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="settings-save-status"]')?.textContent ?? '') !== ''
      )
    }
    await language('th')
    await openMemory('policy')
    expect(await page.getByTestId('tab-policy').textContent()).toBe('บันทึกนโยบาย')
    await evidence('18-thai-policy-log')
    await language('en')
  })
})
