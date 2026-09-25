import type { OverallRuntimeStatus, ServiceStatus } from '@jupiter/contracts'
import { useI18n } from '../i18n'

type Tone = 'success' | 'warning' | 'error' | 'info' | 'muted'

const TONES: Record<ServiceStatus, Tone> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  STOPPED: 'warning',
  FAILED: 'error',
  STARTING: 'info',
  NOT_STARTED: 'info',
  COMING_LATER: 'muted',
  NOT_CONFIGURED: 'muted',
  UNAVAILABLE: 'muted',
  EXPERIMENTAL: 'warning'
}

export function StatusBadge({ status }: { readonly status: ServiceStatus | OverallRuntimeStatus }) {
  const { t } = useI18n()
  return (
    <span className={`badge badge-${TONES[status]}`} data-status={status}>
      {t(`status.${status}`)}
    </span>
  )
}
