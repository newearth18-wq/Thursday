import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import {
  nonLoopbackAddress,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import { VOICE_FIXTURES, voiceFixturePath } from '@jupiter/testing/voice'
import type { Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, query, waitForGateway } from './helpers'

/**
 * SET 12 in the real application: the real microphone path (host gate,
 * Chromium permission, getUserMedia) with Chromium's fake microphone playing
 * a real speech recording, the real system voice (espeak-ng on Linux,
 * Windows SAPI on Windows), and speech models behind protocol test servers.
 * Screenshots go to test-results/set-12/.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-12')

let local: ProtocolServer
let cloud: ProtocolServer
let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('This test needs a non-loopback network interface for the "cloud" server')
  local = await startOpenAiCompatibleServer()
  cloud = await startOpenAiCompatibleServer({ host: address })
  userDataDir = await createTempDir('jupiter-set12')
  jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: 'en-US',
    env: { JUPITER_TEST_FAKE_AUDIO: voiceFixturePath('en-question') }
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
  // Speech models, as a person sets them up in AI Models: chat, speech to text, text to speech.
  for (const [server, name] of [
    [local, 'Local speech'],
    [cloud, 'Cloud speech']
  ] as const) {
    server.setModels([{ id: 'test-model' }, { id: 'stt-model' }, { id: 'tts-model' }])
    const provider = await query(page, 'ai.providers.add', {
      adapterId: 'openai-compatible',
      displayName: name,
      baseUrl: server.baseUrl
    })
    await query(page, 'ai.providers.check', { providerId: provider.providerId })
    for (const [modelId, capability] of [
      ['test-model', 'chat'],
      ['stt-model', 'transcription'],
      ['tts-model', 'speech']
    ] as const)
      await query(page, 'ai.models.update', {
        providerId: provider.providerId,
        modelId,
        enabled: true,
        capabilities: [capability]
      })
  }
  // Prefer the cloud engines: Local only must still keep every request on this computer (AT10).
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

async function openDevices(): Promise<void> {
  await page.getByTestId('nav-devices').click()
  await page.getByTestId('voice-status').waitFor()
}

async function voiceState(): Promise<string | null> {
  return page.getByTestId('voice-state').getAttribute('data-state')
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

/** Whatever the renderer asks, the microphone is refused unless Core opened the gate. */
function tryMicrophone(): Promise<string> {
  return page.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        for (const track of stream.getTracks()) track.stop()
        return 'granted'
      },
      (error: unknown) => (error instanceof Error ? error.name : 'error')
    )
  )
}

/** Jupiter's own files in the profile (the database, its WAL and the logs). */
function jupiterFiles(): string {
  const parts: string[] = []
  for (const name of readdirSync(userDataDir))
    if (name.startsWith('jupiter.db'))
      parts.push(readFileSync(join(userDataDir, name)).toString('latin1'))
  for (const name of readdirSync(join(userDataDir, 'logs')))
    parts.push(readFileSync(join(userDataDir, 'logs', name)).toString('utf8'))
  return parts.join('\n')
}

async function pushToTalk(holdMs: number): Promise<void> {
  const button = page.getByTestId('voice-ptt')
  await button.focus()
  await page.keyboard.press('Space')
  await page.getByTestId('indicator-microphone').waitFor()
  await page.waitForTimeout(holdMs)
  await page.keyboard.press('Space')
}

