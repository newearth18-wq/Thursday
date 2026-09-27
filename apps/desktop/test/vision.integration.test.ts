import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import {
  nonLoopbackAddress,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import { VISION_FIXTURES, visionFixturePath } from '@jupiter/testing/vision'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { VisionHost } from '../src/main/vision-host'
import { appDirectory, assertBuilt, query, waitForGateway } from './helpers'

/**
 * SET 13 in the real application: screen capture with Electron (under Xvfb
 * on Linux), Chromium's fake camera behind the real permission and camera
 * gate, the real OCR (Tesseract) and QR (zbar) engines, and vision models
 * behind protocol test servers (one on a non-loopback address, so it counts
 * as the cloud). Screenshots go to test-results/set-13/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-13')
const logger = Logger.create({ sessionId: uuidv7(), level: 'warn', sinks: [new MemorySink()] })

let local: ProtocolServer
let cloud: ProtocolServer
let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page
const providers: Record<'local' | 'cloud', string> = { local: '', cloud: '' }

const MODEL_ANSWER = JSON.stringify({
  summary: 'A test form with an invoice total and a Submit button.',
  answer: '42.50 EUR',
  confidence: 0.82,
  elements: [{ kind: 'button', label: 'Submit', box: [40, 270, 200, 60], confidence: 0.91 }]
})

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('This test needs a non-loopback network interface for the "cloud" server')
  local = await startOpenAiCompatibleServer()
  cloud = await startOpenAiCompatibleServer({ host: address })
  userDataDir = await createTempDir('jupiter-set13')
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_FAKE_CAMERA: '1' }
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
  // Vision models, as a person sets them up in AI Models.
  for (const [server, name, key] of [
    [local, 'Local vision', 'local'],
    [cloud, 'Cloud vision', 'cloud']
  ] as const) {
    server.setModels([{ id: 'vision-model' }])
    const provider = await query(page, 'ai.providers.add', {
      adapterId: 'openai-compatible',
      displayName: name,
      baseUrl: server.baseUrl
    })
    providers[key] = provider.providerId
    await query(page, 'ai.providers.check', { providerId: provider.providerId })
    await query(page, 'ai.models.update', {
      providerId: provider.providerId,
      modelId: 'vision-model',
      enabled: true,
      capabilities: ['vision']
    })
  }
  // Local only: the cloud model is set up, but must never be used.
  await query(page, 'settings.update', { key: 'ai.routingMode', value: 'LOCAL_ONLY' })
  cloud.reset()
}, 120_000)

afterAll(async () => {
  await jupiter.close()
  await local.close()
  await cloud.close()
  await removeDir(userDataDir)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function evidence(name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function openTab(tab: 'vision' | 'camera'): Promise<void> {
  await page.getByTestId('nav-devices').click()
  await page.getByTestId('devices-tabs').waitFor()
  await page.getByTestId(`tab-${tab}`).click()
  await page.getByTestId(tab === 'vision' ? 'vision-panel' : 'camera-panel').waitFor()
}

/** Answers every permission request the dialog shows, as the person would. */
async function answerDialog(
  first?: string,
  button = 'permission-allow-session'
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
    capabilities.push((await prompt.getByTestId('permission-capability').textContent()) ?? '')
    await prompt.getByTestId(button).click()
    await prompt.waitFor({ state: 'hidden' })
  }
  return capabilities
}

/** Whatever the renderer asks, the camera is refused unless Core opened the camera gate. */
function tryCamera(): Promise<string> {
  return page.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ video: true }).then(
      (stream) => {
        for (const track of stream.getTracks()) track.stop()
        return 'granted'
      },
      (error: unknown) => (error instanceof Error ? error.name : 'error')
    )
  )
}

/** The images Jupiter holds, newest last. */
async function images() {
  return (await query(page, 'vision.status', {})).images
}

