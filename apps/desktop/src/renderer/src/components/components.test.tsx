// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext, createTranslator } from '../i18n'
import { Dialog } from './Dialog'
import { MissionCard, formatElapsed } from './MissionCard'
import { Menu } from './Menu'
import { ProgressIndicator, isMeasurable } from './Progress'
import { IdentityCheckDialog, PermissionRequestDialog } from './SecurityDialogs'
import { Tabs } from './Tabs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(node: ReactNode) {
  act(() => {
    root.render(
      <I18nContext.Provider value={{ locale: 'en', t: createTranslator('en') }}>
        {node}
      </I18nContext.Provider>
    )
  })
}

function key(target: Element, keyName: string, options: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...options })
    )
  })
}

function byTestId(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!element) throw new Error(`no element with data-testid="${id}"`)
  return element
}

function active(): Element {
  const element = document.activeElement
  if (!element) throw new Error('nothing has focus')
  return element
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-testid="opener"
        onClick={() => {
          setOpen(true)
        }}
      >
        open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        title="Title"
        description="Description"
        testId="dialog"
        footer={
          <>
            <button type="button" data-testid="first-action">
              one
            </button>
            <button type="button" data-testid="last-action">
              two
            </button>
          </>
        }
      />
    </>
  )
}

describe('Dialog', () => {
  it('is named and described, keeps focus inside, closes on Escape and restores focus', () => {
    render(<DialogHarness />)
    const opener = byTestId('opener')
    opener.focus()
    act(() => {
      opener.click()
    })
    const dialog = byTestId('dialog')
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Title'
    )
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe('Description')

    // First focusable control is the close button; Shift+Tab from it wraps to the last.
    const close = byTestId('dialog-close')
    expect(document.activeElement).toBe(close)
    key(close, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(byTestId('last-action'))
    key(byTestId('last-action'), 'Tab')
    expect(document.activeElement).toBe(close)

    // Escape arrives as the dialog's cancel event.
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(dialog.hasAttribute('open')).toBe(false)
    expect(document.activeElement).toBe(opener)
  })
})

describe('Menu', () => {
  it('opens from the keyboard, moves with arrows, closes on Escape back to its button', () => {
    const selected = vi.fn()
    render(
      <Menu
        label="Jupiter menu"
        icon="menu"
        testId="menu"
        items={[
          { id: 'a', label: 'Alpha', onSelect: selected },
          { id: 'b', label: 'Beta', onSelect: selected },
          { id: 'c', label: 'Gamma', onSelect: selected }
        ]}
      />
    )
    const button = byTestId('menu')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    button.focus()
    key(button, 'ArrowDown')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(byTestId('menu-item-a'))
    key(byTestId('menu-item-a'), 'ArrowUp')
    expect(document.activeElement).toBe(byTestId('menu-item-c'))
    key(byTestId('menu-item-c'), 'Home')
    expect(document.activeElement).toBe(byTestId('menu-item-a'))
    key(byTestId('menu-item-a'), 'End')
    expect(document.activeElement).toBe(byTestId('menu-item-c'))
    key(byTestId('menu-item-c'), 'Escape')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(button)

    // Opening from ArrowUp lands on the last item; activating an item runs it and closes.
    key(button, 'ArrowUp')
    expect(document.activeElement).toBe(byTestId('menu-item-c'))
    act(() => {
      byTestId('menu-item-b').click()
    })
    expect(selected).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })
})

function TabsHarness() {
  const [selected, setSelected] = useState<'one' | 'two' | 'three'>('one')
  return (
    <Tabs
      label="Sections"
      selected={selected}
      onSelect={setSelected}
      tabs={[
        { id: 'one', label: 'One', panel: <p>first</p> },
        { id: 'two', label: 'Two', panel: <p>second</p> },
        { id: 'three', label: 'Three', panel: <p>third</p> }
      ]}
    />
  )
}

