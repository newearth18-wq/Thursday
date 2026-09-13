import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState, TabState } from '@shared/schemas.js'
import { useStore } from '../state/store.js'

/* ------------------------------ tab strip ----------------------------- */

export function TabStrip(): JSX.Element {
  const { browser, reportError } = useStore()
  const api = window.thursday

  const act = (work: () => Promise<unknown>) => {
    void work().catch((err: unknown) => reportError((err as Error).message))
  }

  return (
    <div className="tabstrip">
      {browser.tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab${tab.id === browser.activeTabId ? ' active' : ''}`}
          onClick={() => act(() => api['browser:activateTab']({ id: tab.id }))}
          title={tab.url || tab.title}
        >
          {tab.favicon ? (
            <img className="tab-favicon" src={tab.favicon} alt="" />
          ) : (
            <span className="tab-favicon" style={{ background: 'var(--line)' }} />
          )}
          <span className="tab-title">{tab.loading ? 'Loading…' : tab.title || 'New Tab'}</span>
          <span
            className="tab-close"
            role="button"
            aria-label="Close tab"
            onClick={(event) => {
              event.stopPropagation()
              act(() => api['browser:closeTab']({ id: tab.id }))
            }}
          >
            ×
          </span>
        </button>
      ))}
      <button className="tab-new" title="New tab" onClick={() => act(() => api['browser:newTab']({}))}>
        +
      </button>
    </div>
  )
}

/* ----------------------------- address bar ---------------------------- */

function activeTab(browser: BrowserState): TabState | null {
  return browser.tabs.find((tab) => tab.id === browser.activeTabId) ?? null
}

export function AddressBar(): JSX.Element {
  const { browser, reportError } = useStore()
  const api = window.thursday
  const tab = activeTab(browser)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  // Follow the page while the user is not typing.
  useEffect(() => {
    if (!editing) setDraft(tab?.url === 'about:blank' ? '' : (tab?.url ?? ''))
  }, [tab?.url, editing])

  const act = (work: () => Promise<unknown>) => {
    void work().catch((err: unknown) => reportError((err as Error).message))
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!tab || draft.trim().length === 0) return
    setEditing(false)
    act(() => api['browser:navigate']({ id: tab.id, url: draft }))
  }

  const secure = tab?.url.startsWith('https://')

  return (
    <div className="addressbar">
      <button
        className="nav-btn"
        title="Back"
        disabled={!tab?.canGoBack}
        onClick={() => tab && act(() => api['browser:goBack']({ id: tab.id }))}
      >
        ←
      </button>
      <button
        className="nav-btn"
        title="Forward"
        disabled={!tab?.canGoForward}
        onClick={() => tab && act(() => api['browser:goForward']({ id: tab.id }))}
      >
        →
      </button>
      <button
        className="nav-btn"
        title={tab?.loading ? 'Stop' : 'Reload'}
        disabled={!tab}
        onClick={() =>
          tab && act(() => (tab.loading ? api['browser:stop']({ id: tab.id }) : api['browser:reload']({ id: tab.id })))
        }
      >
        {tab?.loading ? '×' : '↻'}
      </button>

      <form className="address-field" onSubmit={submit}>
        <input
          value={draft}
          spellCheck={false}
          placeholder={tab ? 'Search or enter address' : 'Open a tab to start browsing'}
          disabled={!tab}
          onChange={(event) => {
            setEditing(true)
            setDraft(event.target.value)
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setEditing(false)
              setDraft(tab?.url ?? '')
              event.currentTarget.blur()
            }
          }}
        />
        {secure && !editing ? <span className="address-lock">🔒</span> : null}
      </form>
    </div>
  )
}

/* ------------------------------ viewport ------------------------------ */

/**
 * The hole the page is drawn into.
 *
 * The page lives in a native WebContentsView owned by the main process, not in
 * this document, so this element's only job is to report its exact rectangle.
 */
export function BrowserStage(): JSX.Element {
  const { browser } = useStore()
  const holder = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = holder.current
    if (!element) return

    const report = (): void => {
      const rect = element.getBoundingClientRect()
      void window.thursday['browser:setViewport']({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: true
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  return (
    <div className="viewport" ref={holder}>
      {browser.tabs.length === 0 ? (
        <div className="viewport-empty">No tabs open — press + above to start browsing</div>
      ) : null}
    </div>
  )
}
