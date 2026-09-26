import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import {
  nonLoopbackAddress,
  startAnthropicServer,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import type { Locator, Page } from 'playwright'
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
 * SET 3 acceptance tests against the real application: real Electron and
 * renderer, Jupiter Core in its utility process, the real adapters, the OS
 * secure storage (on Linux: GNOME Keyring through the Secret Service, started
 * by scripts/with-display.mjs), and real HTTP servers that speak the provider
 * protocols. Everything is driven through the interface a person uses.
 * Screenshots are written to test-results/set-03/ as evidence.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-03')
const KEY = fakeCredentials().find((item) => item.patternId === 'anthropic-api-key')?.value ?? ''
const WRONG_KEY = `${KEY.slice(0, -8)}Wr0ngKey`

let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page
/** An OpenAI-compatible model server on this computer (no key). */
let local: ProtocolServer
/** An Anthropic-protocol server on this computer that requires a key. */
let keyed: ProtocolServer
/** An OpenAI-compatible server on a non-loopback address: a "cloud" endpoint. */
let cloud: ProtocolServer

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  const address = nonLoopbackAddress()
  if (!address) throw new Error('the SET 3 tests need a non-loopback network interface')
  local = await startOpenAiCompatibleServer()
  keyed = await startAnthropicServer()
  cloud = await startOpenAiCompatibleServer({ host: address })
  local.setModels([{ id: 'local-chat', name: 'Local Chat' }])
  keyed.setModels([{ id: 'keyed-chat', name: 'Keyed Chat' }])
  keyed.requireKey(KEY)
  cloud.setModels([{ id: 'cloud-chat', name: 'Cloud Chat' }])
  userDataDir = await createTempDir('jupiter-set03')
  jupiter = await launch()
  page = jupiter.window
})

afterAll(async () => {
  await jupiter.close()
  await local.close()
  await keyed.close()
  await cloud.close()
  await removeDir(userDataDir)
})

// A failed step leaves a screenshot of the window as it was, next to the evidence.
afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function launch(): Promise<LaunchedJupiter> {
  const launched = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 960)
  })
  // Jupiter reopens the last screen, so wait on the runtime itself rather than on Home.
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

function providerCard(name: string): Locator {
  return page.getByTestId('provider').filter({ has: page.getByRole('heading', { name }) })
}

async function addProvider(options: {
  adapterId: string
  name: string
  url: string
  key?: string
}): Promise<Locator> {
  await open('models')
  await page.getByTestId('provider-add').click()
  const dialog = page.getByTestId('provider-add-dialog')
  await dialog.getByTestId('provider-adapter').selectOption(options.adapterId)
  await dialog.getByTestId('provider-name').fill(options.name)
  await dialog.getByTestId('provider-url').fill(options.url)
  if (options.key) await dialog.getByTestId('provider-add-key').fill(options.key)
  await dialog.getByTestId('provider-add-save').click()
  await expect.poll(() => dialog.isVisible()).toBe(false)
  const card = providerCard(options.name)
  await card.waitFor()
  return card
}

/** Choose "Chat" as the model's capability and start using it — both are the person's choices. */
async function useForChat(card: Locator, modelId: string): Promise<void> {
  const row = card.locator(`[data-testid="model-row"][data-model-id="${modelId}"]`)
  await row.waitFor()
  const chat = row.getByTestId('capability-chat')
  if (!(await chat.isChecked())) await chat.check()
  await expect.poll(() => row.getByTestId('model-enabled').isEnabled()).toBe(true)
  await row.getByTestId('model-enabled').check()
  await expect.poll(() => row.getAttribute('data-enabled')).toBe('true')
}

async function setModelEnabled(card: Locator, modelId: string, enabled: boolean): Promise<void> {
  const row = card.locator(`[data-testid="model-row"][data-model-id="${modelId}"]`)
  await row.getByTestId('model-enabled').setChecked(enabled)
  await expect.poll(() => row.getAttribute('data-enabled')).toBe(String(enabled))
}

function answers(): Locator {
  return page.locator('[data-testid="chat-message"][data-role="assistant"][data-replaced="false"]')
}

