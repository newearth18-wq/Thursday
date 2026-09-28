import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { OWNER_FRAMES, writeFaceVideo } from '@jupiter/testing/identity'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  appDirectory,
  assertBuilt,
  envelope,
  invoke,
  query,
  readLog,
  waitForGateway
} from './helpers'

/**
 * SET 14 in the real application: the Identity tab in Settings, Face
 * Identity through the real camera path (Chromium's fake camera plays the
 * owner's photographs, moving closer, behind the real permission and camera
 * gate) and the real face engine (face-api on TF.js WASM in the identity
 * runtime), identity protection, and a Windows lock reported by Electron's
 * powerMonitor. Windows Hello is Unavailable on Linux and says so.
 * Screenshots go to test-results/set-14/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-14')

/** A memory search: `memory.read`, which needs VERIFIED while identity protection is on. */
const MEMORY_QUERY = {
  mode: 'keyword',
  text: '',
  types: [],
  tags: [],
  sensitivity: null,
  relatedTo: null,
  includeForgotten: false,
  minConfidence: 0,
  limit: 50
}

let userDataDir: string
let filesFolder: string
let jupiter: LaunchedJupiter
let page: Page

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  userDataDir = await createTempDir('jupiter-set14')
  // A real file for the critical action (deleting it) that face alone must not allow.
  filesFolder = await createTempDir('jupiter-set14-files')
  mkdirSync(join(filesFolder, 'documents'))
  writeFileSync(join(filesFolder, 'documents', 'report.txt'), 'Quarterly report\n')
  // The owner moving closer to the camera: five photographs, 0.3 s each, looping.
  const video = join(userDataDir, 'owner.y4m')
  writeFaceVideo(video, OWNER_FRAMES, 3)
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_FAKE_CAMERA: video, JUPITER_TEST_FILES_FOLDER: filesFolder }
  })
  page = jupiter.window
  await jupiter.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 1300)
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
  await removeDir(filesFolder)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function evidence(name: string, focus?: string): Promise<void> {
  // The page scrolls inside the window: show the part the screenshot is about.
  if (focus)
    await page.getByTestId(focus).evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function openIdentity(): Promise<void> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-tabs').waitFor()
  await page.getByTestId('tab-identity').click()
  await page.getByTestId('identity-panel').waitFor()
}

/** Answers every permission request the dialog shows, as the person would. */
async function answerDialog(button = 'permission-allow-session'): Promise<string[]> {
  const prompt = page.getByTestId('permission-dialog')
  const capabilities: string[] = []
  for (let answered = 0; answered < 5; answered++) {
    const shown = await prompt
      .waitFor({ state: 'visible', timeout: answered === 0 ? 15_000 : 2_000 })
      .then(() => true)
      .catch(() => false)
    if (!shown) break
    capabilities.push((await prompt.getByTestId('permission-capability').textContent()) ?? '')
    await prompt.getByTestId(button).click()
    await prompt.waitFor({ state: 'hidden' })
  }
  return capabilities
}

const level = () => page.getByTestId('identity-level').getAttribute('data-level')

async function startCamera(): Promise<void> {
  await page.getByTestId('identity-face-camera').click()
  await answerDialog()
  await expect.poll(() => page.getByTestId('camera-preview').count(), { timeout: 15_000 }).toBe(1)
  // The fake camera is running once frames come through (the track is live).
  await expect
    .poll(async () => (await query(page, 'camera.status', {})).state, { timeout: 15_000 })
    .toBe('ACTIVE')
}

async function verifyWithFace(): Promise<void> {
  await startCamera()
  await page.getByTestId('identity-face-verify').click()
  await expect
    .poll(() => page.getByTestId('identity-result').getAttribute('data-outcome'), {
      timeout: 60_000
    })
    .toBe('verified')
}