describe('Tabs', () => {
  it('uses one tab stop and arrow keys, and links tabs to their panel', () => {
    render(<TabsHarness />)
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
    tabs[0]?.focus()
    key(active(), 'ArrowRight')
    expect(document.activeElement?.textContent).toBe('Two')
    expect(byTestId('tab-panel-two').textContent).toBe('second')
    key(active(), 'ArrowLeft')
    key(active(), 'ArrowLeft')
    expect(document.activeElement?.textContent).toBe('Three')
    key(active(), 'Home')
    expect(document.activeElement?.textContent).toBe('One')
    const panel = container.querySelector('[role="tabpanel"]')
    const current = container.querySelector('[role="tab"][aria-selected="true"]')
    expect(panel?.getAttribute('aria-labelledby')).toBe(current?.id)
    expect(current?.getAttribute('aria-controls')).toBe(panel?.id)
  })
})

describe('ProgressIndicator', () => {
  it('shows numbers only when both amounts are known', () => {
    expect(isMeasurable(3, 10)).toBe(true)
    expect(isMeasurable(null, 10)).toBe(false)
    expect(isMeasurable(3, null)).toBe(false)
    expect(isMeasurable(11, 10)).toBe(false)
    expect(isMeasurable(0, 0)).toBe(false)

    render(<ProgressIndicator label="Backup" completed={null} total={null} testId="p" />)
    expect(byTestId('p').dataset.measurable).toBe('false')
    expect(byTestId('p').querySelector('progress')?.hasAttribute('value')).toBe(false)
    expect(byTestId('p').textContent).toBe('Backup: in progress')

    render(<ProgressIndicator label="Backup" completed={3} total={12} testId="p" />)
    expect(byTestId('p').dataset.measurable).toBe('true')
    expect(byTestId('p').querySelector('progress')?.getAttribute('value')).toBe('3')
    expect(byTestId('p').textContent).toBe('Backup: 3 of 12 (25%)')
  })
})

describe('MissionCard', () => {
  it('says truthfully that no Mission is running, with no controls', () => {
    render(<MissionCard mission={null} />)
    const card = byTestId('mission-card')
    expect(card.dataset.state).toBe('empty')
    expect(card.textContent).toContain('No Mission is running.')
    expect(card.textContent).toContain('Start one in Missions')
    expect(card.querySelectorAll('button, progress')).toHaveLength(0)
  })

  it('shows a Mission with indeterminate progress when the total is unknown', () => {
    render(
      <MissionCard
        mission={{
          title: 'Summarise the report',
          currentAction: 'Reading report.pdf',
          completed: null,
          total: null,
          startedAt: new Date(Date.now() - 65_000).toISOString(),
          agent: null,
          skill: 'summarise',
          model: null
        }}
      />
    )
    expect(byTestId('mission-progress').dataset.measurable).toBe('false')
    expect(byTestId('mission-elapsed').textContent).toMatch(/^01:0[5-6]$/)
    // Without handlers the controls cannot pretend to do anything.
    const buttons = [...byTestId('mission-card').querySelectorAll('button')]
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, true])
    expect(formatElapsed(3725)).toBe('1:02:05')
  })
})

describe('permission and identity shells', () => {
  it('asks for an explicit answer, shows the exact target, and focuses Deny first', () => {
    const deny = vi.fn()
    const allow = vi.fn()
    render(
      <PermissionRequestDialog
        prompt={{
          capability: 'files.delete',
          target: 'C:\\Users\\me\\report.docx',
          risk: 'HIGH',
          reason: 'Clean up the draft',
          requestedBy: 'Mission 12'
        }}
        onAllowOnce={allow}
        onDeny={deny}
      />
    )
    const dialog = byTestId('permission-dialog')
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(byTestId('permission-target').textContent).toBe('C:\\Users\\me\\report.docx')
    expect(byTestId('permission-risk').textContent).toBe('High')
    expect(document.activeElement).toBe(byTestId('permission-deny'))
    expect(container.querySelector('[data-testid="dialog-close"]')).toBeNull()
    // Escape does not answer the question.
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(deny).not.toHaveBeenCalled()
    act(() => {
      byTestId('permission-allow').click()
    })
    expect(allow).toHaveBeenCalledTimes(1)
  })

  it('states that identity verification is unavailable and offers only Cancel', () => {
    const cancel = vi.fn()
    render(<IdentityCheckDialog open reason="Delete the vault" onCancel={cancel} />)
    expect(byTestId('identity-availability').textContent).toBe('Unavailable')
    const buttons = [...byTestId('identity-dialog').querySelectorAll('.dialog-footer button')].map(
      (button) => button.textContent
    )
    expect(buttons).toEqual(['Cancel'])
  })
})