async function send(text: string, composer = 'chat-view-composer'): Promise<void> {
  const form = page.getByTestId(composer)
  await expect.poll(() => form.getAttribute('data-availability')).toBe('available')
  await form.getByTestId(`${composer}-input`).fill(text)
  await form.getByTestId(`${composer}-send`).click()
  // Sent from Home, the new conversation opens in Chat; in Chat, the composer empties.
  if (composer === 'chat-composer') await page.getByTestId('view-chat').waitFor()
  else await expect.poll(() => form.getByTestId(`${composer}-input`).inputValue()).toBe('')
}

async function lastAnswerStatus(): Promise<string | null> {
  return answers().last().getAttribute('data-status')
}

function chatRequests(server: ProtocolServer) {
  return server.requests.filter((request) => request.method === 'POST')
}

async function selectRoutingMode(mode: string): Promise<void> {
  await open('models')
  await page.getByTestId(`routing-mode-${mode}`).check()
  await expect
    .poll(() => page.getByTestId('routing-save-status').getAttribute('data-state'))
    .toBe('saved')
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    const stats = statSync(path, { throwIfNoEntry: false })
    if (!stats) return []
    if (stats.isDirectory()) return filesUnder(path)
    // Sockets and other special files hold no stored data.
    return stats.isFile() ? [path] : []
  })
}

function dumpDatabase(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    return tables
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all()))
      .join('\n')
  } finally {
    db.close()
  }
}

