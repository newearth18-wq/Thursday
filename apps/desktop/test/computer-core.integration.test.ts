import type { ComputerAction, ComputerTask, PlanDraft } from '@jupiter/contracts'
import { uuidv7 } from '@jupiter/core'
import { describe, expect, it } from 'vitest'
import {
  call,
  failure,
  server,
  settled,
  standard,
  startCore,
  useCoreHarness,
  withModel,
  type Running
} from './core-harness'
import { FAKE_DESKTOP_FOLDER, FakeDesktop } from './fake-desktop'

/**
 * SET 8, the Computer Agent's logic in Jupiter Core (in-process): the real
 * kernel, dispatcher, Permission Engine and SQLite, with the Windows host
 * replaced by a clearly labelled test double (fake-desktop.ts) so faults can
 * be produced on demand. The same code against the real Notepad is tested on
 * Windows in computer-windows.integration.test.ts.
 */

useCoreHarness('jupiter-computer-core')

const notepad = { app: 'notepad' as const }
const editor = { controlType: 'Document' as const }

function writeHello(fileName = 'hello.txt', text = 'Hello Jupiter'): ComputerAction[] {
  return [
    { type: 'OPEN_APP', app: 'notepad' },
    { type: 'TYPE_TEXT', window: notepad, element: editor, text },
    { type: 'SAVE_FILE', window: notepad, fileName, expectedText: text },
    { type: 'CLOSE_APP', window: notepad }
  ]
}

async function start(): Promise<Running & { desktop: FakeDesktop }> {
  const desktop = new FakeDesktop()
  const running = await startCore(standard(), new Map(), [], {}, desktop.handler)
  return Object.assign(running, { desktop })
}

async function run(
  running: Running,
  actions: ComputerAction[],
  allowCoordinateFallback = false
): Promise<ComputerTask> {
  return call(running, 'computer.run', {
    taskId: uuidv7(),
    title: 'Write hello',
    actions,
    allowCoordinateFallback
  })
}

async function pending(running: Running) {
  return (await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })).requests
}

/** Answers every pending request as the person would, then returns what was asked. */
async function allowAll(
  running: Running,
  decision: 'ALLOW_ONCE' | 'ALWAYS_ALLOW' = 'ALWAYS_ALLOW'
) {
  const asked = await pending(running)
  for (const request of asked)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes(decision) ? decision : 'ALLOW_ONCE'
    })
  return asked
}

async function granted(
  running: Running & { desktop: FakeDesktop },
  actions: ComputerAction[],
  allow = false
) {
  const first = await run(running, actions, allow)
  if (first.status === 'WAITING_APPROVAL') await allowAll(running)
  return run(running, actions, allow)
}