describe('SET 14 — Identity, in the real application', () => {
  it('shows each method, what it can prove, and Windows Hello labelled where it cannot be used', async () => {
    await openIdentity()
    expect(await level()).toBe('UNKNOWN')
    // Face and voice run on this computer; Windows Hello depends on this computer and user.
    await expect
      .poll(async () =>
        (await query(page, 'identity.status', {})).methods
          .filter((method) => method.method !== 'windows-hello')
          .map((method) => [method.method, method.available])
      )
      .toEqual([
        ['face', true],
        ['voice', true]
      ])
    const hello = (await query(page, 'identity.status', {})).methods.find(
      (method) => method.method === 'windows-hello'
    )
    if (process.platform !== 'win32') expect(hello?.available).toBe(false)
    if (!hello?.available) {
      // Not usable here (not Windows, or Hello not set up for this user): labelled, never offered.
      expect(
        await page
          .getByTestId('identity-windows-hello-availability')
          .getAttribute('data-availability')
      ).toMatch(/^(UNAVAILABLE|NOT_CONFIGURED)$/)
      expect(await page.getByTestId('identity-hello-verify').isDisabled()).toBe(true)
      expect(hello?.reason).toBeTruthy()
    }
    // Face and voice are labelled Experimental; protection is off by default.
    expect(
      await page.getByTestId('identity-face').locator('[data-availability="EXPERIMENTAL"]').count()
    ).toBe(1)
    expect(
      await page.getByTestId('identity-voice').locator('[data-availability="EXPERIMENTAL"]').count()
    ).toBe(1)
    expect(await page.getByTestId('identity-protection').isChecked()).toBe(false)
    await evidence('01-identity-methods')
  })

  it('AT1 + AT2: Face Identity is set up only with consent, from the live camera, and sealed by the OS', async () => {
    await openIdentity()
    await startCamera()
    // Without consent the button stays disabled.
    expect(await page.getByTestId('identity-face-enroll').isDisabled()).toBe(true)
    await evidence('02-face-consent-and-preview', 'identity-face')
    await page.getByTestId('identity-face-consent').check()
    await page.getByTestId('identity-face-enroll').click()
    await expect
      .poll(() => page.getByTestId('identity-result').getAttribute('data-outcome'), {
        timeout: 60_000
      })
      .toBe('enrolled')
    expect(await page.getByTestId('identity-face-enrolled').getAttribute('data-enrolled')).toBe(
      'true'
    )
    // AT2: the template is kept only as the operating system's ciphertext (safeStorage, here a
    // real, throwaway GNOME Keyring); only the OS can open it again.
    const database = new DatabaseSync(join(userDataDir, 'jupiter.db'), { readOnly: true })
    const row = database
      .prepare("SELECT sealed_template AS sealed FROM identity_methods WHERE method = 'face'")
      .get() as { sealed: string } | undefined
    database.close()
    const sealed = row?.sealed ?? ''
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toMatch(/descriptors|version/)
    const opened = await jupiter.app.evaluate(
      ({ safeStorage }, text) =>
        safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(text, 'base64')).slice(0, 30)
          : 'no OS encryption',
      sealed
    )
    expect(opened).toMatch(/^\{"version":1,"descriptors":/)
    // The camera is released afterwards, and no frame is left in memory.
    await expect.poll(async () => (await query(page, 'camera.status', {})).state).toBe('OFF')
    await expect.poll(async () => (await query(page, 'vision.status', {})).images.length).toBe(0)
    await evidence('03-face-enrolled', 'identity-face')
  })

  it('AT5 + AT10: a face check shows its liveness result and limitation; the permission is still asked', async () => {
    await openIdentity()
    await verifyWithFace()
    await expect.poll(level).toBe('VERIFIED')
    const liveness = page.getByTestId('identity-liveness')
    expect(await liveness.getAttribute('data-state')).toBe('passed')
    for (const check of ['frames', 'same-person', 'natural-variation', 'distance-changed'])
      expect(
        await liveness.getByTestId(`identity-check-${check}`).getAttribute('data-passed')
      ).toBe('true')
    expect(await page.getByTestId('identity-liveness-limitation').textContent()).toContain(
      'A video of you or a good mask can pass it'
    )
    await evidence('04-face-verified-liveness', 'identity-assurance')
    // Verified — and deleting a file still waits for its own permission, and is denied here.
    const pending = invoke(
      page,
      envelope('files.delete', {
        location: { root: 'documents', path: 'report.txt' },
        missionId: null
      })
    )
    expect(await answerDialog('permission-deny')).toEqual(['files.delete'])
    const asked = await pending
    expect(asked.ok).toBe(false)
    if (!asked.ok) expect(asked.error.code).toBe('PERMISSION_REQUIRED')
    expect(existsSync(join(filesFolder, 'documents', 'report.txt'))).toBe(true)
    expect(await level()).toBe('VERIFIED')
  })

  it('AT4 + AT9: with protection on, locking Windows ends the verification and protected actions are refused', async () => {
    await openIdentity()
    if ((await level()) !== 'VERIFIED') await verifyWithFace()
    // The switch follows Core: it turns on once Core has turned protection on.
    await page.getByTestId('identity-protection').click()
    await expect.poll(() => page.getByTestId('identity-protection').isChecked()).toBe(true)
    expect(await page.getByTestId('identity-requirements').textContent()).toContain('memory.read')
    await evidence('05-protection-on', 'identity-protection-card')
    // The computer is locked (Electron's powerMonitor, as Windows reports it).
    await jupiter.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('lock-screen')
    })
    await expect.poll(level).toBe('UNKNOWN')
    expect(await page.getByTestId('identity-reason').textContent()).toMatch(/locked/i)
    const refused = await invoke(page, envelope('memory.search', MEMORY_QUERY))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('IDENTITY_REQUIRED')
    // Turning protection off is refused too while nobody is verified.
    await page.getByTestId('identity-protection').click()
    await expect
      .poll(() => page.getByTestId('identity-error').getAttribute('data-code'))
      .toBe('IDENTITY_REQUIRED')
    expect(await page.getByTestId('identity-protection').isChecked()).toBe(true)
    await evidence('06-locked-refused', 'identity-assurance')
  })

  it('AT6: a critical action needs Windows Hello — face alone is not enough', async () => {
    await openIdentity()
    await verifyWithFace()
    await expect.poll(level).toBe('VERIFIED')
    const status = await query(page, 'identity.status', {})
    expect(status.protection).toBe(true)
    // Deleting files is CRITICAL: it needs STRONG_VERIFIED, which only Windows Hello gives.
    const refused = await invoke(
      page,
      envelope('files.delete', {
        location: { root: 'documents', path: 'report.txt' },
        missionId: null
      })
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.code).toBe('IDENTITY_REQUIRED')
      expect(refused.error.message).toMatch(/Windows Hello/)
    }
    // Nothing was asked and nothing was deleted.
    expect(await page.getByTestId('permission-dialog').isVisible()).toBe(false)
    expect(existsSync(join(filesFolder, 'documents', 'report.txt'))).toBe(true)
    await evidence('07-critical-needs-hello', 'identity-assurance')
  })

  it('AT7: Face Identity data is deleted and can no longer be used', async () => {
    await openIdentity()
    if ((await level()) !== 'VERIFIED') await verifyWithFace()
    await page.getByTestId('identity-face-delete').click()
    await evidence('08-delete-confirm')
    await page.getByTestId('identity-face-delete-dialog').getByTestId('confirm-ok').click()
    await expect
      .poll(() => page.getByTestId('identity-face-enrolled').getAttribute('data-enrolled'))
      .toBe('false')
    expect(await level()).toBe('UNKNOWN')
    const face = (await query(page, 'identity.status', {})).methods.find(
      (method) => method.method === 'face'
    )
    expect(face).toMatchObject({ enrolled: false, enabled: false, samples: 0 })
    // With no template there is nothing to check a face against.
    expect(await page.getByTestId('identity-face-verify').count()).toBe(0)
    await evidence('09-face-deleted', 'identity-face')
  })

  it('AT8: the log never holds a face descriptor, a score or an image', () => {
    const { text } = readLog(userDataDir)
    expect(text).toContain('identity')
    expect(text).not.toMatch(/descriptor/i)
    expect(text).not.toMatch(/-?0\.\d{6,}(,\s*-?0\.\d{6,}){7,}/)
    expect(text).not.toMatch(/iVBORw0KGgo/)
  })
})
