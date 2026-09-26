import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerAction, ComputerTask } from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, removeDir } from '@jupiter/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ComputerHost } from '../src/main/computer-host'
import { call, standard, startCore, stopCore, useCoreHarness, type Running } from './core-harness'
import {
  COMMON_MODES,
  availableModes,
  currentMode,
  setMode,
  type DisplayMode
} from './windows-display'

/**
 * SET 8 acceptance tests against the REAL Windows desktop: the real host
 * (computer-host.ts), the real agent runtime (a PowerShell process driving
 * Windows UI Automation), the real Notepad and real files. Jupiter Core runs
 * in-process with its real Permission Engine. These tests run only on
 * Windows (the CI Windows job); elsewhere they are skipped, never faked.
 */

const onWindows = process.platform === 'win32'

useCoreHarness('jupiter-computer-windows')

let folder: string
let evidence: string
let host: ComputerHost

beforeAll(async () => {
  if (!onWindows) return
  folder = await createTempDir('jupiter-computer-desktop')
  evidence = join(folder, 'evidence')
  mkdirSync(evidence, { recursive: true })
  host = new ComputerHost({
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] }),
    platform: 'win32',
    saveFolder: folder,
    evidenceFolder: evidence
  })
})

afterAll(async () => {
  if (!onWindows) return
  await host.stop()
  await removeDir(folder)
})

afterEach(async () => {
  if (!onWindows) return
  // Leave no Notepad or Explorer window of these tests behind.
  const { windows } = (await host.call({ op: 'listWindows', params: {} })) as {
    windows: { processId: number; processName: string; title: string }[]
  }
  for (const window of windows) {
    if (window.processName.toLowerCase() === 'notepad') {
      try {
        process.kill(window.processId)
      } catch {
        // Already gone.
      }
    }
  }
})

const notepad = { app: 'notepad' as const }
const editor = { role: 'editor' as const }

async function start(): Promise<Running> {
  return startCore(standard(), new Map(), [], {}, (input) => host.call(input))
}

async function run(running: Running, actions: ComputerAction[], allow = false, taskId = uuidv7()) {
  return call(running, 'computer.run', {
    taskId,
    title: 'Windows test',
    actions,
    allowCoordinateFallback: allow
  })
}

/** Runs a task, first answering its permission requests as the person would (Always allow). */
async function granted(
  running: Running,
  actions: ComputerAction[],
  allow = false
): Promise<ComputerTask> {
  const first = await run(running, actions, allow)
  if (first.status !== 'WAITING_APPROVAL') return first
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes('ALWAYS_ALLOW') ? 'ALWAYS_ALLOW' : 'ALLOW_ONCE'
    })
  return run(running, actions, allow)
}

function explain(task: ComputerTask): string {
  return JSON.stringify(
    {
      status: task.status,
      error: task.error,
      results: task.results.map((r) => [
        r.action,
        r.success,
        r.method,
        r.observation,
        r.error?.code
      ])
    },
    null,
    2
  )
}

function writeHello(fileName: string, text = 'Hello Jupiter'): ComputerAction[] {
  return [
    { type: 'OPEN_APP', app: 'notepad' },
    { type: 'TYPE_TEXT', window: notepad, element: editor, text },
    { type: 'SAVE_FILE', window: notepad, fileName, expectedText: text },
    { type: 'CLOSE_APP', window: notepad }
  ]
}

