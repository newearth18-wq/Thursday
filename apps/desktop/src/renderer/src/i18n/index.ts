import { createContext, useContext } from 'react'
import { en, type MessageKey } from './en'
import { th } from './th'

export type Locale = 'en' | 'th'
export type { MessageKey }

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, th }

/**
 * Thai when the interface language is Thai, English otherwise. Chromium sets
 * `navigator.language` from the OS (or `--lang`). A language switch inside
 * Jupiter is part of SET 2.
 */
export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith('th') ? 'th' : 'en'
}

export type Translate = (
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>
) => string

export function createTranslator(locale: Locale): Translate {
  const catalog = catalogs[locale]
  return (key, values) => {
    const template = catalog[key]
    if (!values) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = values[name]
      return value === undefined ? match : String(value)
    })
  }
}

/** Intl locale tag used for dates and numbers. */
export function intlLocale(locale: Locale): string {
  return locale === 'th' ? 'th-TH' : 'en-US'
}

export interface I18n {
  readonly locale: Locale
  readonly t: Translate
}

export const I18nContext = createContext<I18n>({ locale: 'en', t: createTranslator('en') })

export function useI18n(): I18n {
  return useContext(I18nContext)
}