describe('Computer Agent (logic, with a test double of the Windows host)', () => {
  it('asks for every permission first and touches nothing until they are given', async () => {
    const running = await start()
    const waiting = await run(running, writeHello())
    expect(waiting).toMatchObject({
      status: 'WAITING_APPROVAL',
      results: [],
      error: { code: 'PERMISSION_REQUIRED' }
    })
    expect(running.desktop.openWindows).toEqual([])
    expect(running.desktop.calls).not.toContain('launch')
    const asked = await pending(running)
    expect(asked.map((request) => [request.capability, request.target]).sort()).toEqual(
      [
        ['computer.open_app', 'app:notepad'],
        ['computer.type', 'app:notepad'],
        ['files.write', `${FAKE_DESKTOP_FOLDER}\\hello.txt`],
        ['computer.manage_window', 'app:notepad']
      ].sort()
    )
    expect(waiting.permissionRequests.sort()).toEqual(
      asked.map((request) => request.requestId).sort()
    )
    expect(asked[0]).toMatchObject({ subject: { kind: 'agent', id: 'computer' } })
  })

  it('AT1–AT4 logic: opens, types, saves semantically, verifies the file, and returns it', async () => {
    const running = await start()
    await run(running, writeHello())
    await allowAll(running, 'ALLOW_ONCE')
    const done = await run(running, writeHello())
    expect(done.status).toBe('SUCCEEDED')
    expect(done.results.map((result) => [result.action, result.success, result.method])).toEqual([
      ['OPEN_APP', true, 'system'],
      ['TYPE_TEXT', true, 'semantic'],
      ['SAVE_FILE', true, 'semantic'],
      ['CLOSE_APP', true, 'semantic']
    ])
    const path = `${FAKE_DESKTOP_FOLDER}\\hello.txt`
    expect(running.desktop.files.get(path)).toBe('Hello Jupiter')
    expect(done.results[2]?.evidence).toMatchObject({ kind: 'file', path, bytes: 13 })
    expect(done.results[2]?.observation).toContain('content equals the expected text')
    // What is stored never holds the typed text.
    const stored = JSON.stringify(await call(running, 'computer.tasks', { limit: 5 }))
    expect(stored).not.toContain('Hello Jupiter')
    // The single-use answers were used: the same task asks again.
    expect((await run(running, writeHello('again.txt'))).status).toBe('WAITING_APPROVAL')
  })

  it('AT5: a missing UI element is a structured failure, and nothing after it runs', async () => {
    const running = await start()
    running.desktop.faults.noEditor = true
    const failed = await granted(running, writeHello())
    expect(failed.status).toBe('FAILED')
    expect(failed.error).toMatchObject({ code: 'ELEMENT_NOT_FOUND', category: 'dependency' })
    expect(failed.results.map((result) => [result.action, result.success])).toEqual([
      ['OPEN_APP', true],
      ['TYPE_TEXT', false]
    ])
    expect(failed.results[1]).toMatchObject({ method: 'none', evidence: null })
    expect(running.desktop.files.size).toBe(0)
  })

  it('AT6: cancel stops the task at the next boundary; queued actions do not run', async () => {
    const running = await start()
    await granted(running, [{ type: 'LIST_WINDOWS' }])
    const taskId = uuidv7()
    const actions = writeHello()
    await run(running, actions)
    await allowAll(running)
    running.desktop.faults.delayMs = 300
    const task = call(running, 'computer.run', {
      taskId,
      title: 'Slow',
      actions,
      allowCoordinateFallback: false
    })
    await expect.poll(() => running.desktop.calls.includes('launch')).toBe(true)
    expect(await call(running, 'computer.cancel', { taskId })).toEqual({ cancelled: true })
    const cancelled = await task
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.results.length).toBeLessThan(actions.length)
    expect(running.desktop.files.size).toBe(0)
    expect(await call(running, 'computer.cancel', { taskId })).toEqual({ cancelled: false })
  })

  it('AT7: an action whose effect is not there is never reported as success', async () => {
    const running = await start()
    running.desktop.faults.editorIgnoresInput = true
    const typed = await granted(running, writeHello())
    expect(typed.status).toBe('FAILED')
    expect(typed.results[1]).toMatchObject({
      action: 'TYPE_TEXT',
      success: false,
      error: { code: 'ACTION_NOT_VERIFIED' }
    })

    running.desktop.faults.editorIgnoresInput = false
    running.desktop.faults.saveWritesWrongContent = true
    await run(running, [{ type: 'CLOSE_APP', window: notepad }])
    const saved = await run(running, writeHello('wrong.txt'))
    const again =
      saved.status === 'WAITING_APPROVAL'
        ? (await allowAll(running), await run(running, writeHello('wrong.txt')))
        : saved
    expect(again.status).toBe('FAILED')
    expect(again.results[2]).toMatchObject({
      action: 'SAVE_FILE',
      success: false,
      error: { code: 'SAVE_NOT_VERIFIED' }
    })
    expect(again.results.some((result) => result.action === 'SAVE_FILE' && result.success)).toBe(
      false
    )
  })

  it('never overwrites an existing file', async () => {
    const running = await start()
    running.desktop.files.set(`${FAKE_DESKTOP_FOLDER}\\hello.txt`, 'keep me')
    const failed = await granted(running, writeHello())
    expect(failed.results[2]).toMatchObject({ success: false, error: { code: 'FILE_EXISTS' } })
    expect(running.desktop.files.get(`${FAKE_DESKTOP_FOLDER}\\hello.txt`)).toBe('keep me')
  })

  it('re-resolves a window whose handle went stale', async () => {
    const running = await start()
    await granted(running, [{ type: 'LIST_WINDOWS' }])
    running.desktop.faults.newHandleAfterLists =
      running.desktop.calls.filter((op) => op === 'listWindows').length + 4
    const done = await granted(running, writeHello())
    expect(done.status).toBe('SUCCEEDED')
    expect(
      running.logs.entries.some((entry) => entry.event === 'computer.window.re-resolved')
    ).toBe(true)
  })

  it('AT9 logic: a runtime crash is a structured failure; Core carries on and the next task works', async () => {
    const running = await start()
    await granted(running, [{ type: 'LIST_WINDOWS' }])
    running.desktop.faults.crashOn = 'listWindows'
    const crashed = await run(running, [{ type: 'LIST_WINDOWS' }])
    expect(crashed).toMatchObject({
      status: 'FAILED',
      error: { code: 'RUNTIME_CRASHED', retryable: true }
    })
    const next = await run(running, [{ type: 'LIST_WINDOWS' }])
    expect(next.status).toBe('SUCCEEDED')
    expect((await call(running, 'diagnostics.snapshot', {})).core).toBeTruthy()
  })

  it('AT10: the coordinate fallback is refused unless allowed, asked for, kept inside the window, labelled and audited', async () => {
    const running = await start()
    await granted(running, [{ type: 'OPEN_APP', app: 'notepad' }])
    const click = (x: number, y: number): ComputerAction => ({
      type: 'CLICK_POINT',
      window: notepad,
      x,
      y,
      reason: 'The control has no automation id.'
    })

    const refused = await run(running, [click(10, 10)], false)
    expect(refused).toMatchObject({
      status: 'FAILED',
      results: [],
      error: { code: 'COORDINATE_FALLBACK_DISABLED' }
    })
    expect(running.desktop.clicks).toEqual([])

    const asking = await run(running, [click(10, 10)], true)
    expect(asking.status).toBe('WAITING_APPROVAL')
    const [request] = await pending(running)
    expect(request).toMatchObject({ capability: 'computer.click_point', risk: 'HIGH' })
    await allowAll(running)

    const outside = await run(running, [click(5_000, 10)], true)
    expect(outside.results[0]).toMatchObject({
      success: false,
      method: 'coordinate',
      error: { code: 'POINT_OUTSIDE_WINDOW' }
    })
    expect(running.desktop.clicks).toEqual([])

    const inside = await run(running, [click(40, 50)], true)
    expect(inside.results[0]).toMatchObject({ success: true, method: 'coordinate' })
    expect(inside.results[0]?.observation).toContain('Coordinate fallback')
    expect(inside.results[0]?.observation).toContain('not verified')
    expect(running.desktop.clicks).toEqual([{ x: 40, y: 50 }])
    const { entries } = await call(running, 'permissions.audit', { limit: 200 })
    expect(
      entries
        .filter((entry) => entry.capability === 'computer.click_point')
        .map((entry) => entry.action)
    ).toEqual(expect.arrayContaining(['requested', 'decided', 'grant-created', 'evaluated']))
  })

  it('says plainly when the host cannot run the agent', async () => {
    const running = await startCore(standard())
    const error = await failure(running, 'computer.status', {})
    expect(error.code).toBe('COMPUTER_UNAVAILABLE')
    const task = await run(running, [{ type: 'LIST_WINDOWS' }])
    expect(task).toMatchObject({ status: 'FAILED', error: { code: 'COMPUTER_UNAVAILABLE' } })
    const { stepTypes } = await call(running, 'missions.step-types', {})
    expect(stepTypes.find((type) => type.skillId === 'computer.notepad_write')).toMatchObject({
      available: false
    })
  })
})

