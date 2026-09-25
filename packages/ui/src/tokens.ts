/**
 * Jupiter Visual Design Lock v1 — design tokens.
 *
 * These values are locked by the product's visual contract. `tokens.css`
 * mirrors them as CSS custom properties; a unit test keeps the two identical.
 */

export const colors = {
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
} as const

export type ColorToken = keyof typeof colors

/** Thai-first stack: Thai glyphs from Noto Sans Thai, Latin from Inter, then the OS. */
export const fontFamily = "'Noto Sans Thai', 'Inter', 'Segoe UI', system-ui, sans-serif"

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const

/** Thai combining marks need more line height than Latin text. */
export const lineHeight = { body: 1.6, heading: 1.35 } as const

export const motion = {
  /** Only for non-essential transitions; zeroed when Reduce Motion is on. */
  fastMs: 120,
  standardMs: 200
} as const

/** CSS custom property name for a color token, e.g. `--jp-color-electric-cyan`. */
export function colorVariable(token: ColorToken): string {
  return `--jp-color-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}
