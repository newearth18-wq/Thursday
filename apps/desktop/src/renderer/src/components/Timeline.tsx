import { useId, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'

/**
 * Timeline: a human-readable list of things that happened, newest first.
 * It starts collapsed to the most recent entries and expands in place; each
 * entry can reveal its technical details.
 */
export interface TimelineEntry {
  readonly id: string
  readonly at: string
  readonly title: string
  readonly tone: 'info' | 'success' | 'warning' | 'error'
  readonly details?: ReactNode
}

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[]
  readonly collapsedCount?: number
  readonly formatTime: (iso: string) => string
  readonly emptyText: string
  readonly testId?: string
}

export function Timeline({
  entries,
  collapsedCount = 5,
  formatTime,
  emptyText,
  testId
}: TimelineProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const visible = expanded ? entries : entries.slice(0, collapsedCount)
  const hidden = entries.length - visible.length

  if (entries.length === 0) {
    return (
      <p className="muted small" data-testid={testId ? `${testId}-empty` : undefined}>
        {emptyText}
      </p>
    )
  }
  return (
    <div className="timeline" data-testid={testId}>
      <ol id={listId} className="timeline-list">
        {visible.map((entry) => (
          <li
            key={entry.id}
            className={`timeline-entry timeline-${entry.tone}`}
            data-testid="timeline-entry"
          >
            <span className="timeline-dot" aria-hidden="true" />
            <div className="timeline-content">
              <p className="timeline-title">{entry.title}</p>
              <p className="muted small">
                <time dateTime={entry.at}>{formatTime(entry.at)}</time>
              </p>
              {entry.details ? (
                <details className="timeline-details">
                  <summary>{t('timeline.details')}</summary>
                  {entry.details}
                </details>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {entries.length > collapsedCount ? (
        <button
          type="button"
          className="button button-quiet"
          aria-expanded={expanded}
          aria-controls={listId}
          data-testid={testId ? `${testId}-toggle` : undefined}
          onClick={() => {
            setExpanded((value) => !value)
          }}
        >
          {expanded ? t('timeline.showLess') : t('timeline.showAll', { count: hidden })}
        </button>
      ) : null}
    </div>
  )
}
