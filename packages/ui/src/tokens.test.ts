import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { colors, cssCustomProperties, fontFamily } from './tokens'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

/** The custom properties declared in one rule block of tokens.css. */
function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`tokens.css has no ${selector} block`)
  const body = css.slice(start + selector.length + 2, css.indexOf('}', start))
  const result: Record<string, string> = {}
  for (const match of body.matchAll(/(--jp-[\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match
    if (name && value) result[name] = value.replace(/\s+/g, ' ').trim()
  }
  return result
}

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

  it('declares every token in tokens.css with the same value, and nothing else', () => {
    expect(declarations(':root')).toEqual(cssCustomProperties())
  })

  it('covers every token group SET 2 requires', () => {
    const names = Object.keys(cssCustomProperties())
    for (const group of [
      'color',
      'space',
      'radius',
      'font-size',
      'font-weight',
      'line-height',
      'shadow',
      'glow',
      'motion',
      'ease',
      'z'
    ]) {
      expect(
        names.some((name) => name.startsWith(`--jp-${group}-`)),
        group
      ).toBe(true)
    }
  })

  it('uses the Thai-first font stack', () => {
    expect(fontFamily.startsWith("'Noto Sans Thai', 'Inter', 'Segoe UI'")).toBe(true)
  })

  it('switches non-essential motion off for Reduce Motion', () => {
    expect(declarations(":root[data-motion='reduced']")).toEqual({
      '--jp-motion-fast': '0ms',
      '--jp-motion-standard': '0ms',
      '--jp-motion-slow': '0ms'
    })
  })
})
