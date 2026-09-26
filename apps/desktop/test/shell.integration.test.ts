import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VIEW_IDS, type ViewId } from '../src/shared/views'
import {
  appDirectory,
  assertBuilt,
  gatewayStatus,
  query,
  readLog,
  serviceStatus,
  settledOverallStatus,
  waitForGateway
} from './helpers'

/**
 * SET 2 acceptance tests against the real application: real Electron, real
 * preload, real renderer, Jupiter Core in its utility process and SQLite in
 * a temporary profile. Screenshots of each checked layout are written to
 * test-results/set-02/ as evidence.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-02')
const UNFINISHED: readonly ViewId[] = [
  'missions',
  'skills',
  'memory',
  'files',
  'automations',
  'devices',
  'plugins'
]
/** The only labels the Global Contract allows for something that does not work yet. */
const TRUTHFUL_LABELS = ['Coming later', 'Unavailable', 'Not configured', 'Experimental']

beforeAll(() => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
})

async function launch(
  userDataDir: string,
  options: { lang?: string; extraArgs?: string[]; width?: number; height?: number } = {}
): Promise<LaunchedJupiter & { sizing: 'window' | 'emulated' }> {
  const jupiter = await launchJupiter({
    appDirectory,
    userDataDir,
    lang: options.lang ?? 'en-US',
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {})
  })
  const sizing = await resize(jupiter, options.width ?? 1366, options.height ?? 768)
  return Object.assign(jupiter, { sizing })
}

/**
 * Gives the interface a viewport of exactly `width`×`height`. A real window of
 * that size is used whenever the display can hold one (always under the
 * 4096×2304 Xvfb screen used locally and on Linux CI). On a smaller display —
 * such as a CI runner's default screen — no real window can be that large, so
 * Chromium's viewport emulation provides the same size instead; the method used
 * is returned and recorded with the evidence.
 */
async function resize(
  jupiter: LaunchedJupiter,
  width: number,
  height: number
): Promise<'window' | 'emulated'> {
  const fits = await jupiter.app.evaluate(
    ({ BrowserWindow, screen }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return false
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      const [outerWidth = 0, outerHeight = 0] = win.getSize()
      const [innerWidth = 0, innerHeight = 0] = win.getContentSize()
      const frame = { width: outerWidth - innerWidth, height: outerHeight - innerHeight }
      if (size.width + frame.width > area.width || size.height + frame.height > area.height)
        return false
      win.setPosition(area.x, area.y)
      win.setContentSize(size.width, size.height)
      return true
    },
    { width, height }
  )
  if (!fits) {
    const cdp = await jupiter.window.context().newCDPSession(jupiter.window)
    // deviceScaleFactor 0 keeps the real device pixel ratio.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false
    })
  }
  await jupiter.window.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    { width, height }
  )
  return fits ? 'window' : 'emulated'
}

async function open(page: Page, view: ViewId): Promise<void> {
  await page.getByTestId(`nav-${view}`).click()
  await page.getByTestId(`view-${view}`).waitFor()
}

async function ready(page: Page): Promise<void> {
  await page.waitForSelector('main#main')
  await page.waitForFunction(() => !document.querySelector('[data-testid="splash"]'))
}

async function setPreference(page: Page, tab: string, testId: string, value?: string) {
  await open(page, 'settings')
  await page.getByTestId(`tab-${tab}`).click()
  if (value === undefined) await page.getByTestId(testId).click()
  else if (testId === 'setting-text-scale') await page.getByTestId(testId).selectOption(value)
  else await page.getByTestId(`${testId}-${value}`).check()
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="settings-save-status"]')?.textContent ?? '') !== ''
  )
}

/** Running animations and transitions, on the whole page or only inside `scope`. */
function runningAnimations(page: Page, scope?: string): Promise<number> {
  return page.evaluate((selector) => {
    const within = selector ? document.querySelector(selector) : document.documentElement
    return document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running') return false
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
      return target !== null && within?.contains(target) === true
    }).length
  }, scope ?? null)
}

