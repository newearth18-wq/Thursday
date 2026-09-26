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

/**
 * Chat and Missions can also name one item: `#/chat/<conversationId>`,
 * `#/missions/<missionId>` (UUIDv7). No other view takes anything after its name.
 */
const HASH =
  /^#\/([a-z]+)(?:\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))?$/
const VIEWS_WITH_ITEMS: readonly ViewId[] = ['chat', 'missions']

/** `#/skills` → `skills`, `#/chat/<id>` → `chat`; anything else → null. */
export function viewFromHash(hash: string): ViewId | null {
  const match = HASH.exec(hash)
  const candidate = match?.[1]
  if (!isViewId(candidate)) return null
  return match?.[2] === undefined || VIEWS_WITH_ITEMS.includes(candidate) ? candidate : null
}

/** The item named in the address for `view` (`#/<view>/<id>`), or null. */
export function itemFromHash(hash: string, view: 'chat' | 'missions'): string | null {
  const match = HASH.exec(hash)
  return match?.[1] === view ? (match[2] ?? null) : null
}

export function hashForItem(view: 'chat' | 'missions', id: string | null): string {
  return id === null ? `#/${view}` : `#/${view}/${id}`
}

/** `#/chat/<id>` → the conversation id; anything else → null. */
export function conversationFromHash(hash: string): string | null {
  return itemFromHash(hash, 'chat')
}

export function hashForConversation(conversationId: string | null): string {
  return hashForItem('chat', conversationId)
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
