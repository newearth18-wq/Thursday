import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { Icon } from '@jupiter/ui'
import { useI18n } from '../i18n'

/**
 * Accessible modal dialog.
 *
 * - Uses the native `<dialog>` in modal mode, so everything behind it is
 *   inert for pointer, keyboard and screen readers.
 * - Keeps Tab and Shift+Tab inside the dialog, wrapping at the ends.
 * - Escape closes it (unless `dismissible` is false, for decisions that must
 *   be answered explicitly).
 * - On close, focus returns to the element that had it before opening.
 * - Named by its title and described by its description.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.closest('[inert]') &&
      // Hidden elements (display: none, visibility: hidden, collapsed <details>) cannot take focus.
      (typeof element.checkVisibility === 'function' ? element.checkVisibility() : true)
  )
}

export interface DialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly description?: ReactNode
  readonly children?: ReactNode
  readonly footer?: ReactNode
  /** Element to focus when the dialog opens; defaults to the first control. */
  readonly initialFocus?: RefObject<HTMLElement | null>
  /** False for dialogs that need an explicit answer: no Escape, no backdrop close. */
  readonly dismissible?: boolean
  readonly role?: 'dialog' | 'alertdialog'
  readonly testId?: string | undefined
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocus,
  dismissible = true,
  role = 'dialog',
  testId
}: DialogProps) {
  const { t } = useI18n()
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) {
        opener.current = document.activeElement
        if (typeof dialog.showModal === 'function') dialog.showModal()
        else dialog.setAttribute('open', '')
      }
      const target = initialFocus?.current ?? focusableWithin(dialog)[0] ?? dialog
      target.focus()
      return
    }
    if (dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
    const previous = opener.current
    opener.current = null
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
  }, [open, initialFocus])

  // Restore focus if the dialog is removed while open.
  useEffect(
    () => () => {
      const previous = opener.current
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    },
    []
  )

  return (
    <dialog
      ref={ref}
      className="dialog"
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-testid={testId}
      tabIndex={-1}
      onCancel={(event) => {
        // Escape: the dialog closes through state, never behind React's back.
        event.preventDefault()
        if (dismissible) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const dialog = ref.current
        if (!dialog) return
        const items = focusableWithin(dialog)
        const first = items[0]
        const last = items.at(-1)
        if (!first || !last) {
          event.preventDefault()
          return
        }
        const active = document.activeElement
        if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        } else if (!(active instanceof Node) || !dialog.contains(active)) {
          event.preventDefault()
          first.focus()
        }
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (dismissible && event.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className="dialog-body">
          <div className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            {dismissible ? (
              <button
                type="button"
                className="icon-button"
                aria-label={t('dialog.close')}
                title={t('dialog.close')}
                data-testid="dialog-close"
                onClick={onClose}
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
          {description ? (
            <div id={descriptionId} className="dialog-description">
              {description}
            </div>
          ) : null}
          {children}
          {footer ? <div className="dialog-footer">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}
