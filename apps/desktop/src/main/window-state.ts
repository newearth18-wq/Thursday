import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { describeError, type Logger } from '@jupiter/core'
import { VIEW_IDS, type ViewId } from '../shared/views'

/**
 * The main window's session state: where it was, how big, whether it was
 * maximized, and which view was open. Owned by the host, because it is
 * needed before the window exists — before Jupiter Core has started.
 *
 * Stored in `<data folder>/window-state.json`:
 *   - validated on read; a missing, unreadable or invalid file means defaults
 *     (logged), never a crash;
 *   - written atomically (temporary file, then rename), so a crash mid-write
 *     leaves the previous state intact;
 *   - restored only onto a display that is still connected, and never larger
 *     than that display's work area.
 */

export const MIN_WINDOW = { width: 720, height: 480 } as const
export const DEFAULT_WINDOW = { width: 1280, height: 800 } as const

export const WindowState = z
  .object({
    v: z.literal(1),
    bounds: z
      .object({
        x: z.number().int().min(-100_000).max(100_000),
        y: z.number().int().min(-100_000).max(100_000),
        width: z.number().int().min(MIN_WINDOW.width).max(20_000),
        height: z.number().int().min(MIN_WINDOW.height).max(20_000)
      })
      .strict()
      .nullable(),
    maximized: z.boolean(),
    lastView: z.enum(VIEW_IDS).nullable()
  })
  .strict()
export type WindowState = z.infer<typeof WindowState>

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const EMPTY_STATE: WindowState = { v: 1, bounds: null, maximized: false, lastView: null }

export function parseWindowState(raw: string): { state: WindowState; problem: string | null } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { state: EMPTY_STATE, problem: `not valid JSON: ${describeError(error)}` }
  }
  const parsed = WindowState.safeParse(json)
  if (!parsed.success) {
    return {
      state: EMPTY_STATE,
      problem: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
    }
  }
  return { state: parsed.data, problem: null }
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * Where to put the window: the saved bounds if enough of them (a quarter,
 * including the top edge) is on a connected display's work area,
 * shrunk to fit that display; otherwise the default size, centred on the
 * primary display.
 */
export function fitToDisplays(saved: Rect | null, workAreas: readonly Rect[], primary: Rect): Rect {
  const centred = (area: Rect): Rect => {
    const width = Math.max(Math.min(DEFAULT_WINDOW.width, area.width), MIN_WINDOW.width)
    const height = Math.max(Math.min(DEFAULT_WINDOW.height, area.height), MIN_WINDOW.height)
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
      width,
      height
    }
  }
  if (!saved) return centred(primary)
  let best: Rect | null = null
  let bestArea = 0
  for (const area of workAreas) {
    const overlap = overlapArea(saved, area)
    if (overlap > bestArea) {
      best = area
      bestArea = overlap
    }
  }
  const titleBarVisible =
    best !== null && saved.y >= best.y - 8 && saved.y < best.y + best.height - 32
  // A quarter of the window (or of the display, for a window larger than it) must be visible.
  const needed = best ? Math.min(saved.width * saved.height, best.width * best.height) / 4 : 0
  if (!best || bestArea < needed || !titleBarVisible) return centred(primary)
  const width = Math.max(Math.min(saved.width, best.width), MIN_WINDOW.width)
  const height = Math.max(Math.min(saved.height, best.height), MIN_WINDOW.height)
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - width)
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - height)
  return { x, y, width, height }
}

export class WindowStateStore {
  private state: WindowState = EMPTY_STATE
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly file: string
  private readonly log: Logger

  constructor(
    directory: string,
    logger: Logger,
    private readonly delayMs = 400
  ) {
    this.file = join(directory, 'window-state.json')
    this.log = logger.child({ component: 'window-state' })
  }

  get path(): string {
    return this.file
  }

  load(): WindowState {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(
          'window-state.unreadable',
          `Could not read the saved window state; using defaults: ${describeError(error)}`
        )
      }
      this.state = EMPTY_STATE
      return this.state
    }
    const { state, problem } = parseWindowState(raw)
    if (problem) {
      this.log.warn(
        'window-state.invalid',
        `The saved window state is not valid and was ignored: ${problem}`
      )
    }
    this.state = state
    return state
  }

  get current(): WindowState {
    return this.state
  }

  update(change: Partial<Omit<WindowState, 'v'>>): void {
    this.state = { ...this.state, ...change }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, this.delayMs)
  }

  /** Write any pending change now (window closing, app quitting). */
  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.write()
  }

  private write(): void {
    const temporary = `${this.file}.${String(process.pid)}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(WindowState.parse(this.state), null, 2)}\n`, {
        mode: 0o600
      })
      renameSync(temporary, this.file)
    } catch (error) {
      rmSync(temporary, { force: true })
      this.log.warn(
        'window-state.write-failed',
        `Could not save the window state: ${describeError(error)}`
      )
    }
  }
}

export type { ViewId }