describe('SET 2 — navigation, persistence and language (real app)', () => {
  let userDataDir: string
  let jupiter: LaunchedJupiter
  const pageErrors: string[] = []

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-set2')
    jupiter = await launch(userDataDir)
    jupiter.window.on('pageerror', (error) => pageErrors.push(error.message))
    expect(await settledOverallStatus(jupiter.window)).toBe('HEALTHY')
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('AT1: every navigation destination renders without crashing', async () => {
    const page = jupiter.window
    for (const view of VIEW_IDS) {
      await open(page, view)
      const main = page.getByTestId(`view-${view}`)
      expect(await main.locator('h1').first().textContent(), view).not.toBe('')
      expect(await page.locator('.boundary').count(), view).toBe(0)
      expect(await page.getByTestId(`nav-${view}`).getAttribute('aria-current'), view).toBe('page')
      expect(page.url(), view).toBe(`jupiter://app/index.html#/${view}`)
    }
    // Also by address, the way a reload or the host's last-view restore opens them.
    for (const view of VIEW_IDS) {
      await page.evaluate((target) => {
        window.location.hash = `#/${target}`
      }, view)
      await page.getByTestId(`view-${view}`).waitFor()
    }
    // The window title (Windows title bar and taskbar) names the screen.
    await open(page, 'settings')
    expect(await page.title()).toBe('Settings — Jupiter')
    expect(
      await jupiter.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getTitle()
      )
    ).toBe('Settings — Jupiter')
    expect(await jupiter.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    expect(pageErrors).toEqual([])
    expect(
      readLog(userDataDir).entries.filter((entry) => entry.event === 'renderer.error')
    ).toEqual([])
  })

  it('AT2: a refresh keeps the selected view, and a restart reopens it where the window was', async () => {
    const page = jupiter.window
    await open(page, 'skills')
    await page.reload()
    await ready(page)
    await page.getByTestId('view-skills').waitFor()
    expect(await page.getByTestId('nav-skills').getAttribute('aria-current')).toBe('page')

    // An unknown address falls back to Home instead of an empty screen.
    await page.evaluate(() => {
      window.location.hash = '#/nowhere'
    })
    await page.getByTestId('view-home').waitFor()
    expect(page.url()).toBe('jupiter://app/index.html#/home')

    // Across a restart: the view, and the window's size and position.
    await open(page, 'memory')
    // Small enough to fit even a 1024×768 display, so the host has no reason to move it.
    const bounds = { x: 40, y: 30, width: 900, height: 600 }
    await jupiter.app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(target)
    }, bounds)
    await page.waitForTimeout(700)
    await jupiter.close()
    jupiter = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
    await ready(jupiter.window)
    await jupiter.window.getByTestId('view-memory').waitFor()
    const restored = await jupiter.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds()
    )
    for (const side of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((restored?.[side] ?? 0) - bounds[side]), side).toBeLessThanOrEqual(4)
    }
    await resize(jupiter, 1366, 768)
  })

  it('AT3: Thai and English switch without restarting, and the choice is kept', async () => {
    const page = jupiter.window
    const processes = async () => ({
      host: jupiter.app.process().pid,
      core: (await gatewayStatus(page)).core.pid
    })
    const before = await processes()

    await setPreference(page, 'general', 'setting-language', 'th')
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('th')
    expect(await page.getByTestId('nav-home').textContent()).toBe('หน้าหลัก')
    expect(await page.getByTestId('settings-save-status').textContent()).toBe('บันทึกแล้ว')
    expect(await page.title()).toBe('การตั้งค่า — Jupiter')
    await open(page, 'home')
    expect(await page.getByTestId('stage-status').textContent()).toBe('ว่าง')

    await setPreference(page, 'general', 'setting-language', 'en')
    expect(await page.getByTestId('nav-home').textContent()).toBe('Home')
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    expect(await processes()).toEqual(before)

    // Stored in Jupiter Core's database, so a new session opens in Thai.
    await setPreference(page, 'general', 'setting-language', 'th')
    const stored = await query(page, 'settings.list')
    expect(stored.settings).toContainEqual(
      expect.objectContaining({ key: 'ui.language', value: 'th', source: 'stored' })
    )
    await jupiter.close()
    jupiter = await launch(userDataDir)
    await ready(jupiter.window)
    await jupiter.window.waitForFunction(() => document.documentElement.lang === 'th')
    expect(await jupiter.window.getByTestId('nav-settings').textContent()).toBe('การตั้งค่า')
  })

  it('AT4: Thai text renders with Noto Sans Thai and nothing clips its marks', async () => {
    const page = jupiter.window
    await page.waitForFunction(() => document.documentElement.lang === 'th')
    const fonts = await page.evaluate(async () => {
      const loaded = await Promise.all([
        document.fonts.load('400 16px "Noto Sans Thai"', 'ปั้นที่สุด'),
        document.fonts.load('600 16px "Noto Sans Thai"', 'ปั้นที่สุด')
      ])
      return loaded.map((faces) => faces.map((face) => `${face.family} ${face.weight}`))
    })
    expect(fonts).toEqual([['Noto Sans Thai 400'], ['Noto Sans Thai 600']])

    const problems: string[] = []
    for (const view of VIEW_IDS) {
      await open(page, view)
      if (view === 'settings') {
        for (const tab of ['general', 'appearance', 'accessibility', 'notifications', 'advanced'])
          await page.getByTestId(`tab-${tab}`).click()
      }
      const found = await page.evaluate(() => {
        const canvas = document.createElement('canvas').getContext('2d')
        if (!canvas) return ['no canvas']
        const issues: string[] = []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let checked = 0
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? ''
          if (!/[฀-๿]/.test(text)) continue
          const element = node.parentElement
          // Screen-reader-only labels are clipped to 1px on purpose; they are never seen.
          if (!element?.checkVisibility() || element.closest('.visually-hidden')) continue
          const style = getComputedStyle(element)
          canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
          const ink = canvas.measureText(text.trim())
          const inkHeight = ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent
          const lineHeight = parseFloat(style.lineHeight)
          checked++
          // The marks above and below must fit inside the line box…
          if (!(inkHeight <= lineHeight + 0.5))
            issues.push(`${text.trim()}: ink ${inkHeight.toFixed(1)} > line ${lineHeight}`)
          // …and no box may cut the text off.
          for (let box: HTMLElement | null = element; box; box = box.parentElement) {
            const clip = getComputedStyle(box)
            if (/(hidden|clip)/.test(clip.overflowY) && box.scrollHeight > box.clientHeight + 1) {
              issues.push(`${text.trim()}: clipped by <${box.tagName.toLowerCase()}>`)
              break
            }
            if (box === document.body) break
          }
        }
        return checked === 0 ? ['no Thai text found'] : issues
      })
      problems.push(...found.map((issue) => `${view}: ${issue}`))
    }
    expect(problems).toEqual([])
    await open(page, 'settings')
    await page.screenshot({ path: join(EVIDENCE, 'thai-settings.png') })
    await open(page, 'home')
    await page.screenshot({ path: join(EVIDENCE, 'thai-home.png') })
    await setPreference(page, 'general', 'setting-language', 'en')
  })

  it('AT5: the keyboard alone reaches every control on every screen', async () => {
    const page = jupiter.window
    for (const view of VIEW_IDS) {
      await open(page, view)
      const expected = await page.evaluate(() => {
        const selector =
          'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
        const candidates = [...document.querySelectorAll<HTMLElement>(selector)].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !(element as HTMLButtonElement).disabled &&
            element.checkVisibility() &&
            !element.closest('dialog:not([open])')
        )
        // In a radio group only the checked option is a Tab stop; arrows move within it.
        const radios = new Set<string>()
        const tabbable = candidates.filter((element) => {
          if (!(element instanceof HTMLInputElement) || element.type !== 'radio') return true
          if (!element.checked || radios.has(element.name)) return false
          radios.add(element.name)
          return true
        })
        tabbable.forEach((element, index) => {
          element.dataset.kbd = String(index)
        })
        ;(document.activeElement as HTMLElement | null)?.blur()
        return tabbable.map((element) => element.dataset.kbd ?? '')
      })
      const seen = new Set<string>()
      for (let press = 0; press < expected.length + 5; press++) {
        await page.keyboard.press('Tab')
        const id = await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.kbd ?? ''
        )
        if (id) seen.add(id)
      }
      const missed = await page.evaluate(
        (ids) =>
          ids.map(
            (id) =>
              document.querySelector(`[data-kbd="${id}"]`)?.outerHTML.slice(0, 120) ?? `#${id}`
          ),
        expected.filter((id) => !seen.has(id))
      )
      expect(missed, view).toEqual([])
    }

    // Controls that move focus with arrow keys: tabs and radio groups.
    await open(page, 'settings')
    await page.getByTestId('tab-general').focus()
    for (const tab of ['appearance', 'accessibility', 'notifications', 'advanced', 'general']) {
      await page.keyboard.press('ArrowRight')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-tab'))).toBe(tab)
    }

    // Activating with the keyboard, and the documented shortcuts.
    await page.getByTestId('skip-link').focus()
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main')
    await page.keyboard.press('Control+3')
    await page.getByTestId('view-missions').waitFor()
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
    await page.keyboard.press('Control+,')
    await page.getByTestId('view-settings').waitFor()
    await page.keyboard.press('Control+Shift+D')
    await page.getByTestId('view-diagnostics').waitFor()
    await page.keyboard.press('F6')
    expect(await page.evaluate(() => document.activeElement?.closest('nav') !== null)).toBe(true)
    await page.keyboard.press('Enter')
    await page.getByTestId('view-home').waitFor()
  })

  it('AT6: modal dialogs keep focus inside and give it back when they close', async () => {
    const page = jupiter.window
    await open(page, 'home')
    const inside = (testId: string) =>
      page.evaluate(
        (id) => document.querySelector(`[data-testid="${id}"]`)?.contains(document.activeElement),
        testId
      )

    // Keyboard only: menu button → Keyboard shortcuts → dialog.
    await page.getByTestId('app-menu').focus()
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem')
    await page.keyboard.press('Enter')
    await page.getByTestId('shortcuts-dialog').waitFor()
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press(press % 2 === 0 ? 'Tab' : 'Shift+Tab')
      expect(await inside('shortcuts-dialog')).toBe(true)
    }
    for (let press = 0; press < 8; press++) {
      await page.keyboard.press('Tab')
      expect(await inside('shortcuts-dialog')).toBe(true)
    }
    // The page behind a modal dialog does not react to shortcuts.
    await page.keyboard.press('Control+3')
    expect(page.url()).toBe('jupiter://app/index.html#/home')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="shortcuts-dialog"]:not([open])', {
      state: 'hidden'
    })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'app-menu'
    )

    // A confirmation dialog opened from Settings returns focus to its button.
    await open(page, 'settings')
    await page.getByTestId('tab-advanced').click()
    await page.getByTestId('reset-preferences').focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('reset-dialog').waitFor()
    for (let press = 0; press < 6; press++) {
      await page.keyboard.press('Tab')
      expect(await inside('reset-dialog')).toBe(true)
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="reset-dialog"]:not([open])', { state: 'hidden' })
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'reset-preferences'
    )
  })

  it('AT7: Reduce Motion turns non-essential motion off', async () => {
    const page = jupiter.window
    await open(page, 'home')
    await page.waitForSelector('[data-testid="stage"][data-state="idle"]')
    expect(await page.getByTestId('stage').getAttribute('data-animated')).toBe('true')
    expect(await runningAnimations(page, '[data-testid="stage"]')).toBeGreaterThan(0)
    const navTransition = () =>
      page.evaluate(() => {
        const link = document.querySelector('.nav-link')
        return link ? getComputedStyle(link).transitionDuration : 'no nav link'
      })
    expect(await navTransition()).not.toBe('0s')

    await setPreference(page, 'accessibility', 'setting-reduce-motion', 'on')
    expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced')
    await open(page, 'home')
    expect(await page.getByTestId('stage').getAttribute('data-animated')).toBe('false')
    expect(await runningAnimations(page)).toBe(0)
    expect(await navTransition()).toBe('0s')

    // "Follow Windows" follows the operating system's setting, live.
    await setPreference(page, 'accessibility', 'setting-reduce-motion', 'system')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'full')

    // Static and hidden avatars never move, even with motion allowed (where short hover
    // transitions elsewhere still run); the status stays readable.
    await setPreference(page, 'accessibility', 'setting-avatar', 'static')
    await open(page, 'home')
    expect(await page.getByTestId('stage').getAttribute('data-animated')).toBe('false')
    await page.waitForTimeout(300)
    expect(await runningAnimations(page, '[data-testid="stage"]')).toBe(0)
    await setPreference(page, 'accessibility', 'setting-avatar', 'hidden')
    await open(page, 'home')
    expect(await page.getByTestId('stage').locator('svg').count()).toBe(0)
    expect(await page.getByTestId('stage-status').textContent()).toBe('Idle')
    await setPreference(page, 'accessibility', 'setting-avatar', 'animated')
  })

  it('AT10: no unfinished screen implies that its feature works', async () => {
    const page = jupiter.window
    for (const view of UNFINISHED) {
      await open(page, view)
      const main = page.getByTestId(`view-${view}`)
      expect(
        await main.locator('[data-availability]').first().getAttribute('data-availability')
      ).toBe('COMING_LATER')
      expect(await page.getByTestId('view-availability').textContent()).toBe('Coming later')
      const report = await page.evaluate(() => {
        const content = document.querySelector('main')
        if (!content) return null
        return {
          enabled: [
            ...content.querySelectorAll<HTMLButtonElement>(
              'button, input, select, textarea, a[href]'
            )
          ].filter((element) => !element.disabled).length,
          progress: content.querySelectorAll('progress, [role="progressbar"]').length,
          animations: document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect instanceof KeyframeEffect &&
                animation.effect.target instanceof Element &&
                content.contains(animation.effect.target)
            ).length,
          badges: [...content.querySelectorAll('.badge')].map((badge) => badge.textContent)
        }
      })
      expect(report, view).toMatchObject({ enabled: 0, progress: 0, animations: 0 })
      for (const badge of report?.badges ?? []) expect(TRUTHFUL_LABELS, view).toContain(badge)
    }
    // With no AI model set up (SET 3), the chat composer is disabled and says why.
    await open(page, 'chat')
    expect(await page.getByTestId('chat-view-composer').locator('textarea').isDisabled()).toBe(true)
    await expect
      .poll(() => page.getByTestId('chat-view-composer').getAttribute('data-availability'))
      .toBe('NOT_CONFIGURED')
    expect(await page.getByTestId('chat-view-composer-reason').textContent()).toContain(
      'Not configured'
    )
    // On Home, the Mission card and composer say the same.
    await open(page, 'home')
    expect(await page.getByTestId('mission-card').getAttribute('data-state')).toBe('empty')
    expect(await page.getByTestId('mission-card').locator('button').count()).toBe(0)
    const send = page.getByTestId('chat-composer').locator('button[type="submit"]')
    expect(await send.isDisabled()).toBe(true)
    // …and it does not look ready either: no accent fill on a button that cannot work.
    expect(await send.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)'
    )
    // Unfinished destinations in the navigation are announced as Coming later.
    for (const view of UNFINISHED) {
      expect(await page.getByTestId(`nav-${view}`).getAttribute('aria-describedby')).toBe(
        'nav-planned-heading'
      )
    }
  })
})