describe('SET 12 — Voice System, in the real application', () => {
  it('AT6: with voice off there is no microphone, no stream and no control that looks like it works', async () => {
    await openDevices()
    expect(await voiceState()).toBe('DISABLED')
    expect(await page.getByTestId('voice-enabled').isChecked()).toBe(false)
    expect(await page.getByTestId('voice-ptt').isDisabled()).toBe(true)
    expect(await page.getByTestId('top-voice-ptt').count()).toBe(0)
    expect(await page.getByTestId('indicator-microphone').count()).toBe(0)
    // Even the interface itself cannot open the microphone.
    expect(await tryMicrophone()).toBe('NotAllowedError')
    // The camera is SET 13: labelled, with nothing to press.
    const camera = page.getByTestId('devices-camera')
    expect(await camera.locator('[data-availability="COMING_LATER"]').count()).toBe(1)
    expect(await camera.locator('button, input, select').count()).toBe(0)
    await evidence('01-voice-off')
  })

  it('AT1: the person chooses the microphone and speaker; the chosen microphone is the one used', async () => {
    await openDevices()
    // The switch shows Core's saved setting, so it changes once Core has saved it.
    await page.getByTestId('voice-enabled').click()
    await expect.poll(() => page.getByTestId('voice-enabled').isChecked()).toBe(true)
    await expect.poll(voiceState).toBe('IDLE')
    // Engines say where they run before anything is used: Local only keeps them on this computer.
    expect(await page.getByTestId('voice-locality-stt').getAttribute('data-locality')).toBe(
      'this-device'
    )
    await page.getByTestId('voice-reveal-devices').click()
    expect(await answerDialog('02-microphone-permission')).toEqual(['microphone.listen'])
    const inputs = page.getByTestId('voice-input-device').locator('option')
    await expect.poll(() => inputs.count()).toBeGreaterThan(2)
    const labels = await inputs.evaluateAll((options) =>
      options.map((option) => ({
        value: (option as HTMLOptionElement).value,
        label: option.textContent
      }))
    )
    const chosen =
      labels.find((option) => option.value && option.label.includes('Fake Audio Input 2')) ??
      labels[labels.length - 1]
    if (!chosen) throw new Error('No microphone to choose')
    await page.getByTestId('voice-input-device').selectOption(chosen.value)
    const outputs = page.getByTestId('voice-output-device').locator('option')
    await expect.poll(() => outputs.count()).toBeGreaterThan(1)
    const speaker = await outputs.nth(1).getAttribute('value')
    await page.getByTestId('voice-output-device').selectOption(speaker ?? '')
    await expect
      .poll(async () =>
        (await query(page, 'settings.list', {})).settings
          .filter(
            (record) => record.key === 'voice.inputDevice' || record.key === 'voice.outputDevice'
          )
          .map((record) => record.value)
      )
      .toEqual([chosen.value, speaker])
    await evidence('03-devices-chosen')
    // The chosen microphone is the one that turns on (the indicator names it while it is on).
    local.transcribe({ text: '' })
    await page.getByTestId('voice-ptt').focus()
    await page.keyboard.press('Space')
    const indicator = page.getByTestId('indicator-microphone')
    await indicator.waitFor()
    await expect.poll(() => indicator.getAttribute('data-device')).toBe(chosen.label)
    await page.keyboard.press('Space')
    await indicator.waitFor({ state: 'detached' })
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('IDLE')
  })

  it('AT2 + AT3 + AT4 + AT10: Push-to-Talk shows it is listening, gets a real transcript, and speaks the answer — all on this computer', async () => {
    await openDevices()
    local.reset()
    local.setModels([{ id: 'test-model' }, { id: 'stt-model' }, { id: 'tts-model' }])
    cloud.reset()
    local.transcribe({ text: VOICE_FIXTURES['en-question'], language: 'english' })
    local.enqueue({ chunks: ['Jupiter is the largest planet in the Solar System.'] })
    const button = page.getByTestId('voice-ptt')
    await button.focus()
    await page.keyboard.press('Space')
    // AT2: the indicator and the state show listening only while the microphone is on.
    const indicator = page.getByTestId('indicator-microphone')
    await indicator.waitFor()
    await expect.poll(voiceState).toBe('LISTENING')
    expect(await button.getAttribute('aria-pressed')).toBe('true')
    await evidence('04-listening')
    await page.waitForTimeout(5_000)
    await page.keyboard.press('Space')
    await indicator.waitFor({ state: 'detached' })
    // AT3: the engine got the real recording from the microphone, and its transcript is shown.
    await expect.poll(() => local.audio.length).toBe(1)
    const received = local.audio[0]?.wav
    expect(received).toMatchObject({ sampleRate: 16_000, channels: 1 })
    expect(received?.durationMs).toBeGreaterThan(4_000)
    expect(received?.rms).toBeGreaterThan(0.005)
    await expect
      .poll(() => page.getByTestId('voice-transcript').textContent())
      .toBe('What is the largest planet?')
    // AT4: the answer is spoken — SPEAKING while the audio really plays, then Ready.
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('SPEAKING')
    await evidence('05-speaking')
    expect(await page.getByTestId('voice-reply').textContent()).toBe(
      'Jupiter is the largest planet in the Solar System.'
    )
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('IDLE')
    // AT10: Local only — not one request reached the cloud server.
    expect(cloud.connections()).toBe(0)
    await evidence('06-answered')
  })

  it('AT5: the person interrupts Jupiter while it speaks, and it stops at once', async () => {
    await openDevices()
    await query(page, 'voice.speak', {
      text: 'Jupiter is the fifth planet from the Sun and the largest in the Solar System. It is a gas giant with a mass more than two and a half times that of all the other planets combined.',
      language: 'en'
    })
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('SPEAKING')
    const stop = page.getByTestId('top-voice-stop')
    await stop.waitFor()
    await evidence('07-stop-button')
    const clicked = Date.now()
    await stop.click()
    await expect.poll(voiceState, { timeout: 2_000 }).toBe('IDLE')
    expect(Date.now() - clicked).toBeLessThan(2_000)
    expect(await stop.count()).toBe(0)
    // Escape does the same.
    await query(page, 'voice.speak', {
      text: 'A second long answer about the moons of Jupiter, Io, Europa, Ganymede and Callisto, which Galileo found.',
      language: 'en'
    })
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('SPEAKING')
    await page.keyboard.press('Escape')
    await expect.poll(voiceState, { timeout: 2_000 }).toBe('IDLE')
  })

  it('AT7: an engine failure is shown and recovered from without restarting Jupiter', async () => {
    await openDevices()
    local.failAll(503)
    await pushToTalk(1_500)
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('ERROR')
    const error = page.getByTestId('voice-error')
    await error.waitFor()
    expect(await error.getAttribute('data-code')).toBe('PROVIDER_SERVER_ERROR')
    await evidence('08-error')
    local.failAll(null)
    await page.getByTestId('voice-recover').click()
    await expect.poll(voiceState).toBe('IDLE')
    local.transcribe({ text: VOICE_FIXTURES['en-question'], language: 'en' })
    local.enqueue({ chunks: ['Jupiter.'] })
    await pushToTalk(2_000)
    await expect
      .poll(() => page.getByTestId('voice-reply').textContent(), { timeout: 30_000 })
      .toBe('Jupiter.')
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('IDLE')
  })

  it('AT8 + AT9: Thai is handled by the configured engines, and no recording or transcript is kept', async () => {
    await openDevices()
    // Where the system has no Thai voice (Windows), the speech model speaks Thai.
    local.setSpeech(readFileSync(voiceFixturePath('th-question')))
    await page.getByTestId('voice-language').selectOption('th')
    await expect
      .poll(
        async () =>
          (await query(page, 'settings.list', {})).settings.find(
            (record) => record.key === 'voice.language'
          )?.value
      )
      .toBe('th')
    local.transcribe({ text: VOICE_FIXTURES['th-question'], language: 'th' })
    local.enqueue({ chunks: ['ดาวพฤหัสบดีเป็นดาวเคราะห์ที่ใหญ่ที่สุด'] })
    const before = local.audio.length
    await pushToTalk(3_000)
    await expect
      .poll(() => page.getByTestId('voice-transcript').textContent(), { timeout: 30_000 })
      .toBe(VOICE_FIXTURES['th-question'])
    expect(local.audio[before]?.language).toBe('th')
    await expect
      .poll(() => page.getByTestId('voice-reply').textContent(), { timeout: 30_000 })
      .toBe('ดาวพฤหัสบดีเป็นดาวเคราะห์ที่ใหญ่ที่สุด')
    await expect.poll(voiceState, { timeout: 30_000 }).toBe('IDLE')
    await evidence('09-thai')
    // AT9: Jupiter's files hold no audio and none of what was said or answered.
    const kept = jupiterFiles()
    expect(kept).not.toContain('RIFF')
    for (const text of [
      'What is the largest planet',
      'ดาวเคราะห์ดวงใหญ่ที่สุด',
      'ดาวพฤหัสบดีเป็นดาวเคราะห์',
      'largest planet in the Solar System'
    ])
      expect(kept, text).not.toContain(text)
    expect(readdirSync(userDataDir).filter((name) => /\.(wav|mp3|webm|ogg)$/i.test(name))).toEqual(
      []
    )
    await page.getByTestId('voice-language').selectOption('auto')
  })

  it('AT6: turning voice off while listening turns the microphone off at once', async () => {
    await openDevices()
    await page.getByTestId('voice-ptt').focus()
    await page.keyboard.press('Space')
    await page.getByTestId('indicator-microphone').waitFor()
    await page.getByTestId('voice-enabled').click()
    await page.getByTestId('indicator-microphone').waitFor({ state: 'detached' })
    await expect.poll(voiceState).toBe('DISABLED')
    expect(await tryMicrophone()).toBe('NotAllowedError')
    await evidence('10-voice-off-again')
  })
})
