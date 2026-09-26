/**
 * Permission catalogue.
 *
 * The infrastructure is built out now even though Alpha only *uses* a few of
 * these. A plugin can only ever receive permissions it declared in its
 * manifest AND that the user granted; anything else is denied at the gate.
 */
export const PERMISSIONS = [
  'browser.read',
  'browser.control',
  'filesystem.read',
  'filesystem.write',
  'computer.mouse',
  'computer.keyboard',
  'computer.apps',
  'camera',
  'microphone',
  'network',
  'trading.read',
  'trading.execute'
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Permissions Alpha is actually able to honour. Everything else is declared-only. */
export const IMPLEMENTED_PERMISSIONS: readonly Permission[] = [
  'browser.read',
  'filesystem.read',
  'filesystem.write',
  'network'
]

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'browser.read': 'Read the URL and title of open browser tabs',
  'browser.control': 'Navigate, open and close browser tabs',
  'filesystem.read': 'Read files inside the plugin data directory',
  'filesystem.write': 'Write files inside the plugin data directory',
  'computer.mouse': 'Control the mouse pointer (not implemented in Alpha)',
  'computer.keyboard': 'Send keystrokes (not implemented in Alpha)',
  'computer.apps': 'Launch and control other applications (not implemented in Alpha)',
  camera: 'Access the camera (not implemented in Alpha)',
  microphone: 'Access the microphone (not implemented in Alpha)',
  network: 'Make outbound network requests',
  'trading.read': 'Read trading account data (not implemented in Alpha)',
  'trading.execute': 'Place trades (not implemented in Alpha)'
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}
