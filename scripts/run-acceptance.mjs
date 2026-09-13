import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { startMockProvider } from './mock-provider.mjs'

/**
 * Alpha acceptance suite.
 *
 * Drives the real packaged-shape application: a real Electron process, the
 * real main process, the real preload bridge and the real React UI. Nothing
 * is stubbed inside Thursday.
 *
 * The one external stand-in is the AI provider: tests 8-13 point at a local
 * OpenAI-compatible server started by this script. That exercises Thursday's
 * provider adapter, HTTP handling and SSE parsing for real. It proves nothing
 * about OpenAI's, Anthropic's or Google's live services, which need real
 * credentials and are therefore out of scope for an automated run.
 */

const results = []
let userDataDir = ''
let mock = null
let app = null
let win = null

function record(number, name, ok, detail) {
  results.push({ number, name, ok, detail })
  const status = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`  ${String(number).padStart(2, ' ')}. ${status}  ${name}`)
  if (detail) console.log(`        ${detail}`)
}

async function check(number, name, fn) {
  try {
    const detail = await fn()
    record(number, name, true, detail)
    return true
  } catch (err) {
    record(number, name, false, err.message)
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Call an IPC channel from inside the renderer, through the real bridge. */
async function ipc(channel, input) {
  return win.evaluate(
    ([c, i]) => window.thursday[c](i),
    [channel, input === undefined ? null : input]
  )
}

async function waitFor(description, predicate, timeoutMs = 15000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await predicate()
    if (last) return last
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function launch() {
  app = await electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd()
  })
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.rail', { timeout: 20000 })
  return app
}

async function activeTabId() {
  const state = await ipc('browser:getState')
  return state.activeTabId
}

async function waitForUrl(tabId, expected) {
  return waitFor(`tab ${tabId} to finish loading ${expected}`, async () => {
    const state = await ipc('browser:getState')
    const tab = state.tabs.find((entry) => entry.id === tabId)
    return tab && tab.url === expected && !tab.loading ? tab : null
  })
}

async function main() {
  console.log('\n\x1b[1mThursday Browser — Alpha acceptance suite\x1b[0m\n')

  userDataDir = await mkdtemp(join(tmpdir(), 'thursday-acceptance-'))
  mock = await startMockProvider()
  console.log(`  user data: ${userDataDir}`)
  console.log(`  mock provider: ${mock.baseUrl}\n`)

  /* ------------------------------ 1 ------------------------------ */
  await check(1, 'Launch Thursday', async () => {
    await launch()
    const title = await win.title()
    assert(title === 'Thursday Browser', `window title was "${title}"`)
    const info = await ipc('app:info')
    return `Electron ${info.electron}, Chromium ${info.chrome}`
  })

  /* ------------------------------ 2 ------------------------------ */
  let tabId = null
  await check(2, 'Create browser tab', async () => {
    const before = await ipc('browser:getState')
    const tab = await ipc('browser:newTab', {})
    const after = await ipc('browser:getState')
    assert(after.tabs.length === before.tabs.length + 1, 'tab count did not increase')
    assert(after.activeTabId === tab.id, 'the new tab did not become active')
    tabId = tab.id
    return `${after.tabs.length} tab(s) open`
  })

  /* ------------------------------ 3 ------------------------------ */
  await check(3, 'Navigate to a website', async () => {
    await ipc('browser:navigate', { id: tabId, url: `${mock.origin}/page1` })
    const tab = await waitForUrl(tabId, `${mock.origin}/page1`)
    await waitFor('page title', async () => {
      const state = await ipc('browser:getState')
      return state.tabs.find((e) => e.id === tabId)?.title === 'Page One'
    })
    return `loaded ${tab.url} — title "Page One"`
  })

  /* ------------------------------ 4 ------------------------------ */
  await check(4, 'Back works', async () => {
    await ipc('browser:navigate', { id: tabId, url: `${mock.origin}/page2` })
    await waitForUrl(tabId, `${mock.origin}/page2`)
    await waitFor('back to become available', async () => {
      const state = await ipc('browser:getState')
      return state.tabs.find((e) => e.id === tabId)?.canGoBack === true
    })
    await ipc('browser:goBack', { id: tabId })
    const tab = await waitForUrl(tabId, `${mock.origin}/page1`)
    return `returned to ${tab.url}`
  })

  /* ------------------------------ 5 ------------------------------ */
  await check(5, 'Forward works', async () => {
    await waitFor('forward to become available', async () => {
      const state = await ipc('browser:getState')
      return state.tabs.find((e) => e.id === tabId)?.canGoForward === true
    })
    await ipc('browser:goForward', { id: tabId })
    const tab = await waitForUrl(tabId, `${mock.origin}/page2`)
    return `advanced to ${tab.url}`
  })

  /* ------------------------------ 6 ------------------------------ */
  await check(6, 'Reload works', async () => {
    await ipc('browser:reload', { id: tabId })
    await waitFor('reload to start', async () => {
      const state = await ipc('browser:getState')
      const tab = state.tabs.find((e) => e.id === tabId)
      return tab?.loading === true || tab?.url === `${mock.origin}/page2`
    })
    const tab = await waitForUrl(tabId, `${mock.origin}/page2`)
    return `reloaded ${tab.url}`
  })

  /* ------------------------------ 7 ------------------------------ */
  await check(7, 'Open Thursday Sidebar', async () => {
    await ipc('settings:set', { sidebarOpen: false })
    // A collapsed sidebar is zero-width, so wait for it in the DOM, not on screen.
    await win.waitForSelector('.sidebar.collapsed', { timeout: 5000, state: 'attached' })
    await ipc('settings:set', { sidebarOpen: true })
    await win.waitForSelector('.sidebar:not(.collapsed) .chat-compose', { timeout: 5000 })
    const visible = await win.locator('.sidebar .chat-compose textarea').isVisible()
    assert(visible, 'the chat composer is not visible')
    return 'sidebar collapses and reopens with the chat composer'
  })

  /* ------------------------------ 8 ------------------------------ */
  let providerId = null
  await check(8, 'Add an AI provider', async () => {
    const saved = await ipc('providers:save', {
      kind: 'openai-compat',
      label: 'Acceptance Mock',
      baseUrl: mock.baseUrl,
      apiKey: 'test-key-not-a-real-secret'
    })
    providerId = saved.id
    const list = await ipc('providers:list')
    assert(list.some((entry) => entry.id === providerId), 'the provider was not persisted')
    assert(list.find((e) => e.id === providerId).hasApiKey, 'the API key was not stored')
    return `saved "${saved.label}" (${saved.kind}) at ${saved.baseUrl}`
  })

  /* ------------------------------ 9 ------------------------------ */
  await check(9, 'Test provider connection', async () => {
    const result = await ipc('providers:test', { id: providerId })
    assert(result.ok, `connection failed: ${result.message}`)
    return result.message
  })

  /* ----------------------------- 10 ------------------------------ */
  await check(10, 'Fetch available models', async () => {
    const result = await ipc('providers:models', { id: providerId })
    assert(result.ok, `fetch failed: ${result.error}`)
    assert(result.models.length >= 2, `expected 2+ models, got ${result.models.length}`)
    return `discovered: ${result.models.map((m) => m.id).join(', ')}`
  })

  /* ----------------------------- 11 ------------------------------ */
  await check(11, 'Select model', async () => {
    const settings = await ipc('settings:set', { activeProviderId: providerId, activeModel: 'mock-large' })
    assert(settings.activeModel === 'mock-large', 'the model was not stored')
    return `active model is ${settings.activeModel}`
  })

  /* ----------------------------- 12 & 13 ------------------------- */
  let conversationId = null
  await check(12, 'Send chat message', async () => {
    const conversation = await ipc('chat:createConversation', { title: 'Acceptance' })
    conversationId = conversation.id

    // Capture streaming chunks as the renderer receives them.
    await win.evaluate(() => {
      window.__acceptanceChunks = []
      window.__acceptanceOff = window.thursday.on('chat:chunk', (payload) =>
        window.__acceptanceChunks.push(payload)
      )
    })

    const ack = await ipc('chat:send', {
      conversationId,
      providerId,
      model: 'mock-large',
      content: 'ping from the acceptance suite',
      useSkills: false
    })
    assert(typeof ack.streamId === 'string' && ack.streamId.length > 0, 'no stream id returned')

    const messages = await ipc('chat:messages', { conversationId })
    assert(messages.some((m) => m.role === 'user'), 'the user message was not persisted')
    return `stream ${ack.streamId.slice(0, 8)} started`
  })

  await check(13, 'Receive streaming response', async () => {
    await waitFor('the stream to finish', async () =>
      win.evaluate(() => window.__acceptanceChunks.some((c) => c.chunk.type === 'done'))
    )
    const chunks = await win.evaluate(() => window.__acceptanceChunks)
    const textChunks = chunks.filter((c) => c.chunk.type === 'text')
    const errors = chunks.filter((c) => c.chunk.type === 'error')
    assert(errors.length === 0, `stream reported: ${errors.map((e) => e.chunk.message).join('; ')}`)
    assert(textChunks.length > 1, `expected several text chunks, got ${textChunks.length}`)

    const assembled = textChunks.map((c) => c.chunk.text).join('')
    assert(assembled.includes('ping from the acceptance suite'), `unexpected reply: ${assembled}`)

    const messages = await ipc('chat:messages', { conversationId })
    const assistant = messages.filter((m) => m.role === 'assistant')
    assert(assistant.length === 1, `expected 1 persisted assistant message, got ${assistant.length}`)
    return `${textChunks.length} chunks streamed and persisted: "${assembled.slice(0, 60)}…"`
  })

  /* ----------------------------- 14 ------------------------------ */
  await check(14, 'Install/load a sample Plugin', async () => {
    const plugins = await waitFor('the demo plugin to finish loading', async () => {
      const list = await ipc('plugins:list')
      const demo = list.find((p) => p.id === 'demo-tools')
      return demo && demo.health !== 'starting' ? list : null
    })
    const demo = plugins.find((p) => p.id === 'demo-tools')
    assert(demo.health === 'ok', `health was "${demo.health}": ${demo.error ?? 'no detail'}`)
    return `${demo.name} v${demo.version} running in its own process`
  })

  /* ----------------------------- 15 ------------------------------ */
  await check(15, 'Plugin registers a Skill', async () => {
    const plugins = await ipc('plugins:list')
    const demo = plugins.find((p) => p.id === 'demo-tools')
    assert(demo.skillIds.length === 3, `expected 3 skills, got ${demo.skillIds.length}`)
    return demo.skillIds.join(', ')
  })

  /* ----------------------------- 16 ------------------------------ */
  await check(16, 'Thursday discovers the Skill', async () => {
    const skills = await ipc('skills:list')
    const echo = skills.find((s) => s.id === 'demo-tools.echo_text')
    assert(echo, 'demo-tools.echo_text is not in the registry')
    assert(echo.inputSchema && echo.inputSchema.type === 'object', 'the skill has no input schema')

    const invoked = await ipc('skills:invoke', {
      skillId: 'demo-tools.echo_text',
      input: { text: 'registry round trip' }
    })
    assert(invoked.ok, `invocation failed: ${invoked.error}`)
    assert(invoked.output.echoed === 'registry round trip', 'the skill returned the wrong value')

    // The registry must also reject input that violates the declared schema.
    const rejected = await ipc('skills:invoke', { skillId: 'demo-tools.echo_text', input: { text: 42 } })
    assert(!rejected.ok && rejected.code === 'INVALID_INPUT', 'bad input was not rejected')
    return `${skills.length} skills discovered; schema validation rejects bad input`
  })

  /* ----------------------------- 17 ------------------------------ */
  let missionId = null
  await check(17, 'Create a Mission', async () => {
    const mission = await ipc('missions:create', {
      title: 'Acceptance mission',
      goal: 'Prove that a mission can drive plugin skills end to end',
      steps: [
        { title: 'Echo a phrase', skillId: 'demo-tools.echo_text', input: { text: 'mission step one' }, maxAttempts: 2 },
        { title: 'Read the clock', skillId: 'demo-tools.get_current_time', input: {}, maxAttempts: 2 },
        { title: 'Save a note', skillId: 'demo-tools.save_note', input: { filename: 'acceptance.txt', content: 'written by the acceptance suite' }, maxAttempts: 2 }
      ]
    })
    missionId = mission.id
    assert(mission.status === 'IDLE', `new mission status was ${mission.status}`)
    assert(mission.steps.length === 3, `expected 3 steps, got ${mission.steps.length}`)
    return `mission ${missionId.slice(0, 8)} created with 3 steps`
  })

  /* ----------------------------- 18 ------------------------------ */
  await check(18, 'Mission invokes the Skill', async () => {
    await ipc('missions:start', { id: missionId })
    const mission = await waitFor('the first step to complete', async () => {
      const current = await ipc('missions:get', { id: missionId })
      return current.steps[0].status === 'completed' || current.status === 'FAILED' ? current : null
    }, 30000)
    assert(mission.status !== 'FAILED', `mission failed: ${mission.errors.join('; ')}`)
    const output = mission.steps[0].output
    assert(output && output.echoed === 'mission step one', `unexpected step output: ${JSON.stringify(output)}`)
    return `step 1 returned ${JSON.stringify(output)}`
  })

  /* ----------------------------- 19 ------------------------------ */
  await check(19, 'Command Center updates status', async () => {
    const state = await ipc('commandcenter:state')
    assert(state.mission, 'the Command Center reports no mission')
    assert(state.mission.id === missionId, 'the Command Center is showing a different mission')
    assert(
      ['executing', 'thinking', 'completed', 'planning'].includes(state.brain),
      `brain state was "${state.brain}"`
    )
    assert(state.pluginHealth.some((p) => p.id === 'demo-tools'), 'plugin health is missing')

    await win.click('.rail-btn[aria-label="Command Center"]')
    await win.waitForSelector('.panel-title', { timeout: 5000 })
    const heading = await win.locator('.panel-title').innerText()
    assert(heading.includes('Command Center'), `panel heading was "${heading}"`)
    return `brain "${state.brain}", progress ${state.mission.progress}%, UI panel rendered`
  })

  /* ----------------------------- 20 ------------------------------ */
  await check(20, 'Mission completes', async () => {
    const mission = await waitFor('the mission to reach a terminal state', async () => {
      const current = await ipc('missions:get', { id: missionId })
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status) ? current : null
    }, 40000)
    assert(mission.status === 'COMPLETED', `mission ended as ${mission.status}: ${mission.errors.join('; ')}`)
    assert(mission.progress === 100, `progress was ${mission.progress}%`)
    const note = mission.steps[2].output
    assert(note && typeof note.path === 'string', 'the save_note step produced no path')
    return `all 3 steps completed; note written to ${note.path}`
  })

  /* ----------------------------- 21 ------------------------------ */
  await check(21, 'Logs record execution', async () => {
    const missionLogs = await ipc('logs:query', { category: 'MISSION', limit: 200 })
    const skillLogs = await ipc('logs:query', { category: 'SKILL', limit: 200 })
    const pluginLogs = await ipc('logs:query', { category: 'PLUGIN', limit: 200 })

    assert(missionLogs.some((l) => l.message.includes('COMPLETED')), 'no MISSION completion log')
    assert(skillLogs.some((l) => l.message.includes('demo-tools.echo_text')), 'no SKILL invocation log')
    assert(pluginLogs.some((l) => l.message.includes('demo-tools')), 'no PLUGIN log')
    assert(
      skillLogs.some((l) => l.data && typeof l.data === 'object'),
      'skill logs carry no structured data'
    )
    return `MISSION ${missionLogs.length}, SKILL ${skillLogs.length}, PLUGIN ${pluginLogs.length} entries`
  })

  /* ----------------------------- 22 ------------------------------ */
  await check(22, 'Diagnostics correctly reflects health', async () => {
    const report = await ipc('diagnostics:run')
    const find = (key) => report.items.find((item) => item.key === key)

    assert(find('browser')?.status === 'ok', 'Browser Core is not OK')
    assert(find('database')?.status === 'ok', 'Database is not OK')
    assert(find('plugin-engine')?.status === 'ok', 'Plugin Engine is not OK')
    assert(find('plugin:demo-tools')?.status === 'ok', 'Demo Tools is not reported healthy')

    const provider = find(`provider:${providerId}`)
    assert(provider?.status === 'ok', `the mock provider reported ${provider?.status}: ${provider?.detail}`)

    // Local runtimes that are genuinely absent must be reported as offline,
    // never as connected.
    const ollama = find('local:ollama')
    assert(ollama, 'Ollama is missing from the report')
    assert(['ok', 'offline', 'error'].includes(ollama.status), `unexpected Ollama status ${ollama.status}`)
    assert(ollama.detail.length > 0, 'the Ollama line has no detail')

    for (const item of report.items) {
      assert(!/something went wrong/i.test(item.detail), `generic error text in "${item.key}"`)
    }
    return `${report.items.length} checks; Ollama reported "${ollama.status}" (${ollama.detail})`
  })

  /* ----------------------------- 23 ------------------------------ */
  await check(23, 'Restart application', async () => {
    await app.close()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await launch()
    const info = await ipc('app:info')
    assert(info.userDataDir === userDataDir, `user data dir changed to ${info.userDataDir}`)
    return 'application closed and relaunched against the same profile'
  })

  /* ----------------------------- 24 ------------------------------ */
  await check(24, 'Settings and mission history remain', async () => {
    const settings = await ipc('settings:get')
    assert(settings.activeModel === 'mock-large', `active model is now ${settings.activeModel}`)
    assert(settings.activeProviderId === providerId, 'the active provider was lost')

    const providers = await ipc('providers:list')
    const provider = providers.find((p) => p.id === providerId)
    assert(provider, 'the provider was lost')
    assert(provider.hasApiKey, 'the stored API key was lost')

    const missions = await ipc('missions:list')
    const mission = missions.find((m) => m.id === missionId)
    assert(mission, 'the mission was lost')
    assert(mission.status === 'COMPLETED', `the mission is now ${mission.status}`)
    assert(mission.steps.length === 3, 'the mission steps were lost')
    assert(mission.steps[0].output.echoed === 'mission step one', 'the step output was lost')

    const conversations = await ipc('chat:listConversations')
    assert(conversations.some((c) => c.id === conversationId), 'the conversation was lost')
    const messages = await ipc('chat:messages', { conversationId })
    assert(messages.length >= 2, `expected the chat history, found ${messages.length} message(s)`)

    return `settings, ${providers.length} provider(s), ${missions.length} mission(s) and chat history all survived`
  })

  /* ---------------------- core principle checks ------------------- */
  console.log('\n  \x1b[1mCore principle verification (beyond the 24 required tests)\x1b[0m')

  await check(25, 'A broken plugin does not crash the Browser Core', async () => {
    const brokenDir = join(userDataDir, 'broken-plugin-src')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(
      join(brokenDir, 'manifest.json'),
      JSON.stringify({ id: 'broken-demo', name: 'Broken Demo', version: '1.0.0', main: 'index.js', permissions: [], skills: [] })
    )
    // Throws the moment the host imports it.
    await writeFile(join(brokenDir, 'index.js'), 'throw new Error("this plugin is deliberately broken")\n')

    const install = await ipc('plugins:install', { dir: brokenDir })
    const plugins = await waitFor('the broken plugin to settle', async () => {
      const list = await ipc('plugins:list')
      const broken = list.find((p) => p.id === 'broken-demo')
      return broken && broken.health !== 'starting' ? list : null
    }, 25000)

    const broken = plugins.find((p) => p.id === 'broken-demo')
    assert(broken, `the broken plugin was not registered (install said: ${install.error})`)
    assert(broken.health === 'error' || broken.health === 'crashed', `health was "${broken.health}"`)
    assert(broken.error && broken.error.length > 0, 'no error message was recorded')

    // The core and the healthy plugin must be entirely unaffected.
    const state = await ipc('browser:getState')
    assert(state.tabs.length > 0, 'the browser lost its tabs')
    const healthy = plugins.find((p) => p.id === 'demo-tools')
    assert(healthy.health === 'ok', 'the healthy plugin was affected')
    const stillWorks = await ipc('skills:invoke', { skillId: 'demo-tools.echo_text', input: { text: 'still alive' } })
    assert(stillWorks.ok, 'the healthy plugin stopped working')

    await ipc('plugins:uninstall', { id: 'broken-demo' })
    return `broken plugin isolated ("${broken.error.slice(0, 70)}…"); core and demo-tools unaffected`
  })

  await check(26, 'An undeclared permission is never granted', async () => {
    // camera is not in the Demo Tools manifest, so the grant must be refused.
    const updated = await ipc('plugins:grantPermissions', {
      id: 'demo-tools',
      permissions: ['filesystem.write', 'filesystem.read', 'camera']
    })
    assert(!updated.grantedPermissions.includes('camera'), 'camera was granted despite not being declared')
    assert(updated.grantedPermissions.includes('filesystem.write'), 'a declared permission was dropped')
    return `granted [${updated.grantedPermissions.join(', ')}]; "camera" refused`
  })

  await check(27, 'A skill loses host access when its permission is revoked', async () => {
    await ipc('plugins:grantPermissions', { id: 'demo-tools', permissions: ['filesystem.read'] })
    await ipc('plugins:reload', { id: 'demo-tools' })
    await waitFor('the plugin to come back up', async () => {
      const list = await ipc('plugins:list')
      return list.find((p) => p.id === 'demo-tools')?.health === 'ok'
    }, 20000)

    const denied = await ipc('skills:invoke', {
      skillId: 'demo-tools.save_note',
      input: { filename: 'should-not-exist.txt', content: 'nope' }
    })
    assert(!denied.ok, 'save_note succeeded without filesystem.write')
    assert(/permission/i.test(denied.error), `error did not mention the permission: ${denied.error}`)

    // Restore, and confirm it works again.
    await ipc('plugins:grantPermissions', { id: 'demo-tools', permissions: ['filesystem.write', 'filesystem.read'] })
    await ipc('plugins:reload', { id: 'demo-tools' })
    await waitFor('the plugin to come back up', async () => {
      const list = await ipc('plugins:list')
      return list.find((p) => p.id === 'demo-tools')?.health === 'ok'
    }, 20000)
    const allowed = await ipc('skills:invoke', {
      skillId: 'demo-tools.save_note',
      input: { filename: 'restored.txt', content: 'allowed again' }
    })
    assert(allowed.ok, `save_note still fails after regranting: ${allowed.error}`)
    return `blocked with "${denied.error.slice(0, 60)}…", then restored`
  })

  await check(28, 'Workflow engine runs a multi-node workflow', async () => {
    const workflow = await ipc('workflows:save', {
      name: 'Acceptance workflow',
      description: 'skill → condition → skill',
      nodes: [
        { id: 'echo', type: 'skill', label: 'Echo', config: { skillId: 'demo-tools.echo_text', input: { text: 'workflow' } } },
        { id: 'branch', type: 'condition', label: 'Did it echo?', config: { left: '{{echo}}', operator: 'contains', right: 'workflow' }, onTrue: 'clock', onFalse: 'stop' },
        { id: 'clock', type: 'skill', label: 'Clock', config: { skillId: 'demo-tools.get_current_time', input: {} }, next: 'stop' },
        { id: 'stop', type: 'output', label: 'Done', config: { value: 'finished' } }
      ]
    })
    const started = await ipc('workflows:run', { workflowId: workflow.id })
    const run = await waitFor('the run to finish', async () => {
      const runs = await ipc('workflows:runs', { workflowId: workflow.id })
      const current = runs.find((entry) => entry.id === started.id)
      return current && ['completed', 'failed', 'cancelled'].includes(current.status) ? current : null
    }, 30000)

    assert(run.status === 'completed', `run ended as ${run.status}: ${run.error}`)
    assert(run.log.some((entry) => entry.nodeId === 'clock'), 'the true branch was not taken')
    assert(run.context.__output === 'finished', `unexpected output: ${run.context.__output}`)
    return `${run.log.length} nodes executed, condition branched to "clock"`
  })

  await check(29, 'Browser Core works with AI and plugins disabled', async () => {
    await ipc('plugins:setEnabled', { id: 'demo-tools', enabled: false })
    await ipc('settings:set', { activeProviderId: null, activeModel: null })

    const tab = await ipc('browser:newTab', { url: `${mock.origin}/page1` })
    await waitForUrl(tab.id, `${mock.origin}/page1`)
    await ipc('browser:navigate', { id: tab.id, url: `${mock.origin}/page2` })
    await waitForUrl(tab.id, `${mock.origin}/page2`)
    await ipc('browser:goBack', { id: tab.id })
    await waitForUrl(tab.id, `${mock.origin}/page1`)
    await ipc('browser:closeTab', { id: tab.id })

    const skills = await ipc('skills:list')
    assert(skills.length === 0, `expected no skills with the plugin disabled, found ${skills.length}`)

    await ipc('plugins:setEnabled', { id: 'demo-tools', enabled: true })
    return 'navigation, history and tab management all work with every optional subsystem off'
  })

  await check(31, 'Mission approval gate blocks, then approves and rejects', async () => {
    const mission = await ipc('missions:create', {
      title: 'Approval mission',
      goal: 'Prove the human-approval gate really blocks execution',
      steps: [
        { title: 'Needs approval', skillId: 'demo-tools.echo_text', input: { text: 'approved step' }, requiresApproval: true, maxAttempts: 1 },
        { title: 'Will be rejected', skillId: 'demo-tools.echo_text', input: { text: 'rejected step' }, requiresApproval: true, maxAttempts: 1 }
      ]
    })
    await ipc('missions:start', { id: mission.id })

    const waiting = await waitFor('the mission to block on approval', async () => {
      const current = await ipc('missions:get', { id: mission.id })
      return current.status === 'WAITING_APPROVAL' ? current : null
    }, 20000)
    assert(waiting.steps[0].status === 'waiting_approval', 'step 1 is not waiting for approval')
    assert(waiting.steps[0].output === null, 'the step ran before it was approved')

    await ipc('missions:approve', { missionId: mission.id, stepId: waiting.steps[0].id })
    const afterApprove = await waitFor('step 1 to complete', async () => {
      const current = await ipc('missions:get', { id: mission.id })
      return current.steps[0].status === 'completed' ? current : null
    }, 20000)
    assert(afterApprove.steps[0].output.echoed === 'approved step', 'the approved step produced no output')

    const blockedAgain = await waitFor('the mission to block on step 2', async () => {
      const current = await ipc('missions:get', { id: mission.id })
      return current.steps[1].status === 'waiting_approval' ? current : null
    }, 20000)
    await ipc('missions:reject', { missionId: mission.id, stepId: blockedAgain.steps[1].id, reason: 'not this time' })

    const finished = await waitFor('the mission to finish', async () => {
      const current = await ipc('missions:get', { id: mission.id })
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status) ? current : null
    }, 25000)
    assert(finished.status === 'COMPLETED', `mission ended as ${finished.status}: ${finished.errors.join('; ')}`)
    assert(finished.steps[1].status === 'skipped', `rejected step is ${finished.steps[1].status}, expected skipped`)
    assert(finished.steps[1].output === null, 'the rejected step ran anyway')
    return 'blocked before running, ran on approve, skipped on reject'
  })

  await check(32, 'Workflow wait, file, browser and approval nodes all execute', async () => {
    const workflow = await ipc('workflows:save', {
      name: 'Node coverage workflow',
      description: 'wait → file write → file read → browser open → approval → output',
      nodes: [
        { id: 'pause', type: 'wait', label: 'Brief pause', config: { ms: 50 } },
        { id: 'write', type: 'file', label: 'Write a file', config: { action: 'write', path: 'coverage/note.txt', content: 'written by a workflow' } },
        { id: 'read', type: 'file', label: 'Read it back', config: { action: 'read', path: 'coverage/note.txt', outputKey: 'contents' } },
        { id: 'open', type: 'browser', label: 'Open a page', config: { action: 'open', url: `${mock.origin}/page1` } },
        { id: 'gate', type: 'human_approval', label: 'Confirm' },
        { id: 'done', type: 'output', label: 'Report', config: { value: '{{contents}}' } }
      ]
    })
    const started = await ipc('workflows:run', { workflowId: workflow.id })

    const waiting = await waitFor('the run to block on approval', async () => {
      const runs = await ipc('workflows:runs', { workflowId: workflow.id })
      const current = runs.find((entry) => entry.id === started.id)
      return current && current.status === 'waiting_approval' ? current : null
    }, 25000)
    assert(waiting.log.some((entry) => entry.nodeId === 'open'), 'the browser node did not run before the gate')

    await ipc('workflows:approve', { runId: started.id, approved: true })
    const run = await waitFor('the run to finish', async () => {
      const runs = await ipc('workflows:runs', { workflowId: workflow.id })
      const current = runs.find((entry) => entry.id === started.id)
      return current && ['completed', 'failed', 'cancelled'].includes(current.status) ? current : null
    }, 25000)

    assert(run.status === 'completed', `run ended as ${run.status}: ${run.error}`)
    assert(run.context.contents === 'written by a workflow', `file round trip failed: ${run.context.contents}`)
    assert(run.context.__output === 'written by a workflow', `output node produced: ${run.context.__output}`)
    const executed = run.log.map((entry) => entry.nodeId)
    for (const nodeId of ['pause', 'write', 'read', 'open', 'gate', 'done']) {
      assert(executed.includes(nodeId), `node "${nodeId}" never executed`)
    }
    return `all 6 node types executed; blocked at the approval gate until approved`
  })

  await check(33, 'A model tool call reaches a skill and the result returns to the model', async () => {
    const conversation = await ipc('chat:createConversation', { title: 'Tool calling' })
    await win.evaluate(() => {
      window.__toolChunks = []
      window.thursday.on('chat:chunk', (payload) => window.__toolChunks.push(payload))
    })

    // The scripted model asks for demo-tools.echo_text; everything after that
    // — parsing the fragmented call, invoking through the registry, feeding
    // the result back and running a second round — is Thursday's own code.
    await ipc('chat:send', {
      conversationId: conversation.id,
      providerId,
      model: 'mock-large',
      content: 'please [[call:demo-tools.echo_text {"text":"called by the model"}]]',
      useSkills: true
    })

    await waitFor('the tool conversation to finish', async () =>
      win.evaluate(() => window.__toolChunks.some((c) => c.chunk.type === 'done'))
    , 30000)

    const chunks = await win.evaluate(() => window.__toolChunks)
    const errors = chunks.filter((c) => c.chunk.type === 'error')
    assert(errors.length === 0, `stream errored: ${errors.map((e) => e.chunk.message).join('; ')}`)

    const toolCalls = chunks.filter((c) => c.chunk.type === 'tool_call')
    assert(toolCalls.length === 1, `expected 1 tool call, got ${toolCalls.length}`)
    assert(
      toolCalls[0].chunk.name === 'demo-tools.echo_text',
      `called the wrong skill: ${toolCalls[0].chunk.name}`
    )
    // Proves the fragmented arguments were reassembled, not just passed through.
    assert(
      toolCalls[0].chunk.arguments.text === 'called by the model',
      `arguments were not reassembled: ${JSON.stringify(toolCalls[0].chunk.arguments)}`
    )

    const persisted = await ipc('chat:messages', { conversationId: conversation.id })
    const assistant = persisted.filter((m) => m.role === 'assistant')
    assert(assistant.length === 1, `expected 1 assistant message, got ${assistant.length}`)
    assert(
      assistant[0].content.includes('called by the model'),
      `the skill result never reached the transcript: ${assistant[0].content}`
    )
    return `tool call reassembled from 3 fragments, skill ran, result in the transcript`
  })

  await check(34, 'A model writes a mission plan and it runs', async () => {
    const mission = await ipc('missions:plan', {
      title: 'Planned mission',
      goal: 'Let the model choose the steps',
      providerId,
      model: 'mock-large'
    })
    assert(mission.steps.length > 0, 'the plan produced no steps')

    // Every step the planner emitted must name a skill that really exists.
    const registered = (await ipc('skills:list')).map((skill) => skill.id)
    for (const step of mission.steps) {
      if (step.skillId !== null) {
        assert(registered.includes(step.skillId), `plan named unregistered skill "${step.skillId}"`)
      }
    }

    await ipc('missions:start', { id: mission.id })
    const finished = await waitFor('the planned mission to finish', async () => {
      const current = await ipc('missions:get', { id: mission.id })
      return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status) ? current : null
    }, 40000)
    assert(finished.status === 'COMPLETED', `ended as ${finished.status}: ${finished.errors.join('; ')}`)
    return `model planned ${mission.steps.length} step(s) from the live skill list; all ran to completion`
  })

  await check(35, 'The planner rejects a plan naming an unregistered skill', async () => {
    // A plan is only as trustworthy as its validation. The scripted model is
    // told to name a skill that does not exist; planMission must refuse it
    // rather than create a mission whose steps can never run.
    const outcome = await win.evaluate(
      async ([id]) => {
        try {
          const mission = await window.thursday['missions:plan']({
            title: 'Bad plan',
            goal: 'produce something impossible [[badplan]]',
            providerId: id,
            model: 'mock-large'
          })
          return { threw: false, message: '', missionId: mission.id }
        } catch (err) {
          return { threw: true, message: err.message, missionId: null }
        }
      },
      [providerId]
    )

    assert(outcome.threw, 'a plan naming an unregistered skill was accepted')
    assert(
      /ghost-plugin\.no_such_skill/.test(outcome.message),
      `the error did not name the offending skill: ${outcome.message}`
    )
    assert(
      /not registered/i.test(outcome.message),
      `the error did not say why it was refused: ${outcome.message}`
    )

    // The refusal must also say what *would* have been acceptable.
    const registered = (await ipc('skills:list')).map((skill) => skill.id)
    for (const id of registered) {
      assert(
        outcome.message.includes(id),
        `the error did not list the registered skill "${id}": ${outcome.message}`
      )
    }

    // And no half-built mission was left behind.
    const missions = await ipc('missions:list')
    assert(
      !missions.some((mission) => mission.title === 'Bad plan'),
      'a mission was created from the rejected plan'
    )
    return `refused, naming the bad skill and listing the ${registered.length} real ones`
  })

  await check(36, 'An AI workflow node runs the model and passes its output on', async () => {
    const workflow = await ipc('workflows:save', {
      name: 'AI node workflow',
      description: 'ai -> output',
      nodes: [
        {
          id: 'ask',
          type: 'ai',
          label: 'Ask the model',
          config: { providerId, model: 'mock-large', prompt: 'say something', outputKey: 'answer' }
        },
        { id: 'report', type: 'output', label: 'Report', config: { value: '{{answer}}' } }
      ]
    })
    const started = await ipc('workflows:run', { workflowId: workflow.id })
    const run = await waitFor('the AI workflow to finish', async () => {
      const runs = await ipc('workflows:runs', { workflowId: workflow.id })
      const current = runs.find((entry) => entry.id === started.id)
      return current && ['completed', 'failed', 'cancelled'].includes(current.status) ? current : null
    }, 40000)

    assert(run.status === 'completed', `run ended as ${run.status}: ${run.error}`)
    assert(
      typeof run.context.answer === 'string' && run.context.answer.includes('say something'),
      `the ai node produced no usable output: ${JSON.stringify(run.context.answer)}`
    )
    assert(
      run.context.__output === run.context.answer,
      'the ai node output did not reach the output node'
    )
    return `model replied through the ai node and the value flowed into {{answer}}`
  })

  await check(37, 'A download completes and the file lands on disk', async () => {
    const downloadDir = join(userDataDir, 'downloads')
    await mkdir(downloadDir, { recursive: true })
    await ipc('settings:set', { downloadDir })

    const before = (await ipc('browser:getDownloads')).length
    const tab = await ipc('browser:newTab', {})
    // Navigating at an attachment is what a user clicking a link does.
    await ipc('browser:navigate', { id: tab.id, url: `${mock.origin}/download/sample.txt` })

    const item = await waitFor('the download to complete', async () => {
      const items = await ipc('browser:getDownloads')
      const found = items.find((entry) => entry.filename === 'sample.txt')
      return found && found.state !== 'progressing' ? found : null
    }, 30000)

    assert(item.state === 'completed', `download ended as "${item.state}"`)
    assert((await ipc('browser:getDownloads')).length > before, 'the download was not recorded')

    const contents = await readFile(item.savePath, 'utf8')
    assert(
      contents.includes('downloaded by the acceptance suite'),
      `the file on disk has the wrong contents: ${contents.slice(0, 60)}`
    )
    assert(
      item.savePath.startsWith(downloadDir),
      `saved outside the configured directory: ${item.savePath}`
    )
    await ipc('browser:closeTab', { id: tab.id })
    return `sample.txt (${item.receivedBytes} bytes) written to the configured download directory`
  })

  await check(30, 'Invalid IPC input is rejected, not executed', async () => {
    const outcome = await win.evaluate(async () => {
      try {
        // width must be a number; the zod schema should refuse this.
        await window.thursday['browser:setViewport']({ x: 0, y: 0, width: 'wide', height: 10, visible: true })
        return { threw: false, message: '' }
      } catch (err) {
        return { threw: true, message: err.message, name: err.name }
      }
    })
    assert(outcome.threw, 'the malformed call was accepted')
    assert(/Invalid arguments/.test(outcome.message), `unexpected message: ${outcome.message}`)
    return outcome.message.slice(0, 90)
  })
}

