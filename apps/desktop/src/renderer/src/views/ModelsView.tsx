import { useId, useState } from 'react'
import {
  CostLatencyPreference,
  FallbackPolicy,
  ModelCapability,
  RoutingMode,
  isProtectedTransport,
  localityOf,
  modelRef,
  type AdapterInfo,
  type ErrorEnvelope,
  type ModelInfo,
  type ProviderInfo,
  type SecureStorageStatus
} from '@jupiter/contracts'
import { Icon } from '@jupiter/ui'
import { request } from '../api'
import { Dialog } from '../components/Dialog'
import { RadioGroup, Select, Switch } from '../components/FormControls'
import { ConfirmDialog } from '../components/InfoDialogs'
import { RouteBadge } from '../components/RouteBadge'
import { StateMessage } from '../components/StateMessage'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import {
  useAdapters,
  useAiSettings,
  useProviders,
  useRoutePreview,
  useSecureStorage,
  type AiSettingKey,
  type AiSettings
} from '../useAi'
import { coreSessionOf, envelopeOf, useRuntimeContext, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import { ViewHeader } from './ViewHeader'

/**
 * AI Models (SET 3): the providers the person connected, their models, API
 * keys and routing. Every state shown was established by Jupiter Core — a
 * provider is "Ready" only after a real check reached it — and API keys go
 * straight to the operating system's secure storage: the interface sends a
 * key once and never gets it back (only a fingerprint).
 */

export function ModelsView() {
  const { t } = useI18n()
  const { status } = useRuntimeContext()
  const coreSession = coreSessionOf(status)
  const adapters = useAdapters(coreSession)
  const storage = useSecureStorage(coreSession)
  const { providers, replace } = useProviders(coreSession)
  const ai = useAiSettings(coreSession)
  const [adding, setAdding] = useState(false)

  return (
    <section className="view view-models" aria-labelledby="models-title">
      <ViewHeader id="models-title" title={t('nav.aiModels')}>
        <button
          type="button"
          className="button button-primary"
          data-testid="provider-add"
          disabled={adapters.state !== 'ready' || coreSession === null}
          onClick={() => {
            setAdding(true)
          }}
        >
          <Icon name="add" size={18} />
          <span>{t('models.addProvider')}</span>
        </button>
      </ViewHeader>
      <p className="muted">{t('feature.models')}</p>
      {coreSession === null ? (
        <StateMessage kind="unavailable" title={t('models.coreDown')} testId="models-core-down" />
      ) : null}

      <SecureStorageNotice storage={storage} />

      <section className="card" aria-labelledby="providers-title" data-testid="providers-card">
        <div className="card-header">
          <h2 id="providers-title">{t('models.providers')}</h2>
        </div>
        {providers.state === 'loading' ? <p>{t('load.loading')}</p> : null}
        {providers.state === 'error' ? (
          <LoadFailure title={t('models.loadFailed')} error={providers.error} />
        ) : null}
        {providers.state === 'ready' && providers.value.length === 0 ? (
          <StateMessage
            kind="empty"
            title={t('availability.NOT_CONFIGURED')}
            testId="providers-empty"
          >
            <p>{t('models.noProviders')}</p>
          </StateMessage>
        ) : null}
        {providers.state === 'ready' ? (
          <div className="provider-list">
            {providers.value.map((provider) => (
              <ProviderCard
                key={provider.providerId}
                provider={provider}
                adapter={
                  adapters.state === 'ready'
                    ? (adapters.value.find((item) => item.adapterId === provider.adapterId) ?? null)
                    : null
                }
                storage={storage}
                onChanged={replace}
              />
            ))}
          </div>
        ) : null}
      </section>

      <RoutingCard ai={ai} providers={providers} coreSession={coreSession} />

      <AddProviderDialog
        open={adding}
        adapters={adapters.state === 'ready' ? adapters.value : []}
        storage={storage}
        onClose={() => {
          setAdding(false)
        }}
        onAdded={(provider) => {
          replace(provider)
        }}
      />
    </section>
  )
}

function SecureStorageNotice({ storage }: { readonly storage: Loadable<SecureStorageStatus> }) {
  const { t } = useI18n()
  if (storage.state === 'loading') return null
  if (storage.state === 'error')
    return <LoadFailure title={t('models.storageUnknown')} error={storage.error} />
  const value = storage.value
  return (
    <p
      className={`notice ${value.available ? 'notice-info' : 'notice-warning'} storage-notice`}
      role="status"
      data-testid="secure-storage"
      data-available={value.available}
      data-backend={value.backend}
    >
      <Icon name="lock" size={18} />
      <span>
        {value.available ? (
          <>
            {t('models.storageAvailable')} <code>{value.backend}</code>
          </>
        ) : (
          <>
            <span className="badge badge-muted">{t('availability.UNAVAILABLE')}</span>{' '}
            {t('models.storageUnavailable', { reason: value.reason ?? '' })}
          </>
        )}
      </span>
    </p>
  )
}

// ---- providers ------------------------------------------------------------------------------

const STATE_TONES: Record<ProviderInfo['state'], string> = {
  'not-checked': 'muted',
  ready: 'success',
  'needs-key': 'warning',
  failed: 'error',
  blocked: 'warning',
  'adapter-missing': 'error'
}

function ProviderCard({
  provider,
  adapter,
  storage,
  onChanged
}: {
  readonly provider: ProviderInfo
  readonly adapter: AdapterInfo | null
  readonly storage: Loadable<SecureStorageStatus>
  readonly onChanged: (provider: ProviderInfo) => void
}) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)
  const titleId = useId()
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'medium'
  })

  const run = (key: string, action: () => Promise<ProviderInfo | null>) => {
    setBusy(key)
    setFailure(null)
    action()
      .then((result) => {
        if (result) onChanged(result)
      })
      .catch((error: unknown) => {
        setFailure(envelopeOf(error))
      })
      .finally(() => {
        setBusy(null)
      })
  }

  return (
    <article
      className="provider"
      aria-labelledby={titleId}
      data-testid="provider"
      data-provider-id={provider.providerId}
      data-state={provider.state}
      data-locality={provider.locality}
    >
      <header className="provider-header">
        <div>
          <h3 id={titleId}>{provider.displayName}</h3>
          <p className="muted small">
            {adapter?.displayName ?? provider.adapterId} · <code>{provider.baseUrl}</code>
          </p>
        </div>
        <div className="provider-badges">
          <span className="badge badge-muted" data-testid="provider-locality">
            <Icon name={provider.locality === 'this-device' ? 'thisDevice' : 'cloud'} size={14} />{' '}
            {t(`locality.${provider.locality}`)}
          </span>
          {provider.encrypted ? null : (
            <span className="badge badge-warning" data-testid="provider-unencrypted">
              {t('models.unencrypted')}
            </span>
          )}
          <span
            className={`badge badge-${STATE_TONES[provider.state]}`}
            data-testid="provider-state"
            data-state={provider.state}
          >
            {t(`providerState.${provider.state}`)}
          </span>
        </div>
      </header>

      <p className="muted small">{t(`providerStateHint.${provider.state}`)}</p>
      {provider.checkedAt ? (
        <p className="muted small">
          {t('models.checkedAt', { time: format.format(new Date(provider.checkedAt)) })}
        </p>
      ) : null}
      {provider.error && provider.state === 'failed' ? (
        <LoadFailure
          title={t('models.checkFailed')}
          error={provider.error}
          testId="provider-error"
        />
      ) : null}

      <div className="provider-actions">
        <Switch
          label={t('models.enabled')}
          testId="provider-enabled"
          checked={pendingEnabled ?? provider.enabled}
          disabled={busy !== null}
          onChange={(enabled) => {
            setPendingEnabled(enabled)
            run('enable', async () => {
              try {
                return await request('ai.providers.update', {
                  providerId: provider.providerId,
                  enabled
                })
              } finally {
                setPendingEnabled(null)
              }
            })
          }}
        />
        <div className="actions">
          <button
            type="button"
            className="button"
            data-testid="provider-check"
            disabled={busy !== null || provider.state === 'adapter-missing'}
            onClick={() => {
              run('check', () => request('ai.providers.check', { providerId: provider.providerId }))
            }}
          >
            <Icon name="retry" size={16} />
            <span>{busy === 'check' ? t('models.checking') : t('models.checkNow')}</span>
          </button>
          <button
            type="button"
            className="button button-danger"
            data-testid="provider-remove"
            disabled={busy !== null}
            onClick={() => {
              setConfirmRemove(true)
            }}
          >
            <Icon name="remove" size={16} />
            <span>{t('models.removeProvider')}</span>
          </button>
        </div>
      </div>
      {failure ? (
        <LoadFailure title={t('models.actionFailed')} error={failure} testId="provider-failure" />
      ) : null}

      {adapter?.keyRequirement !== 'none' || provider.credential.saved ? (
        <KeySection
          provider={provider}
          requirement={adapter?.keyRequirement ?? 'optional'}
          storage={storage}
          onChanged={onChanged}
        />
      ) : null}

      <ModelsTable provider={provider} onChanged={onChanged} />

      <ConfirmDialog
        open={confirmRemove}
        title={t('models.removeTitle', { name: provider.displayName })}
        description={t('models.removeConfirm')}
        confirmLabel={t('models.removeProvider')}
        testId="provider-remove-dialog"
        onCancel={() => {
          setConfirmRemove(false)
        }}
        onConfirm={() => {
          setConfirmRemove(false)
          run('remove', async () => {
            await request('ai.providers.remove', { providerId: provider.providerId })
            return null
          })
        }}
      />
    </article>
  )
}