describe('Computer Agent Mission step', () => {
  it('a Notepad step waits for the permissions, then saves and verifies the file', async () => {
    const running = await start()
    await withModel(running)
    const draft: PlanDraft = {
      goal: 'Save a greeting',
      assumptions: [],
      rationale: 'One Computer Agent step.',
      steps: [
        {
          id: 'save',
          title: 'Write Hello Jupiter to hello.txt',
          description: 'Notepad',
          skillId: 'computer.notepad_write',
          dependencies: [],
          input: { text: 'Hello Jupiter', fileName: 'hello.txt' },
          condition: null,
          timeoutMs: 120_000,
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
      expectedArtifacts: [],
      verificationPlan: { checks: [{ step: 'save', check: 'non-empty', description: 'Saved' }] }
    }
    server.enqueue({ chunks: [JSON.stringify(draft)] })
    const missionId = (
      await call(running, 'missions.create', {
        request: 'Open Notepad, type Hello Jupiter, save it to Desktop',
        planner: 'model'
      })
    ).mission.missionId
    await settled(running, missionId, 'WAITING_APPROVAL')
    expect(running.desktop.calls).not.toContain('launch')
    const asked = await pending(running)
    expect(
      asked.every(
        (request) =>
          request.missionId === missionId &&
          request.stepTitle === 'Write Hello Jupiter to hello.txt'
      )
    ).toBe(true)
    // The person answers each request as it comes; the step asks for what is still missing.
    for (let round = 0; round < 6; round++) {
      const open = await pending(running)
      if (open.length === 0) break
      for (const request of open)
        await call(running, 'permissions.decide', {
          requestId: request.requestId,
          decision: 'ALLOW_ONCE'
        })
      await expect
        .poll(async () => (await call(running, 'missions.get', { missionId })).mission.status)
        .not.toBe('RUNNING')
    }
    const done = await settled(running, missionId, 'COMPLETED')
    expect(running.desktop.files.get(`${FAKE_DESKTOP_FOLDER}\\hello.txt`)).toBe('Hello Jupiter')
    expect(done.artifacts[0]?.text).toContain(
      `Saved and verified ${FAKE_DESKTOP_FOLDER}\\hello.txt (13 bytes`
    )
  })
})
