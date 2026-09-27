import { useState } from 'react'
import type { MemoryStatus } from '@jupiter/contracts'
import { request } from '../api'
import { Switch } from '../components/FormControls'
import { StateMessage } from '../components/StateMessage'
import { Tabs } from '../components/Tabs'
import { intlLocale, useI18n } from '../i18n'
import { useMemory } from '../useMemory'
import { coreSessionOf, envelopeOf, useRuntimeContext } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import {
  AddMemoryPanel,
  CandidatesPanel,
  MemoriesPanel,
  ObsidianPanel,
  PolicyLogPanel
} from './MemoryPanels'
import { ViewHeader } from './ViewHeader'

/**
 * Memory (SET 11): what Jupiter remembers, why (every candidate gets a
 * policy decision with reasons), what waits for the person's answer, and
 * the Obsidian vault. The person can view, search, correct, forget, export
 * and delete memories. Sensitive memories stay hidden until revealed.
 */

type MemoryTab = 'memories' | 'add' | 'waiting' | 'policy' | 'obsidian'

export function MemoryView() {
  const { t, locale: language } = useI18n()
  const { status: runtime } = useRuntimeContext()
  const coreSession = coreSessionOf(runtime)
  const memory = useMemory(coreSession)
  // The list loads again when the Memory service's state changes (for example once it is running
  // after Jupiter starts), not only when a memory changes.
  const memoryService =
    runtime.state === 'ready'
      ? (runtime.value.runtime.services.find((service) => service.serviceId === 'memory')?.status ??
        null)
      : null
  const listKey =
    memory.reloadKey === null ? null : `${memory.reloadKey}|${memoryService ?? 'unknown'}`
  const [tab, setTab] = useState<MemoryTab>('memories')
  const locale = intlLocale(language)
  const formatTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—'
  const pending = memory.candidates.state === 'ready' ? memory.candidates.value.length : 0

  return (
    <section className="view view-memory" aria-labelledby="memory-title">
      <ViewHeader id="memory-title" title={t('nav.memory')} />
      <p className="muted">{t('memory.intro')}</p>
      {coreSession === null ? (
        <StateMessage kind="unavailable" title={t('memory.coreDown')} testId="memory-core-down" />
      ) : null}
      {memory.status.state === 'error' ? (
        <LoadFailure title={t('memory.statusFailed')} error={memory.status.error} />
      ) : null}
      {memory.status.state === 'ready' ? <StatusCard status={memory.status.value} /> : null}
      <Tabs<MemoryTab>
        label={t('nav.memory')}
        selected={tab}
        onSelect={setTab}
        testId="memory-tabs"
        tabs={[
          {
            id: 'memories',
            label: t('memory.tab.memories'),
            panel: <MemoriesPanel reloadKey={listKey} formatTime={formatTime} />
          },
          { id: 'add', label: t('memory.tab.add'), panel: <AddMemoryPanel /> },
          {
            id: 'waiting',
            label: t('memory.tab.waiting', { count: pending }),
            panel: <CandidatesPanel candidates={memory.candidates} formatTime={formatTime} />
          },
          {
            id: 'policy',
            label: t('memory.tab.policy'),
            panel: <PolicyLogPanel decisions={memory.decisions} formatTime={formatTime} />
          },
          {
            id: 'obsidian',
            label: t('memory.tab.obsidian'),
            panel: <ObsidianPanel status={memory.notes} formatTime={formatTime} />
          }
        ]}
      />
    </section>
  )
}

function StatusCard({ status }: { readonly status: MemoryStatus }) {
  const { t } = useI18n()
  const [saving, setSaving] = useState<string | null>(null)
  const semantic = status.semantic
  return (
    <section className="card" aria-labelledby="memory-status-title" data-testid="memory-status">
      <h2 id="memory-status-title">{t('memory.status.title')}</h2>
      <dl className="facts facts-compact memory-counts">
        <div>
          <dt>{t('memory.layer.long-term')}</dt>
          <dd data-testid="memory-count-long-term">{status.longTerm}</dd>
        </div>
        <div>
          <dt>{t('memory.layer.session')}</dt>
          <dd data-testid="memory-count-session">{status.session}</dd>
        </div>
        <div>
          <dt>{t('memory.status.forgotten')}</dt>
          <dd>{status.forgotten}</dd>
        </div>
        <div>
          <dt>{t('memory.status.sensitive')}</dt>
          <dd data-testid="memory-count-sensitive">{status.sensitive}</dd>
        </div>
        <div>
          <dt>{t('memory.status.pending')}</dt>
          <dd data-testid="memory-count-pending">{status.pending}</dd>
        </div>
      </dl>
      <p
        className="small"
        data-testid="memory-secure-storage"
        data-available={status.secureStorage.available}
      >
        <span className={`badge badge-${status.secureStorage.available ? 'success' : 'warning'}`}>
          {t(
            status.secureStorage.available ? 'memory.sealing.available' : 'availability.UNAVAILABLE'
          )}
        </span>{' '}
        {status.secureStorage.available
          ? t('memory.sealing.hint')
          : t('memory.sealing.unavailable', { reason: status.secureStorage.reason ?? '' })}
      </p>
      <Switch
        label={t('memory.semantic.setting')}
        description={t('memory.semantic.hint')}
        checked={semantic.enabled}
        testId="memory-semantic-setting"
        onChange={(next) => {
          setSaving(null)
          request('settings.update', { key: 'memory.semanticSearch', value: next }).then(
            () => {
              setSaving(t('settings.saved'))
            },
            (error: unknown) => {
              setSaving(t('settings.notSaved', { reason: envelopeOf(error).message }))
            }
          )
        }}
      />
      <p className="small" data-testid="memory-semantic-status" data-available={semantic.available}>
        {semantic.available
          ? t('memory.semantic.model', {
              model: semantic.modelId ?? '',
              provider: semantic.providerName ?? '',
              where: t(`memory.locality.${semantic.locality ?? 'this-device'}`)
            })
          : t('memory.semantic.none', { reason: semantic.reason ?? '' })}
      </p>
      <p className="muted small" role="status">
        {saving}
      </p>
    </section>
  )
}
