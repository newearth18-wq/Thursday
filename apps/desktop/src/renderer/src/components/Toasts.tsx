import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { uuidv7 } from '@jupiter/core'
import { Icon } from '@jupiter/ui'
import { request } from '../api'
import { useI18n } from '../i18n'
import { usePreferences } from '../preferences'

/**
 * Toasts and the Windows-notification bridge.
 *
 * `notify()` always shows an in-app toast, announced politely to screen
 * readers (errors assertively). With `desktop: true` it also asks the host —
 * through the Core dispatcher — for a Windows notification, but only when the
 * person allows desktop notifications and Jupiter is in the background.
 * Toasts report things that really happened; nothing is announced ahead of
 * its result.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastInput {
  readonly tone: ToastTone
  readonly title: string
  readonly message?: string
  /** Also show as a desktop notification while Jupiter is in the background. */
  readonly desktop?: boolean
}

interface Toast extends ToastInput {
  readonly id: string
}

const AUTO_DISMISS_MS = 6000
const MAX_TOASTS = 4

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined)

export function useNotify(): (toast: ToastInput) => void {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const { values } = usePreferences()
  const desktopAllowed = values['notifications.desktop']

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (input: ToastInput) => {
      setToasts((current) => [...current, { ...input, id: uuidv7() }].slice(-MAX_TOASTS))
      if (input.desktop && desktopAllowed && !document.hasFocus()) {
        // The toast is the record; a failed desktop notification changes nothing else.
        void request('host.notifications.show', {
          tone: input.tone,
          title: input.title.slice(0, 120),
          body: (input.message ?? '').slice(0, 400)
        }).catch(() => undefined)
      }
    },
    [desktopAllowed]
  )

  const value = useMemo(() => notify, [notify])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastRegion({
  toasts,
  onDismiss
}: {
  readonly toasts: readonly Toast[]
  readonly onDismiss: (id: string) => void
}) {
  const { t } = useI18n()
  return (
    <section className="toast-region" aria-label={t('toast.region')} aria-live="polite">
      {toasts.map((toast) => (
        <ToastView key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </section>
  )
}

function ToastView({
  toast,
  onDismiss
}: {
  readonly toast: Toast
  readonly onDismiss: (id: string) => void
}) {
  const { t } = useI18n()
  const [paused, setPaused] = useState(false)
  const persistent = toast.tone === 'error' || toast.tone === 'warning'

  useEffect(() => {
    if (persistent || paused) return
    const timer = setTimeout(() => {
      onDismiss(toast.id)
    }, AUTO_DISMISS_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [persistent, paused, toast.id, onDismiss])

  return (
    <div
      className={`toast toast-${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-testid="toast"
      data-tone={toast.tone}
      onMouseEnter={() => {
        setPaused(true)
      }}
      onMouseLeave={() => {
        setPaused(false)
      }}
      onFocus={() => {
        setPaused(true)
      }}
      onBlur={() => {
        setPaused(false)
      }}
    >
      <Icon name={toast.tone} size={20} />
      <div className="toast-text">
        <p className="toast-title">{toast.title}</p>
        {toast.message ? <p className="toast-message">{toast.message}</p> : null}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label={t('toast.dismiss')}
        title={t('toast.dismiss')}
        onClick={() => {
          onDismiss(toast.id)
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
