import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { uuidv7 } from '@jupiter/core'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { DEMO_TOOLS, demoToolsCopy } from '@jupiter/testing/plugins'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, packageJson, query, waitForGateway } from './helpers'

/**
 * SET 15 in the real application: the Plugins screen shows the plugin
 * runtime and demo-tools (which ships with Jupiter); installing it asks for
 * plugin.install (CRITICAL); its Skills run in the plugin runtime with their
 * own permissions; a plugin folder with a bad manifest, a changed file or a
 * newer Jupiter requirement is refused with its reasons; disabling removes
 * its Skills and uninstalling keeps its storage. The folder "chosen" in the
 * dialog is named by JUPITER_TEST_PLUGIN_CHOICE (test environment only).
 * Screenshots go to test-results/set-15/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-15')

let userDataDir: string
let folders: string
let choiceFile: string
let jupiter: LaunchedJupiter
let page: Page

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  userDataDir = await createTempDir('jupiter-set15')
  folders = await createTempDir('jupiter-set15-folders')
  choiceFile = join(folders, 'choice.txt')
  writeFileSync(choiceFile, '')
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_PLUGIN_CHOICE: choiceFile }
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
}, 120_000)

afterAll(async () => {
  await jupiter.close()
  await removeDir(userDataDir)
  await removeDir(folders)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

/** The folder the next "choose a folder" dialog returns. */
function choose(folder: string): void {
  writeFileSync(choiceFile, folder)
}

