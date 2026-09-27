import { Icon } from '@jupiter/ui'
import { useI18n } from '../i18n'
import { useCamera } from '../vision/CameraProvider'

/**
 * Always visible while the camera is on (SET 13): it follows the real camera
 * track, not a guess, and says so in words, not only in colour.
 */
export function CameraIndicator() {
  const { t } = useI18n()
  const camera = useCamera()
  if (!camera.live) return null
  const paused = camera.status.state === 'ready' && camera.status.value.state === 'PAUSED'
  return (
    <li
      className="indicator indicator-mic"
      data-testid="indicator-camera"
      data-state={paused ? 'paused' : 'on'}
      data-device={camera.handle?.label ?? ''}
      role="status"
      title={t('camera.indicator.hint')}
    >
      <Icon name="camera" size={16} />
      <span>{t(paused ? 'camera.indicator.paused' : 'camera.indicator.on')}</span>
    </li>
  )
}
