import '@jupiter/ui/fonts.css'
import '@jupiter/ui/tokens.css'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { reportRendererError } from './api'
import { App } from './App'
import { ErrorBoundary, type ErrorReporter } from './components/ErrorBoundary'
import { I18nContext, createTranslator, detectLocale } from './i18n'

const locale = detectLocale(navigator.language)
document.documentElement.lang = locale

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

const root = document.getElementById('root')
if (!root) throw new Error('The #root element is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <I18nContext.Provider value={{ locale, t: createTranslator(locale) }}>
      <ErrorBoundary report={reportBoundaryError}>
        <App />
      </ErrorBoundary>
    </I18nContext.Provider>
  </StrictMode>
)
