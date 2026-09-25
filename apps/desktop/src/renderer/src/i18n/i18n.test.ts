import { describe, expect, it } from 'vitest'
import { en } from './en'
import { createTranslator, detectLocale } from './index'
import { th } from './th'

describe('message catalogs', () => {
  it('define the same keys in English and Thai', () => {
    expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort())
  })

  it('have no empty strings and the same placeholders in both languages', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe('')
      expect(th[key].trim(), key).not.toBe('')
      const placeholders = (text: string) =>
        [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      expect(placeholders(th[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it('uses real Thai script for Thai copy', () => {
    expect(th['nav.home']).toMatch(/[฀-๿]/)
    expect(th['availability.COMING_LATER']).toBe('จะมาในภายหลัง')
  })

  it('labels every availability state with the contract vocabulary in English', () => {
    expect(en['availability.COMING_LATER']).toBe('Coming later')
    expect(en['availability.NOT_CONFIGURED']).toBe('Not configured')
    expect(en['availability.UNAVAILABLE']).toBe('Unavailable')
    expect(en['availability.EXPERIMENTAL']).toBe('Experimental')
  })
})

describe('translator', () => {
  it('interpolates values and leaves unknown placeholders visible', () => {
    const t = createTranslator('en')
    expect(t('nav.plannedFor', { set: 9 })).toBe('Planned for SET 9')
    expect(t('nav.plannedFor')).toBe('Planned for SET {set}')
    expect(createTranslator('th')('nav.plannedFor', { set: 9 })).toBe('กำหนดไว้ใน SET 9')
  })

  it('chooses Thai only for Thai locales', () => {
    expect(detectLocale('th')).toBe('th')
    expect(detectLocale('th-TH')).toBe('th')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale(undefined)).toBe('en')
  })
})