describe.runIf(onWindows)('SET 8 — Windows Computer Agent on the real desktop', () => {
  it('records what this Windows exposes for Notepad (diagnostic evidence)', async () => {
    // Printed to the CI log: the windows, the Notepad process and its UI Automation tree.
    const launched = (await host.call({ op: 'launch', params: { app: 'notepad' } })) as {
      processId: number
    }
    let notepadWindow: { handle: number; title: string; processName: string } | undefined
    for (let attempt = 0; attempt < 40 && !notepadWindow; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const { windows } = (await host.call({ op: 'listWindows', params: {} })) as {
        windows: { handle: number; title: string; processName: string; processId: number }[]
      }
      notepadWindow = windows.find((window) => window.processName.toLowerCase() === 'notepad')
      if (attempt === 39 || notepadWindow)
        console.log(
          '[SET 8 diagnostics] windows:',
          JSON.stringify(
            windows.map((window) => [window.processName, window.processId, window.title])
          )
        )
    }
    console.log(
      '[SET 8 diagnostics] launched process',
      launched.processId,
      'window',
      JSON.stringify(notepadWindow)
    )
    const os = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_OperatingSystem).Caption + " " + (Get-CimInstance Win32_OperatingSystem).Version; Get-Process notepad | Select-Object Id, Path, @{n="Version";e={$_.MainModule.FileVersionInfo.FileVersion}} | Format-List | Out-String'
      ],
      { encoding: 'utf8' }
    )
    console.log('[SET 8 diagnostics] system and Notepad:', os)
    expect(notepadWindow).toBeDefined()
    if (!notepadWindow) return
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const tree = (await host.call({
      op: 'readTree',
      params: { handle: notepadWindow.handle, depth: 8, maxNodes: 300 }
    })) as {
      nodes: {
        depth: number
        controlType: string
        name: string
        automationId: string
        className: string
      }[]
    }
    console.log(
      '[SET 8 diagnostics] UI tree:\n' +
        tree.nodes
          .map(
            (node) =>
              `${'  '.repeat(node.depth)}${node.controlType} name="${node.name}" id="${node.automationId}" class="${node.className}"`
          )
          .join('\n')
    )
    expect(tree.nodes.length).toBeGreaterThan(0)
  })

  it('AT1–AT4: opens the real Notepad, types the text, saves it semantically, and the file is verified on disk', async () => {
    const running = await start()
    const status = await call(running, 'computer.status', {})
    expect(status).toMatchObject({ available: true, platform: 'win32', saveFolder: folder })
    const task = await granted(running, writeHello('hello.txt'))
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    expect(task.results.map((result) => [result.action, result.success])).toEqual([
      ['OPEN_APP', true],
      ['TYPE_TEXT', true],
      ['SAVE_FILE', true],
      ['CLOSE_APP', true]
    ])
    expect(task.results[0]?.observation).toMatch(/Notepad/)
    expect(task.results[1]?.method).not.toBe('coordinate')
    const path = join(folder, 'hello.txt')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')).toBe('Hello Jupiter')
    expect(task.results[2]?.evidence).toMatchObject({ kind: 'file', path })
  })

  it('AT5: a missing UI element returns a structured failure', async () => {
    const running = await start()
    const task = await granted(running, [
      { type: 'OPEN_APP', app: 'notepad' },
      {
        type: 'CLICK_ELEMENT',
        window: notepad,
        element: { automationId: 'jupiter-no-such-control' }
      },
      { type: 'TYPE_TEXT', window: notepad, element: editor, text: 'never typed' }
    ])
    expect(task.status, explain(task)).toBe('FAILED')
    expect(task.error).toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
    expect(task.results.map((result) => [result.action, result.success])).toEqual([
      ['OPEN_APP', true],
      ['CLICK_ELEMENT', false]
    ])
  })

  it('AT6: cancel interrupts the agent; queued actions do not run', async () => {
    const running = await start()
    const actions: ComputerAction[] = [
      { type: 'OPEN_APP', app: 'notepad' },
      {
        type: 'WAIT_FOR_WINDOW',
        window: { app: 'notepad', titleContains: 'jupiter-never' },
        timeoutMs: 60_000
      },
      { type: 'TYPE_TEXT', window: notepad, element: editor, text: 'must not be typed' }
    ]
    await granted(running, [
      { type: 'OPEN_APP', app: 'notepad' },
      { type: 'WAIT_FOR_WINDOW', window: notepad, timeoutMs: 100 },
      { type: 'TYPE_TEXT', window: notepad, element: editor, text: 'x' }
    ])
    const taskId = uuidv7()
    const started = Date.now()
    const pending = run(running, actions, false, taskId)
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    expect(await call(running, 'computer.cancel', { taskId })).toEqual({ cancelled: true })
    const task = await pending
    expect(task.status, explain(task)).toBe('CANCELLED')
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(task.results.some((result) => result.action === 'TYPE_TEXT')).toBe(false)
  })

  it('AT7: an incorrect action cannot be reported as success', async () => {
    const running = await start()
    // The title bar takes no text: typing into it is refused, not "done".
    const typed = await granted(running, [
      { type: 'OPEN_APP', app: 'notepad' },
      { type: 'TYPE_TEXT', window: notepad, element: { controlType: 'TitleBar' }, text: 'nope' }
    ])
    expect(typed.status, explain(typed)).toBe('FAILED')
    expect(typed.results[1]).toMatchObject({ success: false })
    // A save whose content is not what was expected is a failure, although a file was written.
    const saved = await granted(running, [
      { type: 'OPEN_APP', app: 'notepad' },
      { type: 'TYPE_TEXT', window: notepad, element: editor, text: 'What was typed' },
      {
        type: 'SAVE_FILE',
        window: notepad,
        fileName: 'mismatch.txt',
        expectedText: 'Something else'
      }
    ])
    expect(saved.status, explain(saved)).toBe('FAILED')
    expect(saved.results[2]).toMatchObject({
      action: 'SAVE_FILE',
      success: false,
      error: { code: 'SAVE_NOT_VERIFIED' }
    })
    expect(existsSync(join(folder, 'mismatch.txt'))).toBe(true)
  })

  it('AT8: a screen-resolution change does not break semantic interaction', async () => {
    const before = currentMode()
    const same = (a: DisplayMode, b: DisplayMode) => a.width === b.width && a.height === b.height
    const candidates = [...availableModes(), ...COMMON_MODES].filter(
      (mode, index, all) =>
        !same(mode, before) && all.findIndex((other) => same(other, mode)) === index
    )
    // Change the resolution for real: the first mode Windows accepts and reports back.
    const attempts: string[] = []
    let changed: DisplayMode | null = null
    for (const mode of candidates) {
      const result = setMode(mode)
      const now = currentMode()
      attempts.push(
        `${String(mode.width)}x${String(mode.height)} → ${String(result)} (now ${String(now.width)}x${String(now.height)})`
      )
      if (result === 0 && same(now, mode)) {
        changed = mode
        break
      }
    }
    expect(
      changed,
      `Windows accepted no other resolution than ${String(before.width)}x${String(before.height)}: ${attempts.join('; ')}`
    ).not.toBeNull()
    const running = await start()
    try {
      // The window is also moved and resized: positions change, semantic interaction must not care.
      const task = await granted(running, [
        { type: 'OPEN_APP', app: 'notepad' },
        { type: 'MANAGE_WINDOW', window: notepad, operation: 'move', x: 10, y: 10 },
        { type: 'MANAGE_WINDOW', window: notepad, operation: 'resize', width: 520, height: 400 },
        ...writeHello('after-resolution-change.txt', 'Resolution changed').slice(1)
      ])
      // On failure, also say which windows the runtime sees now, whether Notepad still runs,
      // and what the Application event log recorded about it.
      const seen =
        task.status === 'SUCCEEDED'
          ? ''
          : JSON.stringify(
              (
                (await host.call({ op: 'listWindows', params: {} })) as {
                  windows: { processName: string; title: string; bounds: unknown }[]
                }
              ).windows.map((window) => [window.processName, window.title, window.bounds])
            ) +
            '\n' +
            execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                "Get-Process notepad -ErrorAction SilentlyContinue | Format-Table Id, MainWindowHandle, MainWindowTitle, Responding | Out-String -Width 200; Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-5)} -MaxEvents 30 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'notepad' } | Format-List TimeCreated, Id, ProviderName, Message | Out-String -Width 300"
              ],
              { encoding: 'utf8' }
            )
      expect(task.status, `${explain(task)}\n${attempts.join('; ')}\n${seen}`).toBe('SUCCEEDED')
      expect(
        readFileSync(join(folder, 'after-resolution-change.txt'), 'utf8').replace(/^\uFEFF/, '')
      ).toBe('Resolution changed')
    } finally {
      setMode(before)
    }
  })

  it('AT9: a crash of the automation runtime does not crash Jupiter', async () => {
    const running = await start()
    await granted(running, [
      { type: 'LIST_WINDOWS' },
      { type: 'WAIT_FOR_WINDOW', window: notepad, timeoutMs: 100 }
    ])
    const pid = host.runtimePid
    expect(pid).not.toBeNull()
    const taskId = uuidv7()
    const pending = run(
      running,
      [
        {
          type: 'WAIT_FOR_WINDOW',
          window: { app: 'notepad', titleContains: 'jupiter-never' },
          timeoutMs: 30_000
        }
      ],
      false,
      taskId
    )
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    process.kill(pid ?? 0)
    const crashed = await pending
    expect(crashed.status, explain(crashed)).toBe('FAILED')
    expect(crashed.error?.code).toMatch(/^RUNTIME_(CRASHED|TIMEOUT)$/)
    // Core carries on, and the next task starts a new runtime.
    const next = await run(running, [{ type: 'LIST_WINDOWS' }])
    expect(next.status, explain(next)).toBe('SUCCEEDED')
    expect(host.runtimePid).not.toBe(pid)
    expect((await call(running, 'computer.status', {})).runtime.restarts).toBeGreaterThanOrEqual(1)
  })

  it('AT10: the coordinate fallback is labelled, constrained to its window, and audited', async () => {
    const running = await start()
    await granted(running, [{ type: 'OPEN_APP', app: 'notepad' }])
    const refused = await run(
      running,
      [{ type: 'CLICK_POINT', window: notepad, x: 50, y: 80, reason: 'test' }],
      false
    )
    expect(refused.error?.code).toBe('COORDINATE_FALLBACK_DISABLED')
    const outside = await granted(
      running,
      [{ type: 'CLICK_POINT', window: notepad, x: 9_000, y: 80, reason: 'test' }],
      true
    )
    expect(outside.results[0]).toMatchObject({
      success: false,
      method: 'coordinate',
      error: { code: 'POINT_OUTSIDE_WINDOW' }
    })
    const inside = await run(
      running,
      [
        {
          type: 'CLICK_POINT',
          window: notepad,
          x: 200,
          y: 200,
          reason: 'No semantic control for this spot.'
        }
      ],
      true
    )
    expect(inside.status, explain(inside)).toBe('SUCCEEDED')
    expect(inside.results[0]).toMatchObject({ method: 'coordinate', success: true })
    expect(inside.results[0]?.observation).toContain('Coordinate fallback')
    const { entries } = await call(running, 'permissions.audit', { limit: 200 })
    expect(
      entries.some(
        (entry) => entry.capability === 'computer.click_point' && entry.outcome === 'ALLOWED'
      )
    ).toBe(true)
  })

  it('File Explorer adapter: opens the save folder and reads its controls; screenshots are kept as evidence', async () => {
    const running = await start()
    const task = await granted(running, [
      { type: 'OPEN_APP', app: 'explorer' },
      { type: 'READ_UI_TREE', window: { app: 'explorer' }, depth: 3, maxNodes: 80 },
      { type: 'SCREENSHOT', window: { app: 'explorer' } },
      { type: 'CLOSE_APP', window: { app: 'explorer' } }
    ])
    expect(task.status, explain(task)).toBe('SUCCEEDED')
    const shot = task.results[2]?.evidence
    expect(shot).toMatchObject({ kind: 'screenshot' })
    if (shot?.kind === 'screenshot') expect(existsSync(join(evidence, shot.file))).toBe(true)
  })

  it('keeps working after Jupiter Core restarts (the runtime belongs to the host)', async () => {
    const first = await start()
    await granted(first, [{ type: 'LIST_WINDOWS' }])
    await stopCore(first)
    const second = await start()
    expect((await run(second, [{ type: 'LIST_WINDOWS' }])).status).toBe('SUCCEEDED')
  })
})
