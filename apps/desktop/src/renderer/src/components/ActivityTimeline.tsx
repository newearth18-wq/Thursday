import type { DomainEvent } from '@jupiter/contracts'
import { intlLocale, useI18n, type MessageKey, type Translate } from '../i18n'
import { describeMissionEvent, isMissionEvent } from '../missionText'
import { useEventLog } from '../useEventLog'
import { Timeline, type TimelineEntry } from './Timeline'

/**
 * "What happened": Jupiter's persistent event log, live, in plain language.
 * Every entry is a stored event from Jupiter Core — nothing is added here.
 */

export function describeEvent(event: DomainEvent, t: Translate): Omit<TimelineEntry, 'details'> {
  const base = { id: event.eventId, at: event.occurredAt }
  if (isMissionEvent(event)) return { ...base, ...describeMissionEvent(event, t) }
  switch (event.type) {
    case 'core.started':
      return { ...base, tone: 'success', title: t('activity.coreStarted') }
    case 'core.stopped':
      return { ...base, tone: 'info', title: t('activity.coreStopped') }
    case 'core.crashed':
      return { ...base, tone: 'error', title: t('activity.coreCrashed') }
    case 'service.status_changed':
      return {
        ...base,
        tone:
          event.payload.status === 'FAILED'
            ? 'error'
            : event.payload.status === 'HEALTHY'
              ? 'success'
              : 'warning',
        title: t('activity.serviceStatus', {
          service: t(`service.${event.payload.serviceId}` as MessageKey),
          status: t(`status.${event.payload.status}`)
        })
      }
    case 'settings.changed':
      return {
        ...base,
        tone: 'info',
        title: t('activity.settingChanged', {
          setting: t(`settingName.${event.payload.key}` as MessageKey)
        })
      }
    case 'error.recorded':
      return {
        ...base,
        tone: 'error',
        title: t('activity.errorRecorded', { code: event.payload.error.code })
      }
    case 'database.migrated':
      return {
        ...base,
        tone: 'info',
        title: t('activity.databaseMigrated', { version: event.payload.toVersion })
      }
    case 'database.backup_completed':
      return { ...base, tone: 'success', title: t('activity.backupCompleted') }
    case 'logging.level_applied':
      return {
        ...base,
        tone: 'info',
        title: t('activity.logLevel', { level: event.payload.level })
      }
    case 'ai.provider.changed':
      return {
        ...base,
        tone: event.payload.state === 'failed' ? 'warning' : 'info',
        title: t(`activity.provider.${event.payload.change}`)
      }
    case 'ai.route.fallback':
      return {
        ...base,
        tone: 'warning',
        title: t('activity.routeFallback', { code: event.payload.from.errorCode })
      }
    case 'ai.route.blocked':
      return {
        ...base,
        tone: 'warning',
        title: t('activity.routeBlocked', { mode: t(`routing.mode.${event.payload.mode}`) })
      }
    case 'chat.conversation.changed':
      return { ...base, tone: 'info', title: t(`activity.conversation.${event.payload.change}`) }
    case 'chat.message.changed':
      return {
        ...base,
        tone:
          event.payload.status === 'failed'
            ? 'error'
            : event.payload.status === 'cancelled'
              ? 'warning'
              : 'info',
        title:
          event.payload.change === 'superseded'
            ? t('activity.message.superseded')
            : event.payload.role === 'user'
              ? t('activity.message.sent')
              : t(`activity.answer.${event.payload.status}`)
      }
    case 'chat.message.delta':
      // Transient: never part of the stored event log.
      return { ...base, tone: 'info', title: t('activity.answer.streaming') }
  }
}

export function ActivityTimeline({ coreSession }: { readonly coreSession: string | null }) {
  const { t, locale } = useI18n()
  const { events, state } = useEventLog(30, coreSession)
  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(intlLocale(locale), {
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date(iso))
  const entries: TimelineEntry[] = [...events].reverse().map((event) => ({
    ...describeEvent(event, t),
    details: (
      <dl className="facts facts-compact">
        <div>
          <dt>{t('diagnostics.eventType')}</dt>
          <dd>
            <code>{event.type}</code>
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.eventStream')}</dt>
          <dd>
            {event.stream.kind}/{event.stream.id} #{event.streamSequence}
          </dd>
        </div>
        <div>
          <dt>{t('activity.correlation')}</dt>
          <dd>
            <code>{event.correlationId}</code>
          </dd>
        </div>
      </dl>
    )
  }))
  return (
    <section
      className="card"
      aria-labelledby="activity-title"
      data-testid="activity"
      data-state={state}
    >
      <div className="card-header">
        <h2 id="activity-title">{t('activity.title')}</h2>
        <span className="muted small" data-testid="activity-state">
          {t(`activity.state.${state}` as MessageKey)}
        </span>
      </div>
      <Timeline
        entries={entries}
        formatTime={formatTime}
        emptyText={
          state === 'waiting-for-core' ? t('activity.waitingForCore') : t('activity.empty')
        }
        testId="activity-timeline"
      />
    </section>
  )
}