describe('SET 2 — AT8: layout at 1366×768 and 200% scaling', () => {
  // Sizes are CSS pixels (Windows "effective" pixels); scale is Windows display scaling.
  const cases = [
    { name: '1366x768-100', width: 1366, height: 768, scale: 1, text: '100' },
    { name: '1366x768-text200', width: 1366, height: 768, scale: 1, text: '200' },
    { name: '1366x768-dpr2', width: 1366, height: 768, scale: 2, text: '100' },
    // The smallest window Jupiter allows, on a 200% display.
    { name: '720x480-dpr2', width: 720, height: 480, scale: 2, text: '100' },
    // A 4K display at 200% and at 100%.
    { name: '4k-dpr2', width: 1920, height: 1080, scale: 2, text: '100' },
    { name: '4k-100', width: 3840, height: 2160, scale: 1, text: '100' }
  ] as const
  const record: Record<string, { sizing: string; devicePixelRatio: number }> = {}

  afterAll(() => {
    writeFileSync(join(EVIDENCE, 'layout-cases.json'), `${JSON.stringify(record, null, 2)}\n`)
  })

  for (const layout of cases) {
    it(`stays usable at ${layout.name}`, async () => {
      const userDataDir = await createTempDir('jupiter-set2-layout')
      const jupiter = await launch(userDataDir, {
        width: layout.width,
        height: layout.height,
        ...(layout.scale === 2 ? { extraArgs: ['--force-device-scale-factor=2'] } : {})
      })
      try {
        const page = jupiter.window
        await ready(page)
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(layout.scale)
        record[layout.name] = { sizing: jupiter.sizing, devicePixelRatio: layout.scale }
        if (layout.text !== '100') {
          await setPreference(page, 'appearance', 'setting-text-scale', layout.text)
          expect(
            await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)
          ).toBe('32px')
        }
        for (const view of VIEW_IDS) {
          await open(page, view)
          const report = await page.evaluate(() => {
            const width = document.documentElement.clientWidth
            const main = document.querySelector('main')
            if (!main) return null
            const outside = [...main.querySelectorAll<HTMLElement>('*')]
              .filter((element) => {
                if (element.closest('.table-scroll') || !element.checkVisibility()) return false
                const box = element.getBoundingClientRect()
                return box.width > 0 && box.right > width + 1
              })
              .slice(0, 3)
              .map((element) => element.outerHTML.slice(0, 80))
            const bar = document.querySelector('.top-bar')?.getBoundingClientRect()
            const menu = document.querySelector('[data-testid="app-menu"]')?.getBoundingClientRect()
            const indicators = document.querySelector('.indicators')?.getBoundingClientRect()
            const overlap =
              menu && indicators
                ? menu.left < indicators.right &&
                  menu.right > indicators.left &&
                  menu.top < indicators.bottom &&
                  menu.bottom > indicators.top
                : true
            return {
              pageOverflow: document.documentElement.scrollWidth - width,
              mainOverflow: main.scrollWidth - main.clientWidth,
              outside,
              barFits: (bar?.right ?? Infinity) <= width + 1,
              menuVisible: (menu?.right ?? Infinity) <= width + 1 && (menu?.width ?? 0) > 0,
              overlap,
              navReachable: [...document.querySelectorAll<HTMLElement>('.nav-link')].every(
                (link) => {
                  link.scrollIntoView({ block: 'nearest' })
                  const box = link.getBoundingClientRect()
                  return box.width > 0 && box.height > 0 && box.right <= width + 1
                }
              ),
              headingVisible: (main.querySelector('h1')?.getBoundingClientRect().width ?? 0) > 0
            }
          })
          expect(report, `${layout.name} ${view}`).toEqual({
            pageOverflow: 0,
            mainOverflow: 0,
            outside: [],
            barFits: true,
            menuVisible: true,
            overlap: false,
            navReachable: true,
            headingVisible: true
          })
        }
        await open(page, 'home')
        await page.screenshot({ path: join(EVIDENCE, `layout-${layout.name}-home.png`) })
        await open(page, 'settings')
        await page.screenshot({ path: join(EVIDENCE, `layout-${layout.name}-settings.png`) })
      } finally {
        await jupiter.close()
        await removeDir(userDataDir)
      }
    })
  }
})