function KeySection({
  provider,
  requirement,
  storage,
  onChanged
}: {
  readonly provider: ProviderInfo
  readonly requirement: AdapterInfo['keyRequirement']
  readonly storage: Loadable<SecureStorageStatus>
  readonly onChanged: (provider: ProviderInfo) => void
}) {
  const { t, locale } = useI18n()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const credential = provider.credential
  const storageReady = storage.state === 'ready' && storage.value.available
  // Core never sends a key to an address that is neither encrypted nor on this computer.
  const insecure = !provider.encrypted
  const canSave = storageReady && !insecure
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short'
  })

  const save = (apiKey: string) => {
    setBusy(true)
    setFailure(null)
    request('ai.credentials.set', { providerId: provider.providerId, apiKey })
      .then((result) => {
        setEditing(false)
        onChanged(result)
      })
      .catch((error: unknown) => {
        setFailure(envelopeOf(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <section className="key-section" data-testid="provider-key" data-saved={credential.saved}>
      <h4>
        <Icon name="key" size={16} /> {t('models.apiKey')}{' '}
        <span className="muted small">{t(`models.keyRequirement.${requirement}`)}</span>
      </h4>
      {credential.saved ? (
        <p className="key-status" data-testid="provider-key-status">
          <span>{t('models.keySaved')}</span>{' '}
          <span className="muted small">
            {t('models.keyFingerprint')} <code>{credential.fingerprint ?? '—'}</code>
            {credential.savedAt
              ? ` · ${t('models.keySavedAt', { time: format.format(new Date(credential.savedAt)) })}`
              : ''}
          </span>{' '}
          <span
            className={`badge badge-${credential.validation === 'valid' ? 'success' : credential.validation === 'rejected' ? 'error' : 'muted'}`}
            data-testid="provider-key-validation"
            data-validation={credential.validation}
          >
            {t(`keyValidation.${credential.validation}`)}
          </span>
        </p>
      ) : (
        <p className="muted small" data-testid="provider-key-status">
          {t('models.keyNone')}
        </p>
      )}
      {!storageReady ? (
        <p className="muted small">
          <span className="badge badge-muted">{t('availability.UNAVAILABLE')}</span>{' '}
          {t('models.keyStorageUnavailable')}
        </p>
      ) : null}
      {insecure ? (
        <p className="muted small" data-testid="provider-key-insecure">
          <span className="badge badge-muted">{t('availability.UNAVAILABLE')}</span>{' '}
          {t('models.keyInsecure')}
        </p>
      ) : null}
      {editing || (!credential.saved && canSave) ? (
        <KeyForm
          busy={busy}
          disabled={!canSave}
          onSubmit={save}
          onCancel={
            credential.saved
              ? () => {
                  setEditing(false)
                }
              : null
          }
        />
      ) : null}
      {credential.saved && !editing ? (
        <div className="actions">
          <button
            type="button"
            className="button"
            data-testid="provider-key-replace"
            disabled={busy || !canSave}
            onClick={() => {
              setEditing(true)
            }}
          >
            {t('models.keyReplace')}
          </button>
          <button
            type="button"
            className="button button-danger"
            data-testid="provider-key-remove"
            disabled={busy}
            onClick={() => {
              setConfirmRemove(true)
            }}
          >
            {t('models.keyRemove')}
          </button>
        </div>
      ) : null}
      {failure ? (
        <LoadFailure title={t('models.keyNotSaved')} error={failure} testId="provider-key-error" />
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        title={t('models.keyRemoveTitle')}
        description={t('models.keyRemoveConfirm', { name: provider.displayName })}
        confirmLabel={t('models.keyRemove')}
        testId="provider-key-remove-dialog"
        onCancel={() => {
          setConfirmRemove(false)
        }}
        onConfirm={() => {
          setConfirmRemove(false)
          setBusy(true)
          request('ai.credentials.remove', { providerId: provider.providerId })
            .then(onChanged)
            .catch((error: unknown) => {
              setFailure(envelopeOf(error))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      />
    </section>
  )
}

/**
 * The key is kept in this form only until it is sent: the field is emptied
 * as soon as Save is pressed, and the key is never stored by the interface.
 */
function KeyForm({
  busy,
  disabled,
  onSubmit,
  onCancel
}: {
  readonly busy: boolean
  readonly disabled: boolean
  readonly onSubmit: (apiKey: string) => void
  readonly onCancel: (() => void) | null
}) {
  const { t } = useI18n()
  const id = useId()
  const hintId = useId()
  const [value, setValue] = useState('')
  return (
    <form
      className="key-form"
      onSubmit={(event) => {
        event.preventDefault()
        const key = value.trim()
        setValue('')
        if (key) onSubmit(key)
      }}
    >
      <label htmlFor={id}>{t('models.keyLabel')}</label>
      <div className="key-row">
        <input
          id={id}
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled || busy}
          aria-describedby={hintId}
          data-testid="provider-key-input"
          onChange={(event) => {
            setValue(event.target.value)
          }}
        />
        <button
          type="submit"
          className="button button-primary"
          disabled={disabled || busy || value.trim().length === 0}
          data-testid="provider-key-save"
        >
          {busy ? t('models.keySaving') : t('models.keySave')}
        </button>
        {onCancel ? (
          <button type="button" className="button" onClick={onCancel}>
            {t('dialog.cancel')}
          </button>
        ) : null}
      </div>
      <p id={hintId} className="muted small">
        {t('models.keyHint')}
      </p>
    </form>
  )
}

// ---- models ------------------------------------------------------------------------------------

function ModelsTable({
  provider,
  onChanged
}: {
  readonly provider: ProviderInfo
  readonly onChanged: (provider: ProviderInfo) => void
}) {
  const { t } = useI18n()
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const [adding, setAdding] = useState(false)

  /** Resolves true once Core stored the change; on failure the reason is shown. */
  const update = async (
    model: ModelInfo,
    change: { enabled?: boolean; capabilities?: ModelCapability[] }
  ): Promise<boolean> => {
    setFailure(null)
    try {
      onChanged(
        await request('ai.models.update', {
          providerId: provider.providerId,
          modelId: model.modelId,
          ...change
        })
      )
      return true
    } catch (error) {
      setFailure(envelopeOf(error))
      return false
    }
  }

  return (
    <section className="models" data-testid="provider-models">
      <h4>{t('models.models', { count: provider.models.length })}</h4>
      {provider.models.length === 0 ? (
        <p className="muted small">{t('models.noModels')}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table models-table">
            <thead>
              <tr>
                <th scope="col">{t('models.model')}</th>
                <th scope="col">{t('models.capabilities')}</th>
                <th scope="col">{t('models.details')}</th>
                <th scope="col">{t('models.useModel')}</th>
              </tr>
            </thead>
            <tbody>
              {provider.models.map((model) => (
                <ModelRow
                  key={model.modelId}
                  model={model}
                  onToggle={(enabled) => update(model, { enabled })}
                  onCapabilities={(capabilities) => update(model, { capabilities })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failure ? (
        <LoadFailure title={t('models.actionFailed')} error={failure} testId="model-failure" />
      ) : null}
      {adding ? (
        <AddModelForm
          provider={provider}
          onDone={(result) => {
            setAdding(false)
            if (result) onChanged(result)
          }}
        />
      ) : (
        <button
          type="button"
          className="button"
          data-testid="model-add"
          onClick={() => {
            setAdding(true)
          }}
        >
          <Icon name="add" size={16} />
          <span>{t('models.addModel')}</span>
        </button>
      )}
    </section>
  )
}

function ModelRow({
  model,
  onToggle,
  onCapabilities
}: {
  readonly model: ModelInfo
  readonly onToggle: (enabled: boolean) => Promise<boolean>
  readonly onCapabilities: (capabilities: ModelCapability[]) => Promise<boolean>
}) {
  const { t } = useI18n()
  // A choice is shown at once and marked as saving until Core confirms it; if saving
  // fails, the stored value comes back and the reason is shown.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)
  const [pendingCapabilities, setPendingCapabilities] = useState<ModelCapability[] | null>(null)
  const capabilities = pendingCapabilities ?? model.capabilities
  const enabled = pendingEnabled ?? model.enabled
  const toggle = (capability: ModelCapability, on: boolean) => {
    const chosen = on
      ? [...capabilities, capability]
      : capabilities.filter((item) => item !== capability)
    if (chosen.length === 0) return
    const next = ModelCapability.options.filter((item) => chosen.includes(item))
    setPendingCapabilities(next)
    void onCapabilities(next).finally(() => {
      setPendingCapabilities(null)
    })
  }
  const needsCapabilities = model.capabilities.length === 0
  const saving = pendingEnabled !== null || pendingCapabilities !== null
  return (
    <tr
      data-testid="model-row"
      data-model-id={model.modelId}
      data-enabled={model.enabled}
      aria-busy={saving}
    >
      <td>
        <span className="model-name">{model.displayName ?? model.modelId}</span>
        {model.displayName ? <code className="model-id small">{model.modelId}</code> : null}
        <span className="muted small">
          {t(model.discovered ? 'models.discovered' : 'models.addedByHand')}
        </span>
      </td>
      <td>
        <fieldset className="capability-chips" data-testid="model-capabilities">
          <legend className="visually-hidden">
            {t('models.capabilitiesOf', { model: model.modelId })}
          </legend>
          {ModelCapability.options.map((capability) => (
            <label key={capability} className="chip">
              <input
                type="checkbox"
                checked={capabilities.includes(capability)}
                data-testid={`capability-${capability}`}
                disabled={
                  pendingCapabilities !== null ||
                  (capabilities.length === 1 && capabilities.includes(capability))
                }
                onChange={(event) => {
                  toggle(capability, event.target.checked)
                }}
              />
              <span>{t(`capability.${capability}`)}</span>
            </label>
          ))}
        </fieldset>
        {needsCapabilities ? (
          <p className="muted small">{t('models.chooseCapabilities')}</p>
        ) : (
          <p className="muted small">
            {t(`capabilitySource.${model.capabilitySource}` as MessageKey)}
          </p>
        )}
      </td>
      <td className="small">
        <ModelDetails model={model} />
      </td>
      <td>
        <Switch
          label={t('models.useModelLabel', { model: model.modelId })}
          testId="model-enabled"
          checked={enabled}
          disabled={needsCapabilities || pendingEnabled !== null}
          onChange={(value) => {
            setPendingEnabled(value)
            void onToggle(value).finally(() => {
              setPendingEnabled(null)
            })
          }}
        />
        {saving ? <span className="muted small">{t('models.saving')}</span> : null}
      </td>
    </tr>
  )
}

function ModelDetails({ model }: { readonly model: ModelInfo }) {
  const { t } = useI18n()
  const rows: string[] = []
  if (model.contextWindow !== null)
    rows.push(t('models.contextWindow', { tokens: model.contextWindow }))
  if (model.inputCostPerMillion !== null || model.outputCostPerMillion !== null)
    rows.push(
      t('models.cost', {
        input: model.inputCostPerMillion?.toFixed(2) ?? '—',
        output: model.outputCostPerMillion?.toFixed(2) ?? '—'
      })
    )
  if (model.observedLatencyMs !== null)
    rows.push(t('models.latency', { ms: Math.round(model.observedLatencyMs) }))
  if (rows.length === 0) return <span className="muted">{t('models.noDetails')}</span>
  return (
    <ul className="plain-list">
      {rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  )
}

function AddModelForm({
  provider,
  onDone
}: {
  readonly provider: ProviderInfo
  readonly onDone: (result: ProviderInfo | null) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [modelId, setModelId] = useState('')
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(['chat'])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  return (
    <form
      className="add-model"
      data-testid="model-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setFailure(null)
        request('ai.models.add', {
          providerId: provider.providerId,
          modelId: modelId.trim(),
          capabilities
        })
          .then((result) => {
            onDone(result)
          })
          .catch((error: unknown) => {
            setFailure(envelopeOf(error))
            setBusy(false)
          })
      }}
    >
      <label htmlFor={id}>{t('models.modelId')}</label>
      <input
        id={id}
        className="input"
        value={modelId}
        autoComplete="off"
        spellCheck={false}
        data-testid="model-add-id"
        onChange={(event) => {
          setModelId(event.target.value)
        }}
      />
      <fieldset className="capability-chips">
        <legend>{t('models.capabilities')}</legend>
        {ModelCapability.options.map((capability) => (
          <label key={capability} className="chip">
            <input
              type="checkbox"
              checked={capabilities.includes(capability)}
              onChange={(event) => {
                setCapabilities((previous) =>
                  event.target.checked
                    ? ModelCapability.options.filter(
                        (item) => item === capability || previous.includes(item)
                      )
                    : previous.filter((item) => item !== capability)
                )
              }}
            />
            <span>{t(`capability.${capability}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className="actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            onDone(null)
          }}
        >
          {t('dialog.cancel')}
        </button>
        <button
          type="submit"
          className="button button-primary"
          data-testid="model-add-save"
          disabled={busy || modelId.trim().length === 0 || capabilities.length === 0}
        >
          {t('models.addModel')}
        </button>
      </div>
      {failure ? <LoadFailure title={t('models.actionFailed')} error={failure} /> : null}
    </form>
  )
}

// ---- adding a provider ---------------------------------------------------------------------------

function AddProviderDialog({
  open,
  adapters,
  storage,
  onClose,
  onAdded
}: {
  readonly open: boolean
  readonly adapters: readonly AdapterInfo[]
  readonly storage: Loadable<SecureStorageStatus>
  readonly onClose: () => void
  readonly onAdded: (provider: ProviderInfo) => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('models.addProvider')}
      description={t('models.addProviderHint')}
      testId="provider-add-dialog"
    >
      {open ? (
        <AddProviderForm
          adapters={adapters}
          storage={storage}
          onCancel={onClose}
          onAdded={(provider) => {
            onAdded(provider)
            onClose()
          }}
        />
      ) : null}
    </Dialog>
  )
}

function AddProviderForm({
  adapters,
  storage,
  onCancel,
  onAdded
}: {
  readonly adapters: readonly AdapterInfo[]
  readonly storage: Loadable<SecureStorageStatus>
  readonly onCancel: () => void
  readonly onAdded: (provider: ProviderInfo) => void
}) {
  const { t } = useI18n()
  const nameId = useId()
  const urlId = useId()
  const keyId = useId()
  const [adapterId, setAdapterId] = useState(adapters[0]?.adapterId ?? '')
  const adapter = adapters.find((item) => item.adapterId === adapterId) ?? null
  const [name, setName] = useState(adapter?.displayName ?? '')
  const [baseUrl, setBaseUrl] = useState(adapter?.defaultBaseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const storageReady = storage.state === 'ready' && storage.value.available
  const locality = baseUrl.trim() ? localityOf(baseUrl.trim()) : null
  const insecure = baseUrl.trim() !== '' && !isProtectedTransport(baseUrl.trim())
  const canSaveKey = storageReady && !insecure

  const submit = async () => {
    const key = canSaveKey ? apiKey.trim() : ''
    setApiKey('')
    setBusy(true)
    setFailure(null)
    let provider: ProviderInfo | null = null
    try {
      provider = await request('ai.providers.add', {
        adapterId,
        displayName: name.trim(),
        baseUrl: baseUrl.trim()
      })
      provider = key
        ? await request('ai.credentials.set', { providerId: provider.providerId, apiKey: key })
        : await request('ai.providers.check', { providerId: provider.providerId })
      onAdded(provider)
    } catch (error) {
      // The provider may exist already (only the key or the check failed): show it and say what failed.
      if (provider) onAdded(provider)
      setFailure(envelopeOf(error))
      setBusy(false)
    }
  }

  return (
    <form
      className="dialog-form"
      data-testid="provider-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Select
        label={t('models.adapter')}
        testId="provider-adapter"
        value={adapterId}
        onChange={(value) => {
          const next = adapters.find((item) => item.adapterId === value)
          setAdapterId(value)
          setName(next?.displayName ?? '')
          setBaseUrl(next?.defaultBaseUrl ?? '')
        }}
        choices={adapters.map((item) => ({ value: item.adapterId, label: item.displayName }))}
        description={adapter?.description}
      />
      <div className="field">
        <label htmlFor={nameId}>{t('models.providerName')}</label>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={80}
          data-testid="provider-name"
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={urlId}>{t('models.baseUrl')}</label>
        <input
          id={urlId}
          className="input"
          value={baseUrl}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={adapter?.exampleBaseUrl ?? ''}
          data-testid="provider-url"
          onChange={(event) => {
            setBaseUrl(event.target.value)
          }}
        />
        <p className="muted small" data-testid="provider-url-locality">
          {locality ? t(`models.localityHint.${locality}`) : t('models.baseUrlHint')}
        </p>
      </div>
      {adapter && adapter.keyRequirement !== 'none' ? (
        <div className="field">
          <label htmlFor={keyId}>
            {t('models.apiKey')}{' '}
            <span className="muted small">
              {t(`models.keyRequirement.${adapter.keyRequirement}`)}
            </span>
          </label>
          <input
            id={keyId}
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={canSaveKey ? apiKey : ''}
            disabled={!canSaveKey}
            data-testid="provider-add-key"
            onChange={(event) => {
              setApiKey(event.target.value)
            }}
          />
          <p className="muted small">
            {!storageReady
              ? t('models.keyStorageUnavailable')
              : insecure
                ? t('models.keyInsecure')
                : t('models.keyHint')}
          </p>
        </div>
      ) : null}
      {failure ? (
        <LoadFailure title={t('models.addFailed')} error={failure} testId="provider-add-error" />
      ) : null}
      <div className="dialog-footer">
        <button type="button" className="button" onClick={onCancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="submit"
          className="button button-primary"
          data-testid="provider-add-save"
          disabled={busy || !adapter || !name.trim() || !baseUrl.trim()}
        >
          {busy ? t('models.adding') : t('models.addProvider')}
        </button>
      </div>
    </form>
  )
}

// ---- routing ------------------------------------------------------------------------------------

const PREFERRED_MODEL_SETTINGS = [
  ['ai.preferredChatModel', 'chat'],
  ['ai.preferredReasoningModel', 'reasoning'],
  ['ai.preferredVisionModel', 'vision'],
  ['ai.preferredEmbeddingModel', 'embeddings']
] as const satisfies readonly (readonly [AiSettingKey, ModelCapability])[]

function RoutingCard({
  ai,
  providers,
  coreSession
}: {
  readonly ai: ReturnType<typeof useAiSettings>
  readonly providers: Loadable<ProviderInfo[]>
  readonly coreSession: string | null
}) {
  const { t } = useI18n()
  const [saveState, setSaveState] = useState<
    { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string } | null
  >(null)
  // A choice is shown at once and marked "Saving…" until Core confirms it. Routing is
  // enforced by Core, so if saving fails the stored value comes back, with the reason.
  const [pending, setPending] = useState<Partial<AiSettings>>({})
  const stored = ai.settings
  const settings: Loadable<AiSettings> =
    stored.state === 'ready' ? { state: 'ready', value: { ...stored.value, ...pending } } : stored

  const change = <K extends AiSettingKey>(key: K, value: AiSettings[K]) => {
    setSaveState({ kind: 'saving' })
    setPending((previous) => ({ ...previous, [key]: value }))
    const settle = () => {
      setPending((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([name]) => name !== key))
      )
    }
    ai.update(key, value).then(
      () => {
        settle()
        setSaveState({ kind: 'saved' })
      },
      (error: unknown) => {
        settle()
        setSaveState({ kind: 'failed', message: envelopeOf(error).message })
      }
    )
  }

  const providerList = providers.state === 'ready' ? providers.value : []
  const modelsFor = (capability: ModelCapability) =>
    providerList.flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled && model.capabilities.includes(capability))
        .map((model) => ({
          value: modelRef(provider.providerId, model.modelId),
          label: t('chat.modelChoice', {
            model: model.displayName ?? model.modelId,
            provider: provider.displayName
          })
        }))
    )

  return (
    <section className="card" aria-labelledby="routing-title" data-testid="routing-card">
      <div className="card-header">
        <h2 id="routing-title">{t('models.routing')}</h2>
      </div>
      <div className="route-previews" data-testid="route-previews">
        {(['chat', 'reasoning', 'vision', 'embeddings'] as const).map((capability) => (
          <RoutePreviewRow key={capability} capability={capability} coreSession={coreSession} />
        ))}
      </div>
      {settings.state === 'loading' ? <p>{t('load.loading')}</p> : null}
      {settings.state === 'error' ? (
        <LoadFailure title={t('models.settingsFailed')} error={settings.error} />
      ) : null}
      {settings.state === 'ready' ? (
        <div className="routing-settings">
          <RadioGroup
            legend={t('models.routingMode')}
            name="routing-mode"
            testId="routing-mode"
            value={settings.value['ai.routingMode']}
            onChange={(value) => {
              change('ai.routingMode', value)
            }}
            choices={RoutingMode.options.map((mode) => ({
              value: mode,
              label: t(`routing.mode.${mode}`),
              hint: t(`routing.modeHint.${mode}`)
            }))}
          />
          <RadioGroup
            legend={t('models.fallback')}
            name="fallback-policy"
            testId="fallback-policy"
            value={settings.value['ai.fallbackPolicy']}
            onChange={(value) => {
              change('ai.fallbackPolicy', value)
            }}
            choices={FallbackPolicy.options.map((policy) => ({
              value: policy,
              label: t(`routing.fallback.${policy}`),
              hint: t(`routing.fallbackHint.${policy}`)
            }))}
          />
          <Select
            label={t('models.costLatency')}
            testId="cost-latency"
            value={settings.value['ai.costLatency']}
            onChange={(value) => {
              change('ai.costLatency', value)
            }}
            choices={CostLatencyPreference.options.map((preference) => ({
              value: preference,
              label: t(`routing.cost.${preference}`)
            }))}
            description={t('models.costLatencyHint')}
          />
          <Select<string>
            label={t('models.preferredProvider')}
            testId="preferred-provider"
            value={settings.value['ai.preferredProvider'] ?? 'auto'}
            onChange={(value) => {
              change('ai.preferredProvider', value === 'auto' ? null : value)
            }}
            choices={[
              { value: 'auto', label: t('models.noPreference') },
              ...providerList.map((provider) => ({
                value: provider.providerId,
                label: provider.displayName
              })),
              ...missing(
                settings.value['ai.preferredProvider'],
                providerList.map((p) => p.providerId),
                t
              )
            ]}
          />
          {PREFERRED_MODEL_SETTINGS.map(([key, capability]) => {
            const options = modelsFor(capability)
            const current = settings.value[key]
            return (
              <Select<string>
                key={key}
                label={t(`models.preferred.${capability}`)}
                testId={`preferred-${capability}`}
                value={current ?? 'auto'}
                onChange={(value) => {
                  change(key, value === 'auto' ? null : value)
                }}
                choices={[
                  { value: 'auto', label: t('models.noPreference') },
                  ...options,
                  ...missing(
                    current,
                    options.map((option) => option.value),
                    t
                  )
                ]}
              />
            )
          })}
        </div>
      ) : null}
      <p
        className="save-status"
        role="status"
        data-testid="routing-save-status"
        data-state={saveState?.kind ?? 'none'}
      >
        {saveState?.kind === 'saving' ? t('models.saving') : null}
        {saveState?.kind === 'saved' ? t('settings.saved') : null}
        {saveState?.kind === 'failed' ? t('models.notSaved', { reason: saveState.message }) : null}
      </p>
    </section>
  )
}

/** A saved choice that is no longer offered stays visible, marked as unavailable. */
function missing(
  current: string | null,
  offered: readonly string[],
  t: ReturnType<typeof useI18n>['t']
): { value: string; label: string }[] {
  return current !== null && !offered.includes(current)
    ? [{ value: current, label: t('chat.modelUnavailable', { model: current }) }]
    : []
}

function RoutePreviewRow({
  capability,
  coreSession
}: {
  readonly capability: ModelCapability
  readonly coreSession: string | null
}) {
  const { t } = useI18n()
  const preview = useRoutePreview(capability, null, coreSession)
  return (
    <div
      className="route-preview"
      data-testid={`route-preview-${capability}`}
      data-state={
        preview.state === 'ready' ? (preview.value.route ? 'routed' : 'none') : preview.state
      }
    >
      <span className="route-capability">{t(`capability.${capability}`)}</span>
      {preview.state === 'loading' ? <span className="muted">{t('load.loading')}</span> : null}
      {preview.state === 'error' ? <span className="muted">{preview.error.message}</span> : null}
      {preview.state === 'ready' && preview.value.route ? (
        <RouteBadge route={preview.value.route} />
      ) : null}
      {preview.state === 'ready' && !preview.value.route ? (
        <span className="muted small" data-code={preview.value.problem?.code}>
          <span className="badge badge-muted">
            {t(
              preview.value.problem?.code === 'NO_MODEL_AVAILABLE'
                ? 'availability.NOT_CONFIGURED'
                : 'availability.UNAVAILABLE'
            )}
          </span>{' '}
          {preview.value.problem?.message ?? ''}
        </span>
      ) : null}
    </div>
  )
}
