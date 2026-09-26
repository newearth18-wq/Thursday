import type { RouteDecision } from '@jupiter/contracts'
import { Icon } from '@jupiter/ui'
import { useI18n } from '../i18n'

/**
 * Which model answers (or answered): model, provider and where it runs. When
 * another model was used because the chosen one failed, that is said too.
 */
export function RouteBadge({
  route,
  testId
}: {
  readonly route: RouteDecision
  readonly testId?: string
}) {
  const { t } = useI18n()
  return (
    <span
      className="route-badge"
      data-testid={testId}
      data-locality={route.locality}
      data-model={route.modelId}
      data-provider={route.providerId}
      data-reason={route.reason}
    >
      <span className="route-model">
        <Icon name={route.locality === 'this-device' ? 'thisDevice' : 'cloud'} size={16} />
        <span>
          {t('route.model', {
            model: route.modelName ?? route.modelId,
            provider: route.providerName
          })}
        </span>
        <span className={`badge badge-${route.locality === 'this-device' ? 'info' : 'muted'}`}>
          {t(`locality.${route.locality}`)}
        </span>
      </span>
      {route.fallbackFrom ? (
        <span
          className="route-fallback"
          data-testid={testId ? `${testId}-fallback` : undefined}
          data-code={route.fallbackFrom.errorCode}
        >
          <Icon name="warning" size={16} />
          <span>
            {t('route.fallback', {
              model: route.fallbackFrom.modelId,
              provider: route.fallbackFrom.providerName,
              code: route.fallbackFrom.errorCode
            })}
          </span>
        </span>
      ) : null}
    </span>
  )
}