describe('SET 3 — AI providers, Model Router and Chat, in the real application', () => {
  it('starts with no model and says so: the composer is Not configured, with the way to fix it', async () => {
    const composer = page.getByTestId('chat-composer')
    await expect.poll(() => composer.getAttribute('data-availability')).toBe('NOT_CONFIGURED')
    expect(await composer.getByTestId('chat-composer-input').isDisabled()).toBe(true)
    expect(await composer.getByTestId('chat-composer-send').isDisabled()).toBe(true)
    expect(await composer.getByTestId('chat-composer-reason').textContent()).toContain(
      'Not configured'
    )
    await composer.getByTestId('chat-composer-configure').click()
    await page.getByTestId('view-models').waitFor()
    expect(await page.getByTestId('providers-empty').textContent()).toContain('Not configured')
    // The keys' storage is the operating system's, and the screen says which one.
    const storage = page.getByTestId('secure-storage')
    await storage.waitFor()
    expect(await storage.getAttribute('data-available')).toBe('true')
    const expected =
      process.platform === 'win32'
        ? 'dpapi'
        : process.platform === 'darwin'
          ? 'keychain'
          : 'gnome_libsecret'
    expect(await storage.getAttribute('data-backend')).toBe(expected)
    await evidence('01-models-empty')
  })

  it('AT1: adds a provider through the interface with an installed adapter, and removes it', async () => {
    await open('models')
    await page.getByTestId('provider-add').click()
    const adapters = await page
      .getByTestId('provider-adapter')
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    // The adapters come from the assembly of Core (apps/desktop/src/core/adapters.ts), not from Core.
    expect(adapters).toEqual(['openai-compatible', 'anthropic'])
    await page.getByTestId('dialog-close').click()

    const card = await addProvider({
      adapterId: 'openai-compatible',
      name: 'Temporary server',
      url: local.baseUrl
    })
    await expect.poll(() => card.getAttribute('data-state')).toBe('ready')
    await card.getByTestId('provider-remove').click()
    await page.getByTestId('provider-remove-dialog').getByTestId('confirm-ok').click()
    await expect.poll(() => card.count()).toBe(0)
  })

  it('AT6: sets up a local model for chat; the router picks it for chat and nothing for vision', async () => {
    local.reset()
    const card = await addProvider({
      adapterId: 'openai-compatible',
      name: 'Local server',
      url: local.baseUrl
    })
    await expect.poll(() => card.getAttribute('data-state')).toBe('ready')
    expect(await card.getAttribute('data-locality')).toBe('this-device')
    // Discovered models start unused: the provider did not say what they can do.
    const row = card.locator('[data-testid="model-row"][data-model-id="local-chat"]')
    expect(await row.getAttribute('data-enabled')).toBe('false')
    expect(await row.getByTestId('model-enabled').isDisabled()).toBe(true)
    await useForChat(card, 'local-chat')

    const chatPreview = page.getByTestId('route-preview-chat')
    await expect.poll(() => chatPreview.getAttribute('data-state')).toBe('routed')
    expect(await chatPreview.locator('[data-model]').getAttribute('data-model')).toBe('local-chat')
    await expect
      .poll(() => page.getByTestId('route-preview-vision').getAttribute('data-state'))
      .toBe('none')
    expect(await page.getByTestId('route-preview-vision').textContent()).toContain('Not configured')
    const vision = await query(page, 'ai.route.preview', {
      capability: 'vision',
      conversationId: null
    })
    expect(vision.problem?.code).toBe('NO_MODEL_AVAILABLE')
    await evidence('02-models-local-provider')
  })

  it('AT4: streams the answer into the page piece by piece, then stores it complete', async () => {
    await open('home')
    local.reset()
    local.enqueue({
      chunks: ['Alpha ', 'Beta ', 'Gamma'],
      gated: true,
      usage: { input: 9, output: 3 }
    })
    await send('Stream three words, please.', 'chat-composer')
    await expect.poll(() => lastAnswerStatus()).toBe('streaming')
    const text = answers().last().getByTestId('message-text')

    // Every text the page shows while streaming is recorded, to prove it grows step by step.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { seen: string[] }).seen = seen
      new MutationObserver(() => {
        const node = document.querySelectorAll(
          '[data-testid="chat-message"][data-role="assistant"] [data-testid="message-text"]'
        )
        const value = node[node.length - 1]?.textContent ?? ''
        if (seen.at(-1) !== value) seen.push(value)
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    local.advance()
    await expect.poll(() => text.textContent()).toBe('Alpha ')
    expect(await lastAnswerStatus()).toBe('streaming')
    await evidence('03-chat-streaming')
    local.advance()
    await expect.poll(() => text.textContent()).toBe('Alpha Beta ')
    expect(await lastAnswerStatus()).toBe('streaming')
    local.advance()
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    expect(await text.textContent()).toBe('Alpha Beta Gamma')
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen)
    expect(seen).toEqual(expect.arrayContaining(['Alpha ', 'Alpha Beta ', 'Alpha Beta Gamma']))
    expect(seen.indexOf('Alpha ')).toBeLessThan(seen.indexOf('Alpha Beta '))

    // The model that answered is shown with the answer.
    const route = answers().last().getByTestId('message-route')
    expect(await route.getAttribute('data-model')).toBe('local-chat')
    expect(await route.getAttribute('data-locality')).toBe('this-device')
    expect(await answers().last().getByTestId('message-usage').textContent()).toContain('9 in')
    await evidence('04-chat-complete')
  })

  it('AT5: Stop cancels the provider request and keeps what arrived', async () => {
    local.reset()
    local.enqueue({ chunks: ['Partial ', 'never sent'], gated: true })
    await send('Start and then stop.')
    await expect.poll(() => lastAnswerStatus()).toBe('streaming')
    local.advance()
    const answer = answers().last()
    await expect.poll(() => answer.getByTestId('message-text').textContent()).toBe('Partial ')
    await answer.getByTestId('message-stop').click()
    await expect.poll(() => lastAnswerStatus()).toBe('cancelled')
    expect(await answers().last().getByTestId('message-stopped').isVisible()).toBe(true)
    expect(await answers().last().getByTestId('message-text').textContent()).toBe('Partial ')
    // The provider saw its request closed before the answer was complete.
    await expect.poll(() => chatRequests(local)[0]?.abortedAt ?? null).not.toBeNull()
    await evidence('05-chat-stopped')
  })

  it('asks again and edits a sent message, keeping the replaced versions', async () => {
    local.reset()
    local.enqueue({ chunks: ['Second try.'] })
    await answers().last().getByTestId('message-retry').click()
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    expect(await answers().last().getByTestId('message-text').textContent()).toBe('Second try.')

    local.enqueue({ chunks: ['Edited answer.'] })
    const question = page
      .locator('[data-testid="chat-message"][data-role="user"][data-replaced="false"]')
      .last()
    await question.getByTestId('message-edit').click()
    await page.getByTestId('message-edit-input').fill('An edited question.')
    await page.getByTestId('message-edit-send').click()
    await expect
      .poll(() => answers().last().getByTestId('message-text').textContent())
      .toBe('Edited answer.')
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    // The provider received the edited question, not the replaced one.
    const body = chatRequests(local).at(-1)?.body as { messages: { content: string }[] }
    expect(body.messages.at(-1)?.content).toBe('An edited question.')
    expect(JSON.stringify(body)).not.toContain('Start and then stop.')

    await page.getByTestId('conversation-options').locator('summary').click()
    const replaced = page.getByTestId('show-replaced')
    await replaced.check()
    await expect
      .poll(() => page.locator('[data-testid="chat-message"][data-replaced="true"]').count())
      .toBeGreaterThanOrEqual(3)
    await evidence('06-chat-replaced-versions')
    await replaced.uncheck()
    await page.getByTestId('conversation-options').locator('summary').click()
  })

  it('shows a tool call as structured data, and says that nothing was run', async () => {
    local.reset()
    local.enqueue({
      chunks: ['Let me look that up.'],
      reasoning: ['hidden chain of thought'],
      toolCalls: [{ id: 'call_1', name: 'weather_lookup', arguments: '{"city":"Bangkok"}' }]
    })
    await send('What is the weather?')
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    const call = answers().last().getByTestId('tool-call')
    expect(await call.getAttribute('data-tool')).toBe('weather_lookup')
    await call.locator('summary').click()
    expect(await call.textContent()).toContain('"city": "Bangkok"')
    expect(await call.textContent()).toContain('nothing was run')
    // Hidden reasoning never reaches the page.
    expect(await page.locator('body').textContent()).not.toContain('hidden chain of thought')
    await evidence('07-chat-tool-call')
  })

  it('AT2 + AT3: saves an API key in OS-backed secure storage; a wrong key gets a clear, sanitized error', async () => {
    const card = await addProvider({
      adapterId: 'anthropic',
      name: 'Keyed server',
      url: keyed.baseUrl,
      key: KEY
    })
    await expect.poll(() => card.getAttribute('data-state')).toBe('ready')
    const validation = card.getByTestId('provider-key-validation')
    expect(await validation.getAttribute('data-validation')).toBe('valid')
    // The provider received the key, in its protocol's header.
    expect(keyed.requests.some((request) => request.headers['x-api-key'] === KEY)).toBe(true)

    // The key is one ciphertext file in the credentials folder, readable only by the user.
    const credentials = join(userDataDir, 'credentials')
    const files = readdirSync(credentials)
    expect(files).toHaveLength(1)
    const file = join(credentials, files[0] ?? '')
    const ciphertext = readFileSync(file)
    expect(ciphertext.includes(Buffer.from(KEY))).toBe(false)
    expect(ciphertext.length).toBeGreaterThan(KEY.length)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    // On Linux, Chromium marks keyring-protected data "v11" ("v10" would be its fixed fallback key).
    if (process.platform === 'linux') expect(ciphertext.subarray(0, 3).toString()).toBe('v11')
    // The interface only ever knows a fingerprint.
    const fingerprint = await card.getByTestId('provider-key-status').locator('code').textContent()
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/)
    await evidence('08-models-key-saved')

    // AT3: replace it with a wrong key.
    await card.getByTestId('provider-key-replace').click()
    await card.getByTestId('provider-key-input').fill(WRONG_KEY)
    await card.getByTestId('provider-key-save').click()
    await expect.poll(() => card.getAttribute('data-state')).toBe('failed')
    expect(await validation.getAttribute('data-validation')).toBe('rejected')
    const error = card.getByTestId('provider-error')
    expect(await error.getAttribute('data-code')).toBe('PROVIDER_KEY_REJECTED')
    const shown = (await error.textContent()) ?? ''
    expect(shown).toContain('The provider rejected the API key.')
    expect(shown).toContain('rejected the API key (HTTP 401)')
    // The server echoed the wrong key in its error; Jupiter never repeats it.
    const lastError = keyed.requests.at(-1)
    expect(lastError?.headers['x-api-key']).toBe(WRONG_KEY)
    expect(await page.locator('body').textContent()).not.toContain(WRONG_KEY)
    expect(await page.locator('body').innerHTML()).not.toContain(WRONG_KEY)
    await evidence('09-models-key-rejected')

    // Put the right key back.
    await card.getByTestId('provider-key-replace').click()
    await card.getByTestId('provider-key-input').fill(KEY)
    await card.getByTestId('provider-key-save').click()
    await expect.poll(() => card.getAttribute('data-state')).toBe('ready')
    expect(readdirSync(credentials)).toHaveLength(1)
    await useForChat(card, 'keyed-chat')
  })

  it('refuses to send a key to an unencrypted address that is not on this computer', async () => {
    const card = await addProvider({
      adapterId: 'openai-compatible',
      name: 'Cloud server',
      url: cloud.baseUrl
    })
    await expect.poll(() => card.getAttribute('data-state')).toBe('ready')
    expect(await card.getAttribute('data-locality')).toBe('cloud')
    expect(await card.getByTestId('provider-unencrypted').isVisible()).toBe(true)
    // The interface offers no key field that could not work, and says why…
    expect(await card.getByTestId('provider-key-input').count()).toBe(0)
    expect(await card.getByTestId('provider-key-insecure').textContent()).toContain(
      'will not send a key'
    )
    // …and Core refuses on its own, whoever asks.
    const providerId = (await card.getAttribute('data-provider-id')) ?? ''
    const refused = await invoke(page, envelope('ai.credentials.set', { providerId, apiKey: KEY }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.code).toBe('INSECURE_TRANSPORT')
      expect(JSON.stringify(refused.error)).not.toContain(KEY)
    }
    expect(readdirSync(join(userDataDir, 'credentials'))).toHaveLength(1)
    expect(cloud.requests.some((request) => JSON.stringify(request.headers).includes(KEY))).toBe(
      false
    )
    await useForChat(card, 'cloud-chat')
  })

  it('AT9: an outage fails truthfully with no fallback, and falls back only as the policy allows', async () => {
    // Make the local model the preferred one, so it is tried first.
    await open('models')
    await page.getByTestId('preferred-chat').selectOption({ label: 'Local Chat (Local server)' })
    await expect
      .poll(() => page.getByTestId('routing-save-status').getAttribute('data-state'))
      .toBe('saved')
    expect(await page.getByTestId('fallback-policy-never').isChecked()).toBe(true)

    local.reset()
    keyed.reset()
    cloud.reset()
    local.failAll(503)
    await open('chat')
    await page.getByTestId('chat-new').click()
    await send('Is anyone there?')
    await expect.poll(() => lastAnswerStatus()).toBe('failed')
    const error = answers().last().getByTestId('message-error')
    expect(await error.getAttribute('data-code')).toBe('PROVIDER_SERVER_ERROR')
    expect(await error.textContent()).toContain('HTTP 503')
    // "Never": no other provider was asked.
    expect(chatRequests(keyed)).toHaveLength(0)
    expect(chatRequests(cloud)).toHaveLength(0)
    await evidence('10-chat-outage')

    // "Same place only": another model on this device may answer; the cloud one may not.
    await open('models')
    await page.getByTestId('fallback-policy-same-locality').check()
    await expect
      .poll(() => page.getByTestId('routing-save-status').getAttribute('data-state'))
      .toBe('saved')
    await open('chat')
    await expect.poll(() => lastAnswerStatus()).toBe('failed')
    await answers().last().getByTestId('message-retry').click()
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    const route = answers().last().getByTestId('message-route')
    expect(await route.getAttribute('data-model')).toBe('keyed-chat')
    const fallback = answers().last().getByTestId('message-route-fallback')
    expect(await fallback.getAttribute('data-code')).toBe('PROVIDER_SERVER_ERROR')
    expect(await fallback.textContent()).toContain('local-chat')
    expect(chatRequests(cloud)).toHaveLength(0)
    await evidence('11-chat-fallback')
    local.failAll(null)
  })

  it('AT7: Local only sends nothing to the cloud endpoint — not even a connection', async () => {
    await selectRoutingMode('LOCAL_ONLY')
    cloud.reset()
    const card = providerCard('Cloud server')
    await expect.poll(() => card.getAttribute('data-state')).toBe('blocked')
    await card.getByTestId('provider-check').click()
    await expect.poll(() => card.getByTestId('provider-check').isEnabled()).toBe(true)
    await evidence('12-models-local-only')

    // Only the cloud model is left: chat cannot send, and says why.
    await setModelEnabled(providerCard('Local server'), 'local-chat', false)
    await setModelEnabled(providerCard('Keyed server'), 'keyed-chat', false)
    await open('chat')
    const composer = page.getByTestId('chat-view-composer')
    await expect.poll(() => composer.getAttribute('data-availability')).toBe('UNAVAILABLE')
    expect(await composer.getByTestId('chat-view-composer-reason').textContent()).toContain(
      'Local only'
    )
    const preview = await query(page, 'ai.route.preview', {
      capability: 'chat',
      conversationId: null
    })
    expect(preview.problem?.code).toBe('PRIVACY_MODE_BLOCKED')
    await evidence('13-chat-local-only-blocked')

    // With a local model back, chat works — locally.
    await open('models')
    await setModelEnabled(providerCard('Local server'), 'local-chat', true)
    local.reset()
    await open('chat')
    await page.getByTestId('chat-new').click()
    await send('Only on this computer.')
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    expect(await answers().last().getByTestId('message-route').getAttribute('data-locality')).toBe(
      'this-device'
    )
    expect(chatRequests(local)).toHaveLength(1)
    expect(cloud.connections()).toBe(0)
    expect(cloud.requests).toEqual([])
    await selectRoutingMode('AUTO')
    await setModelEnabled(providerCard('Keyed server'), 'keyed-chat', true)
  })

  it('pins a conversation to a model with its own routing override', async () => {
    await open('chat')
    await page.getByTestId('conversation-options').locator('summary').click()
    await page
      .getByTestId('conversation-model')
      .selectOption({ label: 'Keyed Chat (Keyed server)' })
    await expect
      .poll(() => page.getByTestId('chat-view-composer-route').getAttribute('data-model'))
      .toBe('keyed-chat')
    expect(await page.getByTestId('chat-view-composer-route').getAttribute('data-reason')).toBe(
      'conversation-model'
    )
    await page.getByTestId('conversation-options').locator('summary').click()
    await send('Answer from the pinned model.')
    await expect.poll(() => lastAnswerStatus()).toBe('complete')
    expect(await answers().last().getByTestId('message-route').getAttribute('data-model')).toBe(
      'keyed-chat'
    )
  })

  it('AT10: conversation history survives a restart', async () => {
    const before = await query(page, 'chat.conversations.list', { limit: 50 })
    expect(before.conversations.length).toBeGreaterThanOrEqual(3)
    const texts = await page.getByTestId('message-text').allTextContents()
    await jupiter.close()
    jupiter = await launch()
    page = jupiter.window
    const after = await query(page, 'chat.conversations.list', { limit: 50 })
    expect(after.conversations).toEqual(before.conversations)
    await open('chat')
    await page
      .locator(
        `[data-testid="conversation-item"][data-conversation-id="${before.conversations[0]?.conversationId ?? ''}"]`
      )
      .click()
    await expect.poll(() => page.getByTestId('message-text').allTextContents()).toEqual(texts)
    // The saved key still works after the restart (it is read back from secure storage).
    const card = providerCard('Keyed server')
    await open('models')
    await card.getByTestId('provider-check').click()
    await expect.poll(() => card.getAttribute('data-state')).toBe('ready')
    await open('chat')
    await evidence('14-chat-after-restart')
  })

  it('AT8: the key appears in no log, database dump, renderer storage, page or error output', async () => {
    await jupiter.close()
    const secrets = [KEY, WRONG_KEY]
    const findings: string[] = []
    const check = (where: string, content: Buffer | string) => {
      const buffer = typeof content === 'string' ? Buffer.from(content) : content
      for (const secret of secrets) {
        // Chromium stores some strings as UTF-16: look for both encodings.
        if (
          buffer.includes(Buffer.from(secret, 'utf8')) ||
          buffer.includes(Buffer.from(secret, 'utf16le'))
        )
          findings.push(`${where} contains a key`)
      }
    }
    // Every file in the profile: logs, the database and its journal, backups, and Chromium's
    // renderer storage (Local Storage, Session Storage, IndexedDB, caches, preferences).
    const files = filesUnder(userDataDir)
    expect(
      files.some((file) => file.includes('Local Storage') || file.includes('Preferences'))
    ).toBe(true)
    for (const file of files) check(file, readFileSync(file))
    check('database dump', dumpDatabase(join(userDataDir, 'jupiter.db')))
    check('main process output', jupiter.output.join('\n'))
    const { entries } = readLog(userDataDir)
    expect(entries.some((entry) => entry.event === 'credential.stored')).toBe(true)
    expect(findings).toEqual([])
  })
})
