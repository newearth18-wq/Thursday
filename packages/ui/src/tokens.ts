/**
 * Jupiter Visual Design Lock v1 — design tokens.
 *
 * The colour palette is locked by the product's visual contract; the other
 * groups (type, space, radius, shadow, glow, motion, layers, layout) are the
 * design system built on it. `tokens.css` mirrors every token as a CSS custom
 * property; a unit test keeps the two identical, so components use
 * `var(--jp-…)` and never hard-code a value.
 *
 * Sizes that should follow the person's text-size preference are in `rem`
 * (the interface scales the root font size); hairlines and small gaps stay in
 * `px`.
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

/** Translucent layers derived from the locked palette (cyan and primary text only). */
export const surfaces = {
  hover: 'rgb(72 217 255 / 0.06)',
  selected: 'rgb(72 217 255 / 0.12)',
  borderSubtle: 'rgb(72 217 255 / 0.08)',
  borderStrong: 'rgb(72 217 255 / 0.22)',
  scrim: 'rgb(9 13 20 / 0.72)'
} as const

/** Thai-first stack: Thai glyphs from Noto Sans Thai, Latin from Inter, then the OS. */
export const fontFamily = "'Noto Sans Thai', 'Inter', 'Segoe UI', system-ui, sans-serif"
export const monoFamily = "'Cascadia Mono', Consolas, ui-monospace, monospace"

/** Type scale in rem, so it follows the text-size preference. */
export const fontSize = {
  xs: '0.75rem',
  sm: '0.8125rem',
  md: '0.9375rem',
  lg: '1.125rem',
  xl: '1.375rem',
  xxl: '1.75rem'
} as const

export const fontWeight = { regular: 400, semibold: 600 } as const

/** Thai combining marks need more line height than Latin text. */
export const lineHeight = { body: 1.6, heading: 1.4, compact: 1.45 } as const

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const

export const shadow = {
  panel: '0 1px 0 rgb(237 247 255 / 0.03) inset, 0 8px 24px rgb(0 0 0 / 0.28)',
  overlay: '0 24px 64px rgb(0 0 0 / 0.55)'
} as const

/** Glow is used sparingly: focus, the AI core, and state accents. */
export const glow = {
  focus: '0 0 0 3px rgb(72 217 255 / 0.35)',
  core: '0 0 48px rgb(72 217 255 / 0.22)',
  success: '0 0 24px rgb(87 227 161 / 0.25)',
  warning: '0 0 24px rgb(241 184 91 / 0.22)',
  error: '0 0 24px rgb(255 107 120 / 0.22)'
} as const

export const motion = {
  /** Only for non-essential transitions; zeroed when Reduce Motion is on. */
  fastMs: 120,
  standardMs: 200,
  slowMs: 400,
  /**
   * Avatar idle rhythm (Visual Design Lock: slow breathing pulse, very slow
   * orbit). The rings sway a few degrees per cycle rather than spin, so the
   * mark keeps its silhouette.
   */
  breatheMs: 6000,
  orbitMs: 24000,
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
  easeExit: 'cubic-bezier(0.3, 0, 1, 1)'
} as const

/** Stacking order. Modal dialogs use the browser's top layer and sit above all of these. */
export const zIndex = { base: 0, sticky: 10, navigation: 20, menu: 300, toast: 400 } as const

export const layout = {
  sidebarWidth: '15rem',
  sidebarCompactWidth: '4.25rem',
  contentMaxWidth: '76rem',
  readableMaxWidth: '48rem'
} as const

/** CSS custom property name for a color token, e.g. `--jp-color-electric-cyan`. */
export function colorVariable(token: ColorToken): string {
  return `--jp-color-${kebab(token)}`
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** Every token as the CSS custom property `tokens.css` must declare. */
export function cssCustomProperties(): Record<string, string> {
  const properties: Record<string, string> = {}
  const add = (group: string, values: Readonly<Record<string, string | number>>, unit = '') => {
    for (const [name, value] of Object.entries(values)) {
      properties[`--jp-${group}-${kebab(name)}`] =
        typeof value === 'number' ? `${String(value)}${unit}` : value
    }
  }
  for (const [token, value] of Object.entries(colors))
    properties[colorVariable(token as ColorToken)] = value.toLowerCase()
  add('surface', surfaces)
  properties['--jp-font-family'] = fontFamily
  properties['--jp-font-mono'] = monoFamily
  add('font-size', fontSize)
  add('font-weight', fontWeight)
  add('line-height', lineHeight)
  add('space', spacing, 'px')
  add('radius', radius, 'px')
  add('shadow', shadow)
  add('glow', glow)
  properties['--jp-motion-fast'] = `${String(motion.fastMs)}ms`
  properties['--jp-motion-standard'] = `${String(motion.standardMs)}ms`
  properties['--jp-motion-slow'] = `${String(motion.slowMs)}ms`
  properties['--jp-motion-breathe'] = `${String(motion.breatheMs)}ms`
  properties['--jp-motion-orbit'] = `${String(motion.orbitMs)}ms`
  properties['--jp-ease-standard'] = motion.easeStandard
  properties['--jp-ease-exit'] = motion.easeExit
  add('z', zIndex)
  add('layout', layout)
  return properties
}
