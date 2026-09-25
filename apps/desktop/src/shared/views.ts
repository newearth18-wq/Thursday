/**
 * Every navigation destination of the Jupiter shell (SET 2), in sidebar
 * order. Shared by the renderer (hash routing) and the host (which remembers
 * the last view between launches and validates it before use).
 *
 * The URL fragment carries the view (`jupiter://app/index.html#/skills`), so
 * reloading the interface keeps the selected view without asking anyone.
 */
export const VIEW_IDS = [
  'home',
  'chat',
  'missions',
  'skills',
  'memory',
  'files',
  'automations',
  'models',
  'devices',
  'plugins',
  'settings',
  'diagnostics'
] as const

export type ViewId = (typeof VIEW_IDS)[number]

export const DEFAULT_VIEW: ViewId = 'home'

export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value)
}

/** `#/skills` → `skills`; anything else → null. */
export function viewFromHash(hash: string): ViewId | null {
  const match = /^#\/([a-z]+)$/.exec(hash)
  const candidate = match?.[1]
  return isViewId(candidate) ? candidate : null
}

export function hashForView(view: ViewId): `#/${ViewId}` {
  return `#/${view}`
}

/** The view encoded in a full interface URL, or null. */
export function viewFromUrl(raw: string): ViewId | null {
  try {
    return viewFromHash(new URL(raw).hash)
  } catch {
    return null
  }
}
