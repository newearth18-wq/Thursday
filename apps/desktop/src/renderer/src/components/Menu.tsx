import { useEffect, useId, useRef, useState } from 'react'
import { Icon, type IconName } from '@jupiter/ui'

/**
 * Menu button (WAI-ARIA menu button pattern).
 *
 * Enter, Space or ArrowDown open the menu on the first item, ArrowUp on the
 * last. Arrow keys move, Home and End jump, Escape closes and returns focus
 * to the button, Tab closes and moves on. A click outside closes it.
 */

export interface MenuItem {
  readonly id: string
  readonly label: string
  readonly icon?: IconName
  readonly onSelect: () => void
}

export interface MenuProps {
  /** Accessible name of the button (also its tooltip). */
  readonly label: string
  readonly icon: IconName
  /** Visible text next to the icon; omit for an icon-only button. */
  readonly text?: string
  readonly items: readonly MenuItem[]
  readonly testId?: string
  readonly align?: 'start' | 'end'
  readonly placement?: 'below' | 'above'
}

export function Menu({
  label,
  icon,
  text,
  items,
  testId,
  align = 'start',
  placement = 'below'
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const [initial, setInitial] = useState<'first' | 'last'>('first')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const itemElements = () => [
    ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
  ]

  useEffect(() => {
    if (!open) return
    const elements = itemElements()
    ;(initial === 'last' ? elements.at(-1) : elements[0])?.focus()
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, initial])

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }

  return (
    <div className={`menu menu-${align} menu-${placement}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={text ? 'button button-quiet menu-button' : 'icon-button menu-button'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={text ? undefined : label}
        title={label}
        data-testid={testId}
        onClick={() => {
          setInitial('first')
          setOpen((value) => !value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setInitial(event.key === 'ArrowUp' ? 'last' : 'first')
            setOpen(true)
          }
        }}
      >
        <Icon name={icon} />
        {text ? <span>{text}</span> : null}
      </button>
      {open ? (
        <ul
          id={menuId}
          ref={menuRef}
          className="menu-list"
          role="menu"
          aria-label={label}
          data-testid={testId ? `${testId}-list` : undefined}
          onKeyDown={(event) => {
            const elements = itemElements()
            const index = elements.findIndex((element) => element === document.activeElement)
            const focus = (next: number) => {
              elements[(next + elements.length) % elements.length]?.focus()
            }
            switch (event.key) {
              case 'ArrowDown':
                event.preventDefault()
                focus(index + 1)
                break
              case 'ArrowUp':
                event.preventDefault()
                focus(index - 1)
                break
              case 'Home':
                event.preventDefault()
                focus(0)
                break
              case 'End':
                event.preventDefault()
                focus(elements.length - 1)
                break
              case 'Escape':
                event.preventDefault()
                event.stopPropagation()
                close(true)
                break
              case 'Tab':
                close(false)
                break
            }
          }}
        >
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                data-testid={`menu-item-${item.id}`}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                {item.icon ? <Icon name={item.icon} size={18} /> : null}
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