describe('SET 13 — Vision and Camera, in the real application', () => {
  it('shows each engine and where it runs; face detection is Coming later; the camera is refused while off', async () => {
    await openTab('vision')
    const engines = page.getByTestId('vision-engines')
    await expect
      .poll(() => engines.getByTestId('vision-engine-ocr').getAttribute('data-available'))
      .toBe('true')
    expect(await page.getByTestId('vision-locality-ocr').getAttribute('data-locality')).toBe(
      'this-device'
    )
    expect(await page.getByTestId('vision-locality-model').getAttribute('data-locality')).toBe(
      'this-device'
    )
    expect(
      await engines
        .getByTestId('vision-engine-faces')
        .locator('[data-availability="COMING_LATER"]')
        .count()
    ).toBe(1)
    expect(
      await page
        .getByTestId('vision-want-faces')
        .isDisabled()
        .catch(() => true)
    ).toBe(true)
    expect(await page.getByTestId('indicator-camera').count()).toBe(0)
    expect(await tryCamera()).toBe('NotAllowedError')
    await evidence('01-vision-engines')
  })

  it('AT1: the screen is captured — after the permission — and held in memory', async () => {
    await openTab('vision')
    await page.getByTestId('vision-capture-desktop').click()
    expect(await answerDialog('02-screen-permission')).toEqual(['computer.read_screen'])
    await expect.poll(async () => (await images()).length).toBe(1)
    const [shot] = await images()
    const display = await jupiter.app.evaluate(({ screen }) => {
      const primary = screen.getPrimaryDisplay()
      return {
        width: Math.round(primary.size.width * primary.scaleFactor),
        height: Math.round(primary.size.height * primary.scaleFactor)
      }
    })
    expect(shot).toMatchObject({ source: 'desktop', stored: 'memory', ...display, window: null })
    // The preview is drawn from the image Core holds.
    const preview = page.getByTestId('vision-analyze').getByTestId('vision-preview')
    await expect.poll(() => preview.getAttribute('data-state')).toBe('shown')
    await evidence('03-screen-captured')
  })

  it('AT2: the active window is captured, and says which window it is', async () => {
    await openTab('vision')
    await page.getByTestId('vision-delay').selectOption('0')
    await page.getByTestId('vision-capture-window').click()
    await answerDialog()
    await expect.poll(async () => (await images()).length).toBe(2)
    const shot = (await images()).at(-1)
    expect(shot).toMatchObject({
      source: 'active-window',
      window: { owner: 'jupiter' }
    })
    // The window's real title, as the window shows it.
    expect(shot?.window?.title).toBe(await page.title())
    const size = await jupiter.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const bounds = window?.getContentBounds()
      return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 }
    })
    // The window's own content, not the screen around it.
    expect(Math.abs((shot?.width ?? 0) - size.width)).toBeLessThanOrEqual(size.width * 0.1 + 2)
    const text = await query(page, 'vision.analyze', {
      imageId: shot?.imageId ?? '',
      tasks: ['text'],
      question: null,
      redact: []
    })
    // What OCR reads in Jupiter's own window is really there.
    expect(text.detectedText?.text).toMatch(/Devices|Vision/)
    await evidence('04-active-window')
  })

  it('AT3: an image the person chooses gets a structured observation — text and QR here, the model on this computer', async () => {
    await openTab('vision')
    local.enqueue({ chunks: [MODEL_ANSWER] })
    const before = (await images()).length
    await page.getByTestId('vision-upload').setInputFiles(visionFixturePath('form'))
    await expect.poll(async () => (await images()).length).toBe(before + 1)
    const newest = (await images()).at(-1)?.imageId ?? ''
    const card = page.locator(`[data-testid="vision-analyze"][data-image-id="${newest}"]`)
    await card.getByTestId('vision-want-describe').check()
    await card.getByTestId('vision-want-elements').check()
    await card.getByTestId('vision-question').fill('What is the invoice total?')
    await expect
      .poll(() => card.getByTestId('vision-preview').getAttribute('data-state'))
      .toBe('shown')
    await card.getByTestId('vision-analyze-run').click()
    const observation = card.getByTestId('vision-observation')
    await observation.waitFor({ timeout: 60_000 })
    for (const task of ['text', 'qr', 'describe', 'elements'])
      expect(await card.getByTestId(`vision-task-${task}`).getAttribute('data-status'), task).toBe(
        'done'
      )
    expect(await card.getByTestId('vision-text-lines').textContent()).toContain(
      VISION_FIXTURES.form.total
    )
    expect(await card.getByTestId('vision-summary').textContent()).toBe(
      'A test form with an invoice total and a Submit button.'
    )
    expect(await card.getByTestId('vision-answer').textContent()).toContain('42.50 EUR')
    expect(await card.getByTestId('vision-untrusted').count()).toBe(1)
    expect(
      Number(await card.getByTestId('vision-confidence').getAttribute('data-confidence'))
    ).toBeLessThanOrEqual(0.82)
    // Privacy: the password line was blacked out before the model saw the image.
    expect(Number(await card.getByTestId('vision-redactions').getAttribute('data-count'))).toBe(1)
    const sentTo = await card
      .getByTestId('vision-sent-to')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-locality')))
    expect(sentTo.every((where) => where === 'this-device')).toBe(true)
    const request = local.requests.find((item) => item.path === '/v1/chat/completions')
    const body = request?.body as { messages: { content: unknown }[] } | undefined
    const image = body?.messages
      .flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as { type: string; image_url?: { url: string } }[])
          : []
      )
      .find((part) => part.type === 'image_url')
    const seen = await new VisionHost({ logger, capturer: null }).ocr({
      data: (image?.image_url?.url ?? '').split(',')[1] ?? ''
    })
    const seenText = seen.lines.map((line) => line.text).join(' ')
    expect(seenText).toContain('Invoice total')
    expect(seenText).not.toContain('river-lantern')
    await observation.scrollIntoViewIfNeeded()
    await evidence('05-observation')
    // A QR code the person chooses is read on this computer.
    await page.getByTestId('vision-upload').setInputFiles(visionFixturePath('qr'))
    await expect.poll(async () => (await images()).length).toBe(before + 2)
    const qrImage = (await images()).at(-1)?.imageId ?? ''
    const qrCard = page.locator(`[data-testid="vision-analyze"][data-image-id="${qrImage}"]`)
    await qrCard.getByTestId('vision-want-text').uncheck()
    await qrCard.getByTestId('vision-analyze-run').click()
    await qrCard.getByTestId('vision-qr-codes').waitFor({ timeout: 60_000 })
    expect(await qrCard.getByTestId('vision-qr-codes').textContent()).toContain(
      VISION_FIXTURES.qr.value
    )
  })

  it('AT4 + AT5 + AT6: the camera asks first, the indicator is right, and closing releases it', async () => {
    await openTab('camera')
    expect(await page.getByTestId('camera-state').getAttribute('data-state')).toBe('OFF')
    await page.getByTestId('camera-start').click()
    // AT4: nothing starts until the person allows it.
    const prompt = page.getByTestId('permission-dialog')
    await prompt.waitFor()
    expect(await page.getByTestId('indicator-camera').count()).toBe(0)
    expect(await tryCamera()).toBe('NotAllowedError')
    expect(await answerDialog('06-camera-permission', 'permission-allow-once')).toEqual([
      'camera.read'
    ])
    // AT5: ACTIVE and the indicator on, once the real track runs.
    const indicator = page.getByTestId('indicator-camera')
    await indicator.waitFor()
    await expect
      .poll(() => page.getByTestId('camera-state').getAttribute('data-state'))
      .toBe('ACTIVE')
    expect(await indicator.getAttribute('data-state')).toBe('on')
    const preview = page.getByTestId('camera-preview')
    await expect
      .poll(() => preview.evaluate((canvas) => (canvas as HTMLCanvasElement).width))
      .toBeGreaterThan(0)
    await evidence('07-camera-on')
    // A frame goes to Core, in memory.
    await page.getByTestId('camera-capture').click()
    await page.getByTestId('camera-analyze').waitFor()
    expect((await images()).filter((image) => image.source === 'camera')).toHaveLength(1)
    await page.getByTestId('camera-pause').click()
    await expect
      .poll(() => page.getByTestId('camera-state').getAttribute('data-state'))
      .toBe('PAUSED')
    expect(await indicator.getAttribute('data-state')).toBe('paused')
    await evidence('08-camera-paused')
    await page.getByTestId('camera-resume').click()
    await expect
      .poll(() => page.getByTestId('camera-state').getAttribute('data-state'))
      .toBe('ACTIVE')
    // AT6: closing stops the track, closes the gate and drops the frames.
    await page.getByTestId('camera-close').click()
    await indicator.waitFor({ state: 'detached' })
    await expect.poll(() => page.getByTestId('camera-state').getAttribute('data-state')).toBe('OFF')
    expect(await tryCamera()).toBe('NotAllowedError')
    expect((await images()).filter((image) => image.source === 'camera')).toHaveLength(0)
    const sessions = (
      await query(page, 'events.list', {
        afterSequence: null,
        limit: 50,
        filter: { types: ['camera.session'], streams: null, missionId: null }
      })
    ).events.map((event) => event.payload as { change: string; frames: number })
    expect(sessions.map((session) => session.change)).toEqual(['started', 'ended'])
    expect(sessions[1]?.frames).toBe(1)
    await evidence('09-camera-closed')
  })

  it('AT9: a comparison of captures that are not of the same target is never verified', async () => {
    await openTab('vision')
    await page.getByTestId('vision-upload').setInputFiles(visionFixturePath('before'))
    await page.getByTestId('vision-upload').setInputFiles(visionFixturePath('after'))
    await expect
      .poll(async () => (await images()).filter((image) => image.source === 'upload').length)
      .toBeGreaterThanOrEqual(4)
    const uploads = (await images()).filter((image) => image.source === 'upload')
    const compare = page.getByTestId('vision-compare')
    await compare.getByTestId('vision-compare-before').selectOption(uploads.at(-2)?.imageId ?? '')
    await compare.getByTestId('vision-compare-after').selectOption(uploads.at(-1)?.imageId ?? '')
    await compare.getByTestId('vision-compare-text').fill('Hello Jupiter')
    await compare.getByTestId('vision-compare-run').click()
    const result = compare.getByTestId('vision-compare-result')
    await result.waitFor()
    expect(await result.getAttribute('data-verified')).toBe('false')
    expect(await result.textContent()).toContain('do not show the same window')
    await compare.scrollIntoViewIfNeeded()
    await evidence('10-not-verified')
  })

  it('AT7 + AT10: nothing is saved, and with Local only no image reaches a cloud vision model', async () => {
    // Only the cloud model is left: Local only must refuse it, and say so.
    await query(page, 'ai.models.update', {
      providerId: providers.local,
      modelId: 'vision-model',
      enabled: false,
      capabilities: ['vision']
    })
    cloud.reset()
    await openTab('vision')
    await expect
      .poll(() => page.getByTestId('vision-engine-model').getAttribute('data-available'))
      .toBe('false')
    const count = (await images()).length
    await page.getByTestId('vision-upload').setInputFiles(visionFixturePath('form'))
    await expect.poll(async () => (await images()).length).toBe(count + 1)
    const newest = (await images()).at(-1)?.imageId ?? ''
    const card = page.locator(`[data-testid="vision-analyze"][data-image-id="${newest}"]`)
    await expect
      .poll(() => card.getByTestId('vision-preview').getAttribute('data-state'))
      .toBe('shown')
    await card.getByTestId('vision-want-describe').check()
    expect(await card.getByTestId('vision-model-note').textContent()).toContain(
      'No vision model can be used'
    )
    await card.getByTestId('vision-analyze-run').click()
    await card.getByTestId('vision-observation').waitFor({ timeout: 60_000 })
    expect(await card.getByTestId('vision-task-describe').getAttribute('data-status')).toBe(
      'unavailable'
    )
    expect(await card.getByTestId('vision-task-text').getAttribute('data-status')).toBe('done')
    expect(cloud.connections()).toBe(0)
    expect(cloud.requests).toEqual([])
    await card.getByTestId('vision-observation').scrollIntoViewIfNeeded()
    await evidence('11-local-only')
    // AT7: no image, and no text read from one, is in Jupiter's files.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const kept: Buffer[] = []
    for (const name of readdirSync(userDataDir))
      if (name.startsWith('jupiter.db')) kept.push(readFileSync(join(userDataDir, name)))
    for (const name of readdirSync(join(userDataDir, 'logs')))
      kept.push(readFileSync(join(userDataDir, 'logs', name)))
    const all = Buffer.concat(kept)
    expect(all.includes(png)).toBe(false)
    expect(all.includes(Buffer.from('Invoice total'))).toBe(false)
    expect(all.includes(Buffer.from('river-lantern'))).toBe(false)
    expect(
      readdirSync(userDataDir).filter((name) => /\.(png|jpe?g|bmp|webp)$/i.test(name))
    ).toEqual([])
  })
})