/** Answers the permission dialog as the person would; returns the capabilities asked for. */
async function answerDialog(
  answer: 'allow-once' | 'deny' = 'allow-once',
  first?: string
): Promise<string[]> {
  const prompt = page.getByTestId('permission-dialog')
  const capabilities: string[] = []
  for (let answered = 0; answered < 5; answered++) {
    const shown = await prompt
      .waitFor({ state: 'visible', timeout: answered === 0 ? 15_000 : 2_000 })
      .then(() => true)
      .catch(() => false)
    if (!shown) break
    if (answered === 0 && first) await evidence(first)
    const id = await prompt.getByTestId('permission-facts').getAttribute('data-request-id')
    capabilities.push((await prompt.getByTestId('permission-capability').textContent()) ?? '')
    await prompt.getByTestId(`permission-${answer}`).click()
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

async function openPlugins(): Promise<void> {
  await page.getByTestId('nav-plugins').click()
  await page.getByTestId('view-plugins').waitFor()
  await page.getByTestId('plugins-runtime').waitFor()
}

const state = (id: string) => page.getByTestId(`plugin-${id}`).getAttribute('data-state')

async function waitForState(id: string, expected: string): Promise<void> {
  await expect.poll(() => state(id), { timeout: 20_000 }).toBe(expected)
}

/**
 * Runs a Skill the way any caller does. A permission it needs is asked for (the run ends
 * WAITING_APPROVAL), answered in the dialog as the person would, and the Skill is run again.
 */
async function runSkill(skillId: string, input: unknown, answer?: 'allow-once') {
  const run = () => query(page, 'skills.invoke', { executionId: uuidv7(), skillId, input })
  const first = await run()
  if (first.status !== 'WAITING_APPROVAL' || !answer) return { result: first, asked: [] }
  const asked = await answerDialog(answer)
  return { result: await run(), asked }
}

async function waitForError(code: string): Promise<string> {
  const error = page.getByTestId('plugins-error')
  await error.waitFor({ timeout: 20_000 })
  expect(await error.getAttribute('data-code')).toBe(code)
  return (await error.textContent()) ?? ''
}

describe('SET 15 — plugins in the real application', () => {
  it('shows the plugin runtime, its isolation, and demo-tools as shipping with Jupiter', async () => {
    await openPlugins()
    // Built: no "Coming later" label any more.
    expect(await page.getByTestId('view-availability').count()).toBe(0)
    expect(await page.getByTestId('plugins-runtime-state').getAttribute('data-available')).toBe(
      'true'
    )
    expect(await page.getByTestId('plugins-isolation').locator('li').count()).toBe(4)
    const candidate = page.getByTestId('plugin-candidate-demo-tools')
    await candidate.waitFor()
    expect(await candidate.textContent()).toContain('Version 1.0.0')
    expect(await page.getByTestId('plugins-none').count()).toBe(1)
    const status = await query(page, 'plugins.list', {})
    expect(status.runtime).toEqual({ name: 'plugin@1', available: true, reason: null })
    expect(status.jupiterVersion).toBe(packageJson.version)
    await evidence('01-plugins-runtime')
  })

  it('AT1: installs demo-tools after plugin.install (CRITICAL) and loads it', async () => {
    await openPlugins()
    await page.getByTestId('plugin-install-demo-tools').click()
    const asked = await answerDialog('allow-once', '02-permission-plugin-install')
    expect(asked).toEqual(['plugin.install'])
    await page.getByTestId('plugin-demo-tools').waitFor()
    await waitForState('demo-tools', 'INSTALLED')
    expect(await page.getByTestId('plugin-demo-tools-publisher').textContent()).toContain(
      'Unverified'
    )
    await page.getByTestId('plugin-demo-tools-enable').click()
    await waitForState('demo-tools', 'ENABLED')
    expect(await page.getByTestId('plugin-demo-tools-integrity').textContent()).toMatch(
      /2 files match their SHA-256/
    )
    const skills = page.getByTestId('plugin-demo-tools-skills')
    for (const skill of ['echo_text', 'get_app_version', 'save_note'])
      expect(await skills.textContent()).toContain(`demo-tools.${skill}`)
    await evidence('03-demo-tools-enabled')
  })

  it('AT3: its Skills run in the plugin runtime, each asking for its own permission', async () => {
    const echo = await runSkill('demo-tools.echo_text', { text: 'สวัสดี Jupiter' })
    expect(echo.result).toMatchObject({ status: 'SUCCESS', output: { text: 'สวัสดี Jupiter' } })
    const version = await runSkill('demo-tools.get_app_version', {}, 'allow-once')
    expect(version.asked).toEqual(['app.version.read'])
    expect(version.result).toMatchObject({
      status: 'SUCCESS',
      output: { version: packageJson.version, channel: 'alpha' }
    })
    const note = await runSkill(
      'demo-tools.save_note',
      { name: 'hello', text: '# Hello\n' },
      'allow-once'
    )
    expect(note.asked).toEqual(['plugin.storage.write'])
    expect(note.result).toMatchObject({
      status: 'SUCCESS',
      output: { path: 'notes/hello.md', bytes: 8 }
    })
    // Written only in the plugin's own storage, inside Jupiter's data folder.
    const notes = join(userDataDir, 'plugin-data', 'demo-tools', 'notes')
    expect(readFileSync(join(notes, 'hello.md'), 'utf8')).toBe('# Hello\n')
    // The same name again never replaces the first note.
    const again = await runSkill(
      'demo-tools.save_note',
      { name: 'hello', text: 'second' },
      'allow-once'
    )
    expect(again.result).toMatchObject({
      status: 'SUCCESS',
      output: { path: 'notes/hello (2).md' }
    })
    expect(readdirSync(notes).sort()).toEqual(['hello (2).md', 'hello.md'])
    await openPlugins()
    await expect
      .poll(() => page.getByTestId('plugin-demo-tools-storage').textContent())
      .toMatch(/^2 files/)
    await evidence('04-demo-tools-storage')
  })

  it('AT2: a plugin folder with an invalid manifest is refused, with its reasons', async () => {
    const broken = join(folders, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(
      join(broken, 'manifest.json'),
      JSON.stringify({ manifestVersion: 1, id: 'Bad_ID', version: 'one', entrypoint: '../x.sh' })
    )
    choose(broken)
    await openPlugins()
    await page.getByTestId('plugins-install-folder').click()
    const text = await waitForError('PLUGIN_INVALID')
    expect(text).toMatch(/id/)
    // Nothing was asked and nothing was installed.
    expect(await page.getByTestId('permission-dialog').isVisible()).toBe(false)
    expect(
      (await query(page, 'plugins.list', {})).plugins.map((plugin) => plugin.pluginId)
    ).toEqual(['demo-tools'])
    expect(readdirSync(join(userDataDir, 'plugins-staging'))).toEqual([])
    await evidence('05-invalid-manifest-refused')
  })

  it('AT10: a tampered or incompatible update is refused; a valid newer one is accepted', async () => {
    const tampered = demoToolsCopy(join(folders, 'tampered'), { manifest: { version: '1.1.0' } })
    writeFileSync(
      join(tampered, 'index.js'),
      `${readFileSync(join(DEMO_TOOLS, 'index.js'), 'utf8')}\n// changed after signing`
    )
    choose(tampered)
    await openPlugins()
    await page.getByTestId('plugin-demo-tools-update').click()
    expect(await waitForError('PLUGIN_INVALID')).toMatch(/does not match its SHA-256/)
    await evidence('06-tampered-update-refused')

    const incompatible = demoToolsCopy(join(folders, 'incompatible'), {
      manifest: { version: '1.2.0', minimumJupiterVersion: '99.0.0' }
    })
    choose(incompatible)
    await page.getByTestId('plugin-demo-tools-update').click()
    await expect
      .poll(() => page.getByTestId('plugins-error').getAttribute('data-code'))
      .toBe('PLUGIN_INCOMPATIBLE')
    await evidence('07-incompatible-update-refused')
    // The installed 1.0.0 kept running through both.
    await waitForState('demo-tools', 'ENABLED')
    expect((await runSkill('demo-tools.echo_text', { text: 'still here' })).result.status).toBe(
      'SUCCESS'
    )

    const newer = demoToolsCopy(join(folders, 'newer'), { manifest: { version: '1.1.0' } })
    choose(newer)
    await page.getByTestId('plugin-demo-tools-update').click()
    expect(await answerDialog()).toEqual(['plugin.install'])
    await page.getByTestId('plugins-done').waitFor()
    await waitForState('demo-tools', 'ENABLED')
    expect(await page.getByTestId('plugin-demo-tools').textContent()).toContain('Version 1.1.0')
    expect(await page.getByTestId('plugin-demo-tools').textContent()).toContain('Local folder')
    await evidence('08-update-accepted')
  })

  it('AT8: disabling removes its Skills; uninstalling keeps history and storage', async () => {
    await openPlugins()
    await page.getByTestId('plugin-demo-tools-disable').click()
    await waitForState('demo-tools', 'DISABLED')
    const skills = await query(page, 'skills.list', { filter: {} })
    expect(skills.skills.some((skill) => skill.definition.skillId.startsWith('demo-tools.'))).toBe(
      false
    )
    const refused = await query(page, 'skills.invoke', {
      executionId: uuidv7(),
      skillId: 'demo-tools.echo_text',
      input: { text: 'gone' }
    }).catch((error: unknown) => String(error))
    expect(refused).toMatch(/SKILL_NOT_FOUND/)
    await evidence('09-disabled')

    await page.getByTestId('plugin-demo-tools-uninstall').click()
    const dialog = page.getByTestId('plugin-demo-tools-uninstall-dialog')
    await dialog.waitFor()
    await evidence('10-uninstall-confirm')
    await dialog.getByRole('button', { name: 'Uninstall' }).click()
    await page.getByTestId('plugins-none').waitFor()
    // Its Skill runs stay in history, and the notes it saved are kept.
    const executions = await query(page, 'skills.executions', { limit: 50 })
    expect(
      executions.executions.filter((run) => run.skillId.startsWith('demo-tools.')).length
    ).toBeGreaterThanOrEqual(4)
    expect(existsSync(join(userDataDir, 'plugin-data', 'demo-tools', 'notes', 'hello.md'))).toBe(
      true
    )
    expect(existsSync(join(userDataDir, 'plugins', 'demo-tools'))).toBe(false)
    // demo-tools can be installed again from what ships with Jupiter.
    await page.getByTestId('plugin-candidate-demo-tools').waitFor()
    await evidence('11-uninstalled')
  })
})
