import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW,
  EMPTY_STATE,
  MIN_WINDOW,
  WindowStateStore,
  fitToDisplays,
  parseWindowState
} from './window-state'

const PRIMARY = { x: 0, y: 0, width: 1366, height: 728 }
const SECOND = { x: 1366, y: 0, width: 1920, height: 1040 }
const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jupiter-window-state-'))
  roots.push(dir)
  return dir
}

function logger() {
  const sink = new MemorySink()
  return { sink, logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] }) }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseWindowState', () => {
  it('accepts a saved state', () => {
    const state = {
      v: 1,
      bounds: { x: 10, y: 20, width: 1200, height: 700 },
      maximized: true,
      lastView: 'skills'
    }
    expect(parseWindowState(JSON.stringify(state))).toEqual({ state, problem: null })
  })

  it('falls back to defaults for broken, foreign or unsafe content', () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ v: 2, bounds: null, maximized: false, lastView: null }),
      JSON.stringify({ v: 1, bounds: null, maximized: false, lastView: 'javascript:alert(1)' }),
      JSON.stringify({
        v: 1,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        maximized: false,
        lastView: null
      }),
      JSON.stringify({ v: 1, bounds: null, maximized: false, lastView: null, extra: 1 })
    ]) {
      const { state, problem } = parseWindowState(raw)
      expect(state, raw).toEqual(EMPTY_STATE)
      expect(problem, raw).not.toBeNull()
    }
  })
})

describe('fitToDisplays', () => {
  it('centres the default size on the primary display when nothing was saved', () => {
    const bounds = fitToDisplays(null, [PRIMARY], PRIMARY)
    expect(bounds.width).toBe(Math.min(DEFAULT_WINDOW.width, PRIMARY.width))
    expect(bounds.height).toBe(Math.min(DEFAULT_WINDOW.height, PRIMARY.height))
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(PRIMARY.width)
  })

  it('restores saved bounds on the display they were on', () => {
    const saved = { x: 1500, y: 100, width: 1400, height: 900 }
    expect(fitToDisplays(saved, [PRIMARY, SECOND], PRIMARY)).toEqual(saved)
  })

  it('moves a window whose display was disconnected back onto the primary display', () => {
    const bounds = fitToDisplays({ x: 1500, y: 100, width: 1400, height: 900 }, [PRIMARY], PRIMARY)
    expect(bounds.x).toBeGreaterThanOrEqual(PRIMARY.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(PRIMARY.x + PRIMARY.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(PRIMARY.y + PRIMARY.height)
  })

  it('shrinks a window that is larger than its display, but never below the minimum size', () => {
    const bounds = fitToDisplays({ x: 0, y: 0, width: 3000, height: 2000 }, [PRIMARY], PRIMARY)
    expect(bounds).toEqual({ x: 0, y: 0, width: PRIMARY.width, height: PRIMARY.height })
    const tiny = { x: 0, y: 0, width: 640, height: 400 }
    const fitted = fitToDisplays({ x: 0, y: 0, width: 800, height: 600 }, [tiny], tiny)
    expect(fitted.width).toBe(MIN_WINDOW.width)
    expect(fitted.height).toBe(MIN_WINDOW.height)
  })

  it('does not restore a window whose title bar would be off screen', () => {
    const bounds = fitToDisplays({ x: 100, y: -500, width: 1000, height: 800 }, [PRIMARY], PRIMARY)
    expect(bounds.y).toBeGreaterThanOrEqual(PRIMARY.y)
  })
})

describe('WindowStateStore', () => {
  it('starts from defaults when there is no file, and reports nothing', () => {
    const { sink, logger: log } = logger()
    const store = new WindowStateStore(tempDir(), log, 0)
    expect(store.load()).toEqual(EMPTY_STATE)
    expect(sink.entries.filter((entry) => entry.level === 'warn')).toHaveLength(0)
  })

  it('reports an invalid file and uses defaults instead of failing', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'window-state.json'), '{"v":1,"bounds":"everywhere"}')
    const { sink, logger: log } = logger()
    expect(new WindowStateStore(dir, log, 0).load()).toEqual(EMPTY_STATE)
    expect(sink.entries.map((entry) => entry.event)).toContain('window-state.invalid')
  })

  it('writes atomically and reads back what it wrote', () => {
    const dir = tempDir()
    const store = new WindowStateStore(dir, logger().logger, 10_000)
    store.load()
    store.update({ bounds: { x: 5, y: 6, width: 1000, height: 700 }, lastView: 'memory' })
    expect(existsSync(store.path)).toBe(false)
    store.flush()
    expect(readdirSync(dir)).toEqual(['window-state.json'])
    const again = new WindowStateStore(dir, logger().logger, 0)
    expect(again.load()).toEqual({
      v: 1,
      bounds: { x: 5, y: 6, width: 1000, height: 700 },
      maximized: false,
      lastView: 'memory'
    })
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toMatchObject({ lastView: 'memory' })
  })
})
