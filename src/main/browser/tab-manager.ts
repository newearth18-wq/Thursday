import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import type { BrowserState, TabState } from '@shared/schemas.js'
import { emit } from '../core/events.js'
import { log } from '../core/logger.js'

/**
 * Browser Core.
 *
 * Owns tabs, navigation and the session. Deliberately has no dependency on
 * the AI core, the plugin engine or missions — the browser keeps working with
 * every one of those disabled or broken.
 *
 * Web pages are loaded into `WebContentsView`s (not `<webview>`), with
 * node integration off, context isolation on and the sandbox enabled, so
 * page JavaScript has no path to Node.
 */

interface Tab {
  id: string
  view: WebContentsView
  title: string
  favicon: string | null
}

const BLANK_URL = 'about:blank'

/** Reject anything that is not real web content (file://, javascript:, ...). */
export function normaliseUrl(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, error: 'Address is empty' }
  if (trimmed === BLANK_URL) return { ok: true, url: BLANK_URL }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  let candidate = trimmed
  if (!withScheme) {
    const looksLikeHost = /^[^\s/]+\.[^\s/]{2,}(\/|$|:)/.test(trimmed) || trimmed.startsWith('localhost')
    candidate = looksLikeHost
      ? `https://${trimmed}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid address` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Blocked "${parsed.protocol}" — only http and https pages can be opened` }
  }
  return { ok: true, url: parsed.toString() }
}

export class TabManager {
  private readonly tabs = new Map<string, Tab>()
  private order: string[] = []
  private activeId: string | null = null
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true

  constructor(private readonly window: BrowserWindow) {
    this.window.on('resize', () => this.applyBounds())
  }

  /* ----------------------------- lifecycle ---------------------------- */

  createTab(url?: string): TabState {
    const id = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // Web pages get no preload script at all: nothing of Thursday's
        // API surface is reachable from a loaded page.
        preload: undefined
      }
    })

    const tab: Tab = { id, view, title: 'New Tab', favicon: null }
    this.tabs.set(id, tab)
    this.order.push(id)
    this.window.contentView.addChildView(view)
    this.wireEvents(tab)

    this.setActive(id)

    const target = url ? normaliseUrl(url) : { ok: true as const, url: BLANK_URL }
    if (target.ok) {
      void this.loadUrl(tab, target.url)
    } else {
      log.warn('BROWSER', `New tab opened blank: ${target.error}`)
      void this.loadUrl(tab, BLANK_URL)
    }

    log.info('BROWSER', 'Tab created', { tabId: id, url: target.ok ? target.url : BLANK_URL })
    this.publish()
    return this.toState(tab)
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Cannot close tab ${id}: no such tab`)

    this.window.contentView.removeChildView(tab.view)
    // close() tears down the renderer process for the page.
    tab.view.webContents.close()
    this.tabs.delete(id)
    this.order = this.order.filter((tabId) => tabId !== id)

    if (this.activeId === id) {
      this.activeId = null
      const next = this.order[this.order.length - 1]
      if (next) this.setActive(next)
    }
    log.info('BROWSER', 'Tab closed', { tabId: id, remaining: this.tabs.size })
    this.publish()
  }

  setActive(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Cannot activate tab ${id}: no such tab`)
    this.activeId = id
    for (const [tabId, candidate] of this.tabs) {
      candidate.view.setVisible(this.visible && tabId === id)
    }
    this.applyBounds()
    this.publish()
  }

  /* ---------------------------- navigation ---------------------------- */

  navigate(id: string, url: string): void {
    const tab = this.require(id)
    const target = normaliseUrl(url)
    if (!target.ok) throw new Error(target.error)
    log.info('BROWSER', 'Navigate', { tabId: id, url: target.url })
    void this.loadUrl(tab, target.url)
  }

  goBack(id: string): void {
    const tab = this.require(id)
    const nav = tab.view.webContents.navigationHistory
    if (!nav.canGoBack()) throw new Error('There is no previous page in this tab')
    nav.goBack()
    log.info('BROWSER', 'Back', { tabId: id })
  }

  goForward(id: string): void {
    const tab = this.require(id)
    const nav = tab.view.webContents.navigationHistory
    if (!nav.canGoForward()) throw new Error('There is no next page in this tab')
    nav.goForward()
    log.info('BROWSER', 'Forward', { tabId: id })
  }

  reload(id: string): void {
    const tab = this.require(id)
    tab.view.webContents.reload()
    log.info('BROWSER', 'Reload', { tabId: id })
  }

  stop(id: string): void {
    this.require(id).view.webContents.stop()
  }

  /* ------------------------------ layout ------------------------------ */

  /**
   * The renderer measures the web-content area and reports it here, so the
   * page sits exactly inside the React layout's hole. `visible: false` hides
   * every tab, which is what lets full-screen UI (Settings, Command Center)
   * draw over the browser without the page punching through.
   */
  setViewport(rect: Rectangle & { visible: boolean }): void {
    this.bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    this.visible = rect.visible
    for (const [tabId, tab] of this.tabs) {
      tab.view.setVisible(this.visible && tabId === this.activeId)
    }
    this.applyBounds()
  }

  private applyBounds(): void {
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined
    if (!active) return
    const { x, y, width, height } = this.bounds
    active.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height))
    })
  }

  /* ------------------------------ state ------------------------------- */

  getState(): BrowserState {
    return {
      tabs: this.order
        .map((id) => this.tabs.get(id))
        .filter((tab): tab is Tab => tab !== undefined)
        .map((tab) => this.toState(tab)),
      activeTabId: this.activeId
    }
  }

  /** Read-only view used by the `browser.read` permission. */
  describeActiveTab(): { url: string; title: string } | null {
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined
    if (!active) return null
    return { url: active.view.webContents.getURL(), title: active.title }
  }

  destroy(): void {
    for (const id of [...this.tabs.keys()]) {
      try {
        this.closeTab(id)
      } catch {
        // Shutting down; a tab that is already gone is not an error.
      }
    }
  }

  /* ----------------------------- internals ---------------------------- */

  private require(id: string): Tab {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`No tab with id ${id}`)
    return tab
  }

  private async loadUrl(tab: Tab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url)
    } catch (err) {
      // ERR_ABORTED fires for ordinary redirects and user-cancelled loads.
      const message = (err as Error).message
      if (!message.includes('ERR_ABORTED')) {
        log.warn('BROWSER', `Navigation failed: ${message}`, { tabId: tab.id, url })
      }
    }
  }

  private toState(tab: Tab): TabState {
    const wc = tab.view.webContents
    return {
      id: tab.id,
      url: wc.getURL(),
      title: tab.title,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      favicon: tab.favicon
    }
  }

  private publish(): void {
    emit('browser:state', this.getState())
  }

  private wireEvents(tab: Tab): void {
    const wc = tab.view.webContents

    const republish = (): void => this.publish()
    wc.on('did-start-loading', republish)
    wc.on('did-stop-loading', republish)
    wc.on('did-navigate', republish)
    wc.on('did-navigate-in-page', republish)

    wc.on('page-title-updated', (_event, title) => {
      tab.title = title
      this.publish()
    })

    wc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] ?? null
      this.publish()
    })

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return
      log.warn('BROWSER', `Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`, {
        tabId: tab.id
      })
      tab.title = 'Failed to load'
      this.publish()
    })

    wc.on('render-process-gone', (_event, details) => {
      log.error('BROWSER', `Page process ended unexpectedly: ${details.reason}`, { tabId: tab.id })
      tab.title = 'Page crashed'
      this.publish()
    })

    // Popups become tabs; nothing escapes into an unmanaged window.
    wc.setWindowOpenHandler(({ url }) => {
      const target = normaliseUrl(url)
      if (target.ok) this.createTab(target.url)
      return { action: 'deny' }
    })

    // Web pages may not ask for OS-level capabilities in Alpha.
    wc.session.setPermissionRequestHandler((_contents, permission, callback) => {
      log.info('PERMISSION', `Denied web page permission "${permission}"`, { tabId: tab.id })
      callback(false)
    })
  }
}
