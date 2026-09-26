import { Icon } from '@jupiter/ui'
import type { ViewId } from '../../../shared/views'
import { StateMessage } from '../components/StateMessage'
import { destinationOf } from '../destinations'
import { useI18n, type MessageKey } from '../i18n'
import { ViewHeader } from './ViewHeader'

/**
 * Screens for systems that are not built yet. Each says exactly that —
 * "Coming later", which SET builds it, what the screen is for — and contains
 * no control that could look like it works.
 */

export type FeatureViewId = Exclude<
  ViewId,
  'home' | 'settings' | 'diagnostics' | 'chat' | 'models' | 'missions'
>

export function FeatureView({ view }: { readonly view: FeatureViewId }) {
  const { t } = useI18n()
  const destination = destinationOf(view)
  const titleId = `${view}-title`
  return (
    <section
      className="view view-feature"
      aria-labelledby={titleId}
      data-availability={destination.availability}
      data-testid="feature-view"
    >
      <ViewHeader id={titleId} title={t(destination.label)} plannedSet={destination.plannedSet} />
      <div className="feature-hero">
        <span className="feature-icon" aria-hidden="true">
          <Icon name={destination.icon} size={40} />
        </span>
        <p className="feature-purpose" data-testid="feature-purpose">
          {t(`feature.${view}` as MessageKey)}
        </p>
      </div>
      <StateMessage
        kind="unavailable"
        title={t('feature.notBuilt', { set: destination.plannedSet ?? '' })}
        testId="feature-state"
      >
        <p>{t('feature.nothingWorks')}</p>
      </StateMessage>
    </section>
  )
}