describe('SET 2 — AT9: offline and service failures are shown truthfully', () => {
  let userDataDir: string
  let jupiter: LaunchedJupiter

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-set2-offline')
    jupiter = await launch(userDataDir)
    expect(await settledOverallStatus(jupiter.window)).toBe('HEALTHY')
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('reports the network connection as Chromium sees it', async () => {
    const page = jupiter.window
    const network = page.getByTestId('indicator-network')
    expect(await network.getAttribute('data-state')).toBe('online')
    await page.context().setOffline(true)
    await page.waitForSelector('[data-testid="indicator-network"][data-state="offline"]')
    expect(await network.textContent()).toBe('Offline')
    // Nothing in this build needs the network, so nothing else changes.
    expect(await page.getByTestId('stage').getAttribute('data-state')).toBe('idle')
    await page.context().setOffline(false)
    await page.waitForSelector('[data-testid="indicator-network"][data-state="online"]')
  })

  it('shows a Core crash as it happens, and its recovery only once it is real', async () => {
    const page = jupiter.window
    await open(page, 'home')
    const pid = (await gatewayStatus(page)).core.pid
    if (pid === null) throw new Error('Core has no pid')
    process.kill(pid, 'SIGKILL')
    await page.waitForSelector('[data-testid="indicator-core"][data-state="stopped"]')
    await page.waitForSelector('[data-testid="stage"][data-state="unavailable"]')
    expect(await page.getByTestId('stage-status').textContent()).toBe('Jupiter Core is not running')
    await page.waitForSelector('[data-testid="toast"][data-tone="warning"]')
    expect(
      await page.locator('[data-testid="toast"][data-tone="warning"]').textContent()
    ).toContain('Jupiter Core stopped unexpectedly')
    // Back only when Core really is.
    await waitForGateway(page, (status) => status.core.state === 'running')
    await page.waitForSelector('[data-testid="indicator-core"][data-state="running"]')
    await page.waitForSelector('[data-testid="toast"][data-tone="success"]')
  })

  it('falls back to the default when a stored preference is not valid for this version', async () => {
    await jupiter.close()
    const database = new DatabaseSync(join(userDataDir, 'jupiter.db'))
    const write = database.prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`
    )
    const by = JSON.stringify({ type: 'user-interface', id: 'renderer:main' })
    write.run('ui.language', JSON.stringify('klingon'), new Date().toISOString(), by)
    write.run('ui.textScale', JSON.stringify('900'), new Date().toISOString(), by)
    database.close()

    jupiter = await launch(userDataDir)
    const page = jupiter.window
    await ready(page)
    const { settings } = await query(page, 'settings.list')
    for (const key of ['ui.language', 'ui.textScale'])
      expect(settings.find((setting) => setting.key === key)).toMatchObject({ source: 'default' })
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      '16px'
    )
    expect(
      readLog(userDataDir)
        .entries.filter((entry) => entry.event === 'settings.value.invalid')
        .map((entry) => entry.data?.key)
    ).toEqual(expect.arrayContaining(['ui.language', 'ui.textScale']))
  })

  it('says preferences cannot be saved while the database is down, and saves them once it is back', async () => {
    await jupiter.close()
    rmSync(join(userDataDir, 'jupiter.db'), { force: true })
    rmSync(join(userDataDir, 'jupiter.db-wal'), { force: true })
    rmSync(join(userDataDir, 'jupiter.db-shm'), { force: true })
    mkdirSync(join(userDataDir, 'jupiter.db', 'blocker'), { recursive: true })
    jupiter = await launch(userDataDir)
    const page = jupiter.window
    await ready(page)
    await open(page, 'settings')
    await page.getByTestId('settings-unavailable').waitFor()
    // The notice gives the real reason from Jupiter Core, not a generic message.
    const notice = await page.getByTestId('settings-unavailable').textContent()
    expect(notice).toContain('Your saved preferences could not be read')
    expect(notice).toContain('"settings.list" needs database, which is not running.')
    await page.getByTestId('setting-language-th').check()
    // Applied at once, and truthfully reported as not saved.
    await page.waitForFunction(() => document.documentElement.lang === 'th')
    await page.waitForFunction(() =>
      (
        document.querySelector('[data-testid="settings-save-status"]')?.textContent ?? ''
      ).startsWith('ยังไม่ได้บันทึก')
    )
    // Shown as a warning, not in the success colour.
    const status = page.getByTestId('settings-save-status')
    expect(await status.getAttribute('data-state')).toBe('failed')
    expect(await status.evaluate((element) => getComputedStyle(element).color)).toBe(
      'rgb(241, 184, 91)'
    )

    rmSync(join(userDataDir, 'jupiter.db'), { recursive: true })
    await open(page, 'home')
    await page.getByTestId('retry-database').click()
    await waitForGateway(page, (status) => serviceStatus(status, 'database') === 'HEALTHY')
    await expect
      .poll(async () => (await query(page, 'settings.list')).settings)
      .toContainEqual(expect.objectContaining({ key: 'ui.language', value: 'th' }))
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('th')
  })
})
