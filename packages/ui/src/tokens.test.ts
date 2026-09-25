import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { colorVariable, colors, fontFamily } from './tokens'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('Jupiter Visual Design Lock v1 tokens', () => {
  it('uses exactly the locked palette', () => {
    expect(colors).toEqual({
      graphiteBlack: '#090D14',
      midnightBlue: '#0D1626',
      deepPanel: '#111C2E',
      electricCyan: '#48D9FF',
      iceBlue: '#A7EDFF',
      violetAccent: '#8B7CFF',
      success: '#57E3A1',
      warning: '#F1B85B',
      error: '#FF6B78',
      textPrimary: '#EDF7FF',
      textSecondary: '#9DB1C7'
    })
  })

  it('mirrors every color token in tokens.css', () => {
    for (const [token, value] of Object.entries(colors)) {
      const variable = colorVariable(token as keyof typeof colors)
      // CSS hex colors are case-insensitive, and the formatter writes them in lowercase.
      expect(css.toLowerCase()).toContain(`${variable}: ${value.toLowerCase()};`)
    }
  })

  it('uses the Thai-first font stack in TS and CSS', () => {
    expect(fontFamily.startsWith("'Noto Sans Thai', 'Inter', 'Segoe UI'")).toBe(true)
    expect(css).toContain(`--jp-font-family: ${fontFamily};`)
  })

  it('switches motion off for Reduce Motion', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*--jp-motion-standard: 0ms/)
  })
})
