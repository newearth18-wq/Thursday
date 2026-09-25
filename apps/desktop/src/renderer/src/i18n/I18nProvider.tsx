import { useEffect, useMemo, type ReactNode } from 'react'
import { usePreferences } from '../preferences'
import { I18nContext, createTranslator, localeFor } from './index'

/** Language follows the `ui.language` preference and changes without restarting. */
export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const { values } = usePreferences()
  const locale = localeFor(values['ui.language'], navigator.language)
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