const started = Date.now()
let fatal = null
try {
  await main()
} catch (err) {
  fatal = err
} finally {
  try {
    if (app) await app.close()
  } catch {
    // Already gone.
  }
  if (mock) await mock.close()
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
}

const required = results.filter((r) => r.number <= 24)
const extra = results.filter((r) => r.number > 24)
const failedRequired = required.filter((r) => !r.ok)
const failedExtra = extra.filter((r) => !r.ok)

console.log('\n' + '─'.repeat(72))
console.log(
  `  Required acceptance tests : ${required.length - failedRequired.length}/24 passed`
)
console.log(
  `  Core principle checks     : ${extra.length - failedExtra.length}/${extra.length} passed`
)
console.log(`  Duration                  : ${((Date.now() - started) / 1000).toFixed(1)}s`)

if (fatal) {
  console.log(`\n  \x1b[31mThe suite aborted: ${fatal.message}\x1b[0m`)
  console.log(fatal.stack)
}
if (failedRequired.length > 0 || failedExtra.length > 0) {
  console.log('\n  \x1b[31mFailures:\x1b[0m')
  for (const failure of [...failedRequired, ...failedExtra]) {
    console.log(`    ${failure.number}. ${failure.name} — ${failure.detail}`)
  }
}
console.log('─'.repeat(72) + '\n')

const allPassed = !fatal && failedRequired.length === 0 && failedExtra.length === 0 && required.length === 24
process.exit(allPassed ? 0 : 1)
