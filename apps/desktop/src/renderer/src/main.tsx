import '@jupiter/ui/fonts.css'
import '@jupiter/ui/tokens.css'
import './styles.css'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { reportRendererError } from './api'
import { App } from './App'
import { ErrorBoundary, type ErrorReporter } from './components/ErrorBoundary'
import { ToastProvider } from './components/Toasts'
import { I18nProvider } from './i18n/I18nProvider'
import { PreferencesProvider } from './preferences'
import { RuntimeContext, useRuntime } from './useRuntime'

// Until preferences load, follow the operating system for language and motion.
document.documentElement.lang = navigator.language.toLowerCase().startsWith('th') ? 'th' : 'en'
document.documentElement.dataset.motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  .matches
  ? 'reduced'
  : 'full'

const reportBoundaryError: ErrorReporter = (error, componentStack) =>
  reportRendererError({
    source: 'error-boundary',
    message: error.message.slice(0, 2000) || error.name,
    stack: error.stack?.slice(0, 8000) ?? null,
    componentStack: componentStack?.slice(0, 8000) ?? null
  })

window.addEventListener('error', (event) => {
  const error: unknown = event.error
  void reportRendererError({
    source: 'window-error',
    message: (event.message || 'Unknown error').slice(0, 2000),
    stack: error instanceof Error ? (error.stack?.slice(0, 8000) ?? null) : null,
    componentStack: null
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  void reportRendererError({
    source: 'unhandled-rejection',
    message:
      (reason instanceof Error ? reason.message : String(reason)).slice(0, 2000) ||
      'Unhandled rejection',
    stack: reason instanceof Error ? (reason.stack?.slice(0, 8000) ?? null) : null,
    componentStack: null
  })
})

function RuntimeProvider({ children }: { readonly children: ReactNode }) {
  return <RuntimeContext.Provider value={useRuntime()}>{children}</RuntimeContext.Provider>
}

const root = document.getElementById('root')
if (!root) throw new Error('The #root element is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <RuntimeProvider>
      <PreferencesProvider>
        <I18nProvider>
          <ErrorBoundary report={reportBoundaryError}>
            <ToastProvider>
              <App />
            </ToastProvider>
          </ErrorBoundary>
        </I18nProvider>
      </PreferencesProvider>
    </RuntimeProvider>
  </StrictMode>
)
