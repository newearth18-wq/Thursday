import type { Translate } from './i18n'

export function formatBytes(t: Translate, bytes: number): string {
  if (bytes < 1024) return t('unit.bytes', { value: bytes })
  if (bytes < 1024 * 1024) return t('unit.kilobytes', { value: (bytes / 1024).toFixed(1) })
  return t('unit.megabytes', { value: (bytes / (1024 * 1024)).toFixed(1) })
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${String(h)}h ${String(m)}m`
    : m > 0
      ? `${String(m)}m ${String(s)}s`
      : `${String(s)}s`
}
