// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nContext, createTranslator } from '../i18n'
import { ErrorBoundary, type ErrorReporter } from './ErrorBoundary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Broken(): never {
  throw new Error('The runtime panel exploded')
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // React logs caught render errors to the console; keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

async function renderBroken(report: ErrorReporter, locale: 'en' | 'th' = 'en') {
  await act(async () => {
    root.render(
      <I18nContext.Provider value={{ locale, t: createTranslator(locale) }}>
        <ErrorBoundary report={report}>
          <Broken />
        </ErrorBoundary>
      </I18nContext.Provider>
    )
    await Promise.resolve()
  })
}

describe('ErrorBoundary', () => {
  it('renders children when nothing fails', async () => {
    await act(async () => {
      root.render(
        <ErrorBoundary report={() => Promise.resolve(null)}>
          <p>fine</p>
        </ErrorBoundary>
      )
      await Promise.resolve()
    })
    expect(container.textContent).toBe('fine')
  })

  it('shows a truthful recovery screen with the real error and the log reference', async () => {
    const report = vi.fn<ErrorReporter>(() =>
      Promise.resolve('01a0d82f-22b6-762b-b369-29675d970dfd')
    )
    await renderBroken(report)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain('The runtime panel exploded')
    expect(container.textContent).toContain('Log reference: 01a0d82f-22b6-762b-b369-29675d970dfd')
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[0].message).toBe('The runtime panel exploded')
    expect(container.querySelector('button')?.textContent).toBe('Reload interface')
  })

  it('says so when the error could not be logged', async () => {
    await renderBroken(() => Promise.resolve(null), 'th')
    expect(container.textContent).toContain('ไม่สามารถบันทึกข้อผิดพลาดลงไฟล์บันทึกได้')
  })
})
