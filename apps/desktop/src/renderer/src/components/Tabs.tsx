import { useId, useRef, type ReactNode } from 'react'

/**
 * Tabs (WAI-ARIA tabs pattern, automatic activation). Only the selected tab
 * is in the Tab order; ArrowLeft/ArrowRight move between tabs (wrapping) and
 * select them, Home and End jump to the first and last.
 */

export interface TabDefinition<T extends string> {
  readonly id: T
  readonly label: string
  readonly panel: ReactNode
}

export interface TabsProps<T extends string> {
  readonly label: string
  readonly tabs: readonly TabDefinition<T>[]
  readonly selected: T
  readonly onSelect: (id: T) => void
  readonly testId?: string
}

export function Tabs<T extends string>({ label, tabs, selected, onSelect, testId }: TabsProps<T>) {
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const current = tabs.find((tab) => tab.id === selected) ?? tabs[0]

  const select = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length]
    if (!tab) return
    onSelect(tab.id)
    listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab.id}"]`)?.focus()
  }

  return (
    <div className="tabs" data-testid={testId}>
      <div
        ref={listRef}
        className="tab-list"
        role="tablist"
        aria-label={label}
        onKeyDown={(event) => {
          const index = tabs.findIndex((tab) => tab.id === current?.id)
          if (event.key === 'ArrowRight') select(index + 1)
          else if (event.key === 'ArrowLeft') select(index - 1)
          else if (event.key === 'Home') select(0)
          else if (event.key === 'End') select(tabs.length - 1)
          else return
          event.preventDefault()
        }}
      >
        {tabs.map((tab) => {
          const active = tab.id === current?.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              className="tab"
              data-tab={tab.id}
              data-testid={`tab-${tab.id}`}
              onClick={() => {
                onSelect(tab.id)
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {current ? (
        <div
          className="tab-panel"
          role="tabpanel"
          id={`${baseId}-panel-${current.id}`}
          aria-labelledby={`${baseId}-tab-${current.id}`}
          data-testid={`tab-panel-${current.id}`}
        >
          {current.panel}
        </div>
      ) : null}
    </div>
  )
}
