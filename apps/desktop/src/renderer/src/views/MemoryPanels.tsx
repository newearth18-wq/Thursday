import { useCallback, useEffect, useState } from 'react'
import {
  MEMORY_TYPES,
  type Artifact,
  type ErrorEnvelope,
  type MemoryCandidate,
  type MemoryDecisionRecord,
  type MemoryEntry,
  type MemoryProposalResult,
  type MemorySearchMode,
  type MemorySearchResult,
  type MemoryType,
  type Note,
  type NoteEntry,
  type NoteSearchHit,
  type NoteWriteResult,
  type NotesStatus
} from '@jupiter/contracts'
import { request } from '../api'
import { ArtifactList } from '../components/ArtifactList'
import { Dialog } from '../components/Dialog'
import { Select, Switch } from '../components/FormControls'
import { useI18n, type MessageKey } from '../i18n'
import { withPermission } from '../useFiles'
import { envelopeOf, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

/**
 * The panels of the Memory screen (SET 11). Every action goes to Jupiter
 * Core; what appears here is what Core answered. Sensitive content is shown
 * only after the person presses Reveal.
 */

type FormatTime = (iso: string | null) => string
type AnyType = MemoryType | 'any'

function useAction() {
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<ErrorEnvelope | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const run = async <T,>(work: () => Promise<T>, after: (value: T) => void) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      after(await withPermission(work, setWaiting))
    } catch (failure) {
      setError(envelopeOf(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, waiting, error, done, setDone, run }
}

function ActionStatus({
  action,
  testId
}: {
  readonly action: ReturnType<typeof useAction>
  readonly testId: string
}) {
  const { t } = useI18n()
  return (
    <>
      <p className="small" role="status" data-testid={`${testId}-status`}>
        {action.waiting
          ? t('files.waitingPermission')
          : action.busy
            ? t('files.working')
            : (action.done ?? '')}
      </p>
      {action.error ? (
        <LoadFailure
          title={t('memory.actionFailed')}
          error={action.error}
          testId={`${testId}-error`}
        />
      ) : null}
    </>
  )
}

const percent = (value: number) => `${String(Math.round(value * 100))}%`

// ---- Memories -----------------------------------------------------------------------------------

export function MemoriesPanel({
  version,
  formatTime
}: {
  readonly version: number
  readonly formatTime: FormatTime
}) {
  const { t } = useI18n()
  const [mode, setMode] = useState<MemorySearchMode>('metadata')
  const [text, setText] = useState('')
  const [type, setType] = useState<AnyType>('any')
  const [includeForgotten, setIncludeForgotten] = useState(false)
  const [relatedTo, setRelatedTo] = useState<string | null>(null)
  const [result, setResult] = useState<MemorySearchResult | null>(null)
  const [exported, setExported] = useState<Artifact | null>(null)
  const action = useAction()
  const { run } = action

  const search = useCallback(
    (next: { mode: MemorySearchMode; relatedTo: string | null }) =>
      run(
        () =>
          request('memory.search', {
            mode: next.mode,
            text: next.mode === 'metadata' || next.mode === 'relationship' ? '' : text,
            types: type === 'any' ? [] : [type],
            tags: [],
            sensitivity: null,
            relatedTo: next.relatedTo,
            includeForgotten,
            minConfidence: 0,
            limit: 100
          }),
        setResult
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run is stable enough; the inputs are listed
    [text, type, includeForgotten]
  )

  // Reload the list whenever a memory changes (not while a keyword search is shown).
  useEffect(() => {
    if (mode === 'metadata') void search({ mode: 'metadata', relatedTo: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on change only
  }, [version, includeForgotten, type])

  return (
    <div className="memory-panel" data-testid="memory-memories">
      <form
        className="files-find-form"
        onSubmit={(event) => {
          event.preventDefault()
          setRelatedTo(null)
          void search({ mode, relatedTo: null })
        }}
      >
        <Select<MemorySearchMode>
          label={t('memory.search.mode')}
          value={mode}
          testId="memory-search-mode"
          choices={(['metadata', 'keyword', 'semantic'] as const).map((value) => ({
            value,
            label: t(`memory.search.mode.${value}`)
          }))}
          onChange={setMode}
        />
        <div className="field">
          <label htmlFor="memory-search-text">{t('memory.search.text')}</label>
          <input
            id="memory-search-text"
            className="input"
            value={text}
            maxLength={500}
            disabled={mode === 'metadata'}
            data-testid="memory-search-text"
            onChange={(event) => {
              setText(event.target.value)
            }}
          />
        </div>
        <Select<AnyType>
          label={t('memory.type')}
          value={type}
          testId="memory-search-type"
          choices={[
            { value: 'any', label: t('memory.type.any') },
            ...MEMORY_TYPES.map((value) => ({ value, label: t(`memory.type.${value}`) }))
          ]}
          onChange={setType}
        />
        <Switch
          label={t('memory.search.includeForgotten')}
          checked={includeForgotten}
          testId="memory-include-forgotten"
          onChange={setIncludeForgotten}
        />
        <button
          type="submit"
          className="button button-primary"
          disabled={action.busy}
          data-testid="memory-search"
        >
          {t('memory.search.button')}
        </button>
      </form>
      <ActionStatus action={action} testId="memory-search" />
      {result?.semantic.requested ? (
        <p className="small" data-testid="memory-semantic-result" data-used={result.semantic.used}>
          {result.semantic.used
            ? t('memory.semantic.used', {
                model: result.semantic.modelId ?? '',
                provider: result.semantic.providerName ?? '',
                where: t(`memory.locality.${result.semantic.locality ?? 'this-device'}`)
              })
            : t('memory.semantic.notUsed', { reason: result.semantic.reason ?? '' })}
        </p>
      ) : null}
      {relatedTo ? (
        <p className="small" data-testid="memory-related-to">
          {t('memory.relatedShown')}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setRelatedTo(null)
              setMode('metadata')
              void search({ mode: 'metadata', relatedTo: null })
            }}
          >
            {t('memory.showAll')}
          </button>
        </p>
      ) : null}
      {result ? (
        result.hits.length === 0 ? (
          <p className="muted" data-testid="memory-list-empty">
            {t('memory.none')}
          </p>
        ) : (
          <ul className="artifact-list" data-testid="memory-list">
            {result.hits.map((hit) => (
              <MemoryItem
                key={hit.memory.memoryId}
                memory={hit.memory}
                score={hit.score}
                matched={hit.matched}
                relation={hit.relation}
                formatTime={formatTime}
                onRelated={(memoryId) => {
                  setRelatedTo(memoryId)
                  setMode('metadata')
                  void search({ mode: 'relationship', relatedTo: memoryId })
                }}
              />
            ))}
          </ul>
        )
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={action.busy}
          data-testid="memory-export"
          onClick={() =>
            void run(
              () => request('memory.export', { includeForgotten }),
              (artifact) => {
                setExported(artifact)
                action.setDone(t('memory.exported'))
              }
            )
          }
        >
          {t('memory.export')}
        </button>
      </div>
      {exported ? (
        <ArtifactList artifacts={[exported]} formatTime={formatTime} testId="memory-export-list" />
      ) : null}
    </div>
  )
}

function MemoryItem({
  memory,
  score,
  matched,
  relation,
  formatTime,
  onRelated
}: {
  readonly memory: MemoryEntry
  readonly score: number | null
  readonly matched: MemorySearchMode
  readonly relation: string | null
  readonly formatTime: FormatTime
  readonly onRelated: (memoryId: string) => void
}) {
  const { t } = useI18n()
  const action = useAction()
  const [shown, setShown] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.content ?? '')
  const [tags, setTags] = useState(memory.tags.join(', '))
  const [deleting, setDeleting] = useState(false)
  const content = shown ?? memory.content
  const id = memory.memoryId
  return (
    <li
      className="artifact"
      data-testid="memory-item"
      data-memory-id={id}
      data-type={memory.type}
      data-sensitivity={memory.sensitivity}
      data-state={memory.state}
      data-layer={memory.layer}
    >
      <div className="artifact-head">
        <span className="badge badge-muted">{t(`memory.type.${memory.type}`)}</span>
        <span className="badge badge-muted">{t(`memory.layer.${memory.layer}`)}</span>
        {memory.sensitivity === 'sensitive' ? (
          <span className="badge badge-warning" data-testid="memory-sensitive">
            {t('memory.sensitive')}
          </span>
        ) : null}
        {memory.state === 'forgotten' ? (
          <span className="badge badge-muted">{t('memory.forgotten')}</span>
        ) : null}
        {relation ? (
          <span className="badge badge-info">{t(`memory.relation.${relation}` as MessageKey)}</span>
        ) : null}
        {score !== null && matched !== 'metadata' ? (
          <span className="badge badge-info">{t('memory.match', { score: percent(score) })}</span>
        ) : null}
      </div>
      {content === null ? (
        <p className="muted" data-testid="memory-hidden">
          {t('memory.hidden')}{' '}
          <button
            type="button"
            className="link-button"
            data-testid="memory-reveal"
            onClick={() =>
              void action.run(
                () => request('memory.get', { memoryId: id, reveal: true }),
                (entry) => {
                  setShown(entry.content)
                }
              )
            }
          >
            {t('memory.reveal')}
          </button>
        </p>
      ) : (
        <p className="message-text" data-testid="memory-content">
          {content}
        </p>
      )}
      <p className="muted small" data-testid="memory-meta">
        {t('memory.meta', {
          source: memory.source.label,
          confidence: percent(memory.confidence),
          importance: percent(memory.importance),
          updated: formatTime(memory.updatedAt)
        })}
        {memory.source.ref ? (
          <>
            {' · '}
            <code data-testid="memory-source-ref">{memory.source.ref}</code>
          </>
        ) : null}
        {memory.corrections > 0 ? ` · ${t('memory.corrected', { count: memory.corrections })}` : ''}
        {memory.tags.length ? ` · ${memory.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
      </p>
      <div className="actions">
        {memory.sensitivity === 'normal' ? (
          <button
            type="button"
            className="button"
            data-testid="memory-correct"
            onClick={() => {
              setDraft(memory.content ?? '')
              setTags(memory.tags.join(', '))
              setEditing(true)
            }}
          >
            {t('memory.correct')}
          </button>
        ) : null}
        <button
          type="button"
          className="button"
          disabled={action.busy}
          data-testid="memory-forget"
          onClick={() =>
            void action.run(
              () =>
                request('memory.forget', { memoryId: id, forgotten: memory.state === 'active' }),
              () => {
                action.setDone(
                  t(memory.state === 'active' ? 'memory.forgottenDone' : 'memory.restoredDone')
                )
              }
            )
          }
        >
          {t(memory.state === 'active' ? 'memory.forget' : 'memory.restore')}
        </button>
        <button
          type="button"
          className="button"
          data-testid="memory-related"
          onClick={() => {
            onRelated(id)
          }}
        >
          {t('memory.related')}
        </button>
        <button
          type="button"
          className="button button-danger"
          disabled={action.busy}
          data-testid="memory-delete"
          onClick={() => {
            setDeleting(true)
          }}
        >
          {t('memory.delete')}
        </button>
      </div>
      <ActionStatus action={action} testId="memory-item" />
      <Dialog
        open={editing}
        onClose={() => {
          setEditing(false)
        }}
        title={t('memory.correctTitle')}
        testId="memory-correct-dialog"
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditing(false)
              }}
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              className="button button-primary"
              data-testid="memory-correct-save"
              disabled={draft.trim() === ''}
              onClick={() => {
                setEditing(false)
                void action.run(
                  () =>
                    request('memory.update', {
                      memoryId: id,
                      content: draft,
                      tags: tags
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    }),
                  () => {
                    action.setDone(t('memory.correctedDone'))
                  }
                )
              }}
            >
              {t('memory.save')}
            </button>
          </>
        }
      >
        <div className="dialog-form">
          <div className="field">
            <label htmlFor={`memory-draft-${id}`}>{t('memory.content')}</label>
            <textarea
              id={`memory-draft-${id}`}
              className="input"
              rows={4}
              maxLength={4000}
              value={draft}
              data-testid="memory-correct-text"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`memory-tags-${id}`}>{t('memory.tags')}</label>
            <input
              id={`memory-tags-${id}`}
              className="input"
              value={tags}
              maxLength={500}
              onChange={(event) => {
                setTags(event.target.value)
              }}
            />
          </div>
        </div>
      </Dialog>
      <Dialog
        open={deleting}
        onClose={() => {
          setDeleting(false)
        }}
        title={t('memory.deleteTitle')}
        description={t('memory.deleteDescription')}
        role="alertdialog"
        testId="memory-delete-dialog"
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setDeleting(false)
              }}
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              className="button button-danger"
              data-testid="memory-delete-confirm"
              onClick={() => {
                setDeleting(false)
                void action.run(
                  () => request('memory.delete', { memoryId: id }),
                  () => {
                    action.setDone(t('memory.deletedDone'))
                  }
                )
              }}
            >
              {t('memory.deleteConfirm')}
            </button>
          </>
        }
      />
    </li>
  )
}

// ---- Add ------------------------------------------------------------------------------------------

export function AddMemoryPanel() {
  const { t } = useI18n()
  const [content, setContent] = useState('')
  const [type, setType] = useState<MemoryType>('facts')
  const [tags, setTags] = useState('')
  const [retention, setRetention] = useState<'long-term' | 'session'>('long-term')
  const [result, setResult] = useState<MemoryProposalResult | null>(null)
  const action = useAction()
  return (
    <div className="memory-panel" data-testid="memory-add">
      <p className="muted small">{t('memory.add.intro')}</p>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(
            () =>
              request('memory.propose', {
                content,
                type,
                source: { kind: 'user', label: t('memory.source.you'), ref: null },
                tags: tags
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                relationships: [],
                // The person typed it: sure of it, of ordinary importance.
                confidence: 1,
                importance: 0.5,
                retention: { kind: retention },
                explicit: true
              }),
            (proposal) => {
              setResult(proposal)
              if (proposal.decision === 'SAVE') setContent('')
            }
          )
        }}
      >
        <div className="field">
          <label htmlFor="memory-add-content">{t('memory.content')}</label>
          <textarea
            id="memory-add-content"
            className="input"
            rows={3}
            maxLength={4000}
            value={content}
            data-testid="memory-add-content"
            onChange={(event) => {
              setContent(event.target.value)
            }}
          />
        </div>
        <Select<MemoryType>
          label={t('memory.type')}
          value={type}
          testId="memory-add-type"
          choices={MEMORY_TYPES.map((value) => ({ value, label: t(`memory.type.${value}`) }))}
          onChange={setType}
        />
        <div className="field">
          <label htmlFor="memory-add-tags">{t('memory.tags')}</label>
          <input
            id="memory-add-tags"
            className="input"
            value={tags}
            maxLength={500}
            data-testid="memory-add-tags"
            onChange={(event) => {
              setTags(event.target.value)
            }}
          />
        </div>
        <Select<'long-term' | 'session'>
          label={t('memory.retention')}
          value={retention}
          testId="memory-add-retention"
          choices={[
            { value: 'long-term', label: t('memory.layer.long-term') },
            { value: 'session', label: t('memory.layer.session') }
          ]}
          onChange={setRetention}
        />
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={action.busy || content.trim() === ''}
            data-testid="memory-add-submit"
          >
            {t('memory.add.button')}
          </button>
        </div>
      </form>
      <ActionStatus action={action} testId="memory-add" />
      {result ? <DecisionView result={result} /> : null}
    </div>
  )
}

const DECISION_TONE = { SAVE: 'success', DO_NOT_SAVE: 'muted', ASK_USER: 'warning' } as const

function DecisionView({ result }: { readonly result: MemoryProposalResult }) {
  const { t } = useI18n()
  return (
    <div
      className="notice"
      role="status"
      data-testid="memory-decision"
      data-decision={result.decision}
    >
      <p>
        <span className={`badge badge-${DECISION_TONE[result.decision]}`}>
          {t(`memory.decision.${result.decision}`)}
        </span>{' '}
        {t(`memory.decision.${result.decision}.detail`)}
      </p>
      <ul className="small">
        {result.reasons.map((reason) => (
          <li key={reason.code} data-testid="memory-reason" data-code={reason.code}>
            {t(`memory.reason.${reason.code}`)}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- Waiting for you ------------------------------------------------------------------------

export function CandidatesPanel({
  candidates,
  formatTime
}: {
  readonly candidates: Loadable<MemoryCandidate[]>
  readonly formatTime: FormatTime
}) {
  const { t } = useI18n()
  if (candidates.state === 'error')
    return <LoadFailure title={t('memory.loadFailed')} error={candidates.error} />
  if (candidates.state !== 'ready') return null
  return (
    <div className="memory-panel" data-testid="memory-candidates">
      <p className="muted small">{t('memory.waiting.intro')}</p>
      {candidates.value.length === 0 ? (
        <p className="muted" data-testid="memory-candidates-empty">
          {t('memory.waiting.none')}
        </p>
      ) : (
        <ul className="artifact-list">
          {candidates.value.map((candidate) => (
            <CandidateItem
              key={candidate.candidateId}
              candidate={candidate}
              formatTime={formatTime}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function CandidateItem({
  candidate,
  formatTime
}: {
  readonly candidate: MemoryCandidate
  readonly formatTime: FormatTime
}) {
  const { t } = useI18n()
  const action = useAction()
  const decide = (decision: 'SAVE' | 'DO_NOT_SAVE') =>
    void action.run(
      () => request('memory.decide', { candidateId: candidate.candidateId, decision }),
      (result) => {
        action.setDone(t(`memory.decision.${result.decision}`))
      }
    )
  return (
    <li
      className="artifact"
      data-testid="memory-candidate"
      data-candidate-id={candidate.candidateId}
    >
      <div className="artifact-head">
        <span className="badge badge-muted">{t(`memory.type.${candidate.type}`)}</span>
        {candidate.sensitiveKinds.map((kind) => (
          <span key={kind} className="badge badge-warning" data-testid="memory-candidate-kind">
            {t(`memory.reason.${kind}`)}
          </span>
        ))}
      </div>
      <p className="message-text" data-testid="memory-candidate-content">
        {candidate.content}
      </p>
      <ul className="small">
        {candidate.reasons.map((reason) => (
          <li key={reason.code}>{t(`memory.reason.${reason.code}`)}</li>
        ))}
      </ul>
      <p className="muted small">
        {t('memory.waiting.meta', {
          source: candidate.source.label,
          proposed: formatTime(candidate.proposedAt),
          expires: formatTime(candidate.expiresAt)
        })}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={action.busy}
          data-testid="memory-candidate-save"
          onClick={() => {
            decide('SAVE')
          }}
        >
          {t('memory.waiting.keep')}
        </button>
        <button
          type="button"
          className="button"
          disabled={action.busy}
          data-testid="memory-candidate-discard"
          onClick={() => {
            decide('DO_NOT_SAVE')
          }}
        >
          {t('memory.waiting.discard')}
        </button>
      </div>
      <ActionStatus action={action} testId="memory-candidate" />
    </li>
  )
}

// ---- Policy log -----------------------------------------------------------------------------------

export function PolicyLogPanel({
  decisions,
  formatTime
}: {
  readonly decisions: Loadable<MemoryDecisionRecord[]>
  readonly formatTime: FormatTime
}) {
  const { t } = useI18n()
  if (decisions.state === 'error')
    return <LoadFailure title={t('memory.loadFailed')} error={decisions.error} />
  if (decisions.state !== 'ready') return null
  return (
    <div className="memory-panel" data-testid="memory-policy">
      <p className="muted small">{t('memory.policy.intro')}</p>
      {decisions.value.length === 0 ? (
        <p className="muted">{t('memory.policy.none')}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="memory-policy-table">
            <thead>
              <tr>
                <th scope="col">{t('memory.policy.when')}</th>
                <th scope="col">{t('memory.policy.decision')}</th>
                <th scope="col">{t('memory.policy.by')}</th>
                <th scope="col">{t('memory.policy.reasons')}</th>
                <th scope="col">{t('memory.type')}</th>
              </tr>
            </thead>
            <tbody>
              {decisions.value.map((record) => (
                <tr
                  key={record.decisionId}
                  data-testid="memory-policy-row"
                  data-decision={record.decision}
                >
                  <td>{formatTime(record.decidedAt)}</td>
                  <td>
                    <span className={`badge badge-${DECISION_TONE[record.decision]}`}>
                      {t(`memory.decision.${record.decision}`)}
                    </span>
                  </td>
                  <td>{t(`memory.policy.by.${record.decidedBy}`)}</td>
                  <td>{record.reasons.map((code) => t(`memory.reason.${code}`)).join('; ')}</td>
                  <td>
                    {t(`memory.type.${record.type}`)}
                    {record.sensitivity === 'sensitive' ? ` · ${t('memory.sensitive')}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---- Obsidian ---------------------------------------------------------------------------------------

export function ObsidianPanel({
  status,
  formatTime
}: {
  readonly status: Loadable<NotesStatus>
  readonly formatTime: FormatTime
}) {
  const { t } = useI18n()
  const action = useAction()
  const [notes, setNotes] = useState<NoteEntry[] | null>(null)
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [query, setQuery] = useState('')
  const vault = status.state === 'ready' ? status.value.vault : null
  const connected = vault !== null

  if (status.state === 'error')
    return <LoadFailure title={t('memory.loadFailed')} error={status.error} />
  if (status.state !== 'ready') return null
  return (
    <div className="memory-panel" data-testid="memory-obsidian">
      <p className="muted small">{t('notes.intro')}</p>
      <section
        aria-labelledby="notes-vault-title"
        data-testid="notes-vault"
        data-connected={connected}
      >
        <h3 id="notes-vault-title">{t('notes.vault')}</h3>
        {vault ? (
          <dl className="facts facts-compact">
            <div>
              <dt>{t('notes.vault.name')}</dt>
              <dd data-testid="notes-vault-name">{vault.name}</dd>
            </div>
            <div>
              <dt>{t('notes.vault.path')}</dt>
              <dd>
                <code data-testid="notes-vault-path">{vault.path}</code>
              </dd>
            </div>
            <div>
              <dt>{t('notes.vault.kind')}</dt>
              <dd>{t(`notes.kind.${vault.kind}`)}</dd>
            </div>
            <div>
              <dt>{t('notes.vault.folder')}</dt>
              <dd>{vault.notesFolder || t('notes.vault.top')}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted" data-testid="notes-not-connected">
            {status.value.reason ?? t('notes.notConnected')}
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            className="button button-primary"
            disabled={action.busy}
            data-testid="notes-connect-vault"
            onClick={() =>
              void action.run(
                () => request('notes.connect', { kind: 'obsidian-vault' }),
                () => {
                  action.setDone(t('notes.connected'))
                }
              )
            }
          >
            {t('notes.connectVault')}
          </button>
          <button
            type="button"
            className="button"
            disabled={action.busy}
            data-testid="notes-connect-brain"
            onClick={() =>
              void action.run(
                () => request('notes.connect', { kind: 'jupiter-brain' }),
                () => {
                  action.setDone(t('notes.connected'))
                }
              )
            }
          >
            {t('notes.createBrain')}
          </button>
          {connected ? (
            <>
              <button
                type="button"
                className="button"
                disabled={action.busy}
                data-testid="notes-structure"
                onClick={() =>
                  void action.run(
                    () => request('notes.structure', {}),
                    (result) => {
                      action.setDone(t('notes.structureDone', { count: result.created.length }))
                    }
                  )
                }
              >
                {t('notes.structure')}
              </button>
              <button
                type="button"
                className="button"
                disabled={action.busy}
                data-testid="notes-disconnect"
                onClick={() =>
                  void action.run(
                    () => request('notes.disconnect', {}),
                    () => {
                      action.setDone(t('notes.disconnected'))
                      setNote(null)
                      setHits(null)
                    }
                  )
                }
              >
                {t('notes.disconnect')}
              </button>
            </>
          ) : null}
        </div>
        <ActionStatus action={action} testId="notes" />
      </section>
      {connected ? (
        <>
          <section aria-labelledby="notes-search-title">
            <h3 id="notes-search-title">{t('notes.search')}</h3>
            <form
              className="files-find-form"
              onSubmit={(event) => {
                event.preventDefault()
                void action.run(
                  () => request('notes.search', { text: query, limit: 20, missionId: null }),
                  (found) => {
                    setHits(found.hits)
                  }
                )
              }}
            >
              <div className="field">
                <label htmlFor="notes-search-text">{t('notes.search.text')}</label>
                <input
                  id="notes-search-text"
                  className="input"
                  value={query}
                  maxLength={200}
                  data-testid="notes-search-text"
                  onChange={(event) => {
                    setQuery(event.target.value)
                  }}
                />
              </div>
              <button
                type="submit"
                className="button button-primary"
                disabled={action.busy || query.trim() === ''}
                data-testid="notes-search"
              >
                {t('notes.search.button')}
              </button>
            </form>
            {hits ? (
              hits.length === 0 ? (
                <p className="muted">{t('notes.search.none')}</p>
              ) : (
                <ul className="plain-list" data-testid="notes-search-results">
                  {hits.map((hit) => (
                    <li key={hit.entry.path} data-testid="notes-hit" data-path={hit.entry.path}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          void action.run(
                            () => request('notes.read', { path: hit.entry.path, missionId: null }),
                            setNote
                          )
                        }
                      >
                        {hit.entry.path}
                      </button>{' '}
                      <span className="muted small">{hit.snippet}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>
          <section aria-labelledby="notes-recent-title">
            <h3 id="notes-recent-title">{t('notes.recent')}</h3>
            {/* Listing reads the vault, so it asks for notes.read: only when the person asks. */}
            <button
              type="button"
              className="button"
              disabled={action.busy}
              data-testid="notes-show-recent"
              onClick={() =>
                void action.run(
                  () => request('notes.list', { folder: '', recursive: true, limit: 50 }),
                  (listed) => {
                    setNotes(listed.entries)
                  }
                )
              }
            >
              {t('notes.showRecent')}
            </button>
            {notes ? (
              <ul className="plain-list" data-testid="notes-list">
                {notes.slice(0, 20).map((entry) => (
                  <li key={entry.path} data-testid="notes-entry" data-path={entry.path}>
                    <button
                      type="button"
                      className="link-button"
                      data-testid="notes-read"
                      onClick={() =>
                        void action.run(
                          () => request('notes.read', { path: entry.path, missionId: null }),
                          setNote
                        )
                      }
                    >
                      {entry.path}
                    </button>{' '}
                    <span className="muted small">{formatTime(entry.modifiedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          {note ? <NotePreview note={note} /> : null}
          <CreateNoteForm />
        </>
      ) : null}
    </div>
  )
}

function NotePreview({ note }: { readonly note: Note }) {
  const { t } = useI18n()
  return (
    <section
      className="document-preview"
      aria-labelledby="notes-preview-title"
      data-testid="notes-preview"
    >
      <h3 id="notes-preview-title">{note.entry.path}</h3>
      <p>
        <span className="badge badge-warning" data-testid="notes-untrusted">
          {t('notes.untrusted')}
        </span>{' '}
        <span className="muted small">{t('files.untrustedHint')}</span>
      </p>
      {note.tags.length ? (
        <p className="small" data-testid="notes-tags">
          {note.tags.map((tag) => `#${tag}`).join(' ')}
        </p>
      ) : null}
      {note.links.length ? (
        <p className="small" data-testid="notes-links">
          {t('notes.links')}: {note.links.map((link) => `[[${link}]]`).join(', ')}
        </p>
      ) : null}
      <pre className="document-text" data-testid="notes-text" tabIndex={0}>
        {note.body}
      </pre>
    </section>
  )
}

function CreateNoteForm() {
  const { t } = useI18n()
  const action = useAction()
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [links, setLinks] = useState('')
  const [written, setWritten] = useState<NoteWriteResult | null>(null)
  const list = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  return (
    <section aria-labelledby="notes-create-title" data-testid="notes-create">
      <h3 id="notes-create-title">{t('notes.create')}</h3>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(
            () =>
              request('notes.create', {
                folder: folder.trim(),
                title: title.trim(),
                body,
                tags: list(tags).map((tag) => tag.replace(/^#/, '')),
                links: list(links),
                missionId: null
              }),
            (result) => {
              setWritten(result)
              action.setDone(t('notes.created', { path: result.entry.path }))
            }
          )
        }}
      >
        <div className="field">
          <label htmlFor="notes-create-title-input">{t('notes.title')}</label>
          <input
            id="notes-create-title-input"
            className="input"
            value={title}
            maxLength={150}
            data-testid="notes-create-title"
            onChange={(event) => {
              setTitle(event.target.value)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="notes-create-folder">{t('notes.folder')}</label>
          <input
            id="notes-create-folder"
            className="input"
            value={folder}
            maxLength={300}
            data-testid="notes-create-folder"
            onChange={(event) => {
              setFolder(event.target.value)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="notes-create-body">{t('notes.body')}</label>
          <textarea
            id="notes-create-body"
            className="input"
            rows={4}
            maxLength={100_000}
            value={body}
            data-testid="notes-create-body"
            onChange={(event) => {
              setBody(event.target.value)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="notes-create-tags">{t('memory.tags')}</label>
          <input
            id="notes-create-tags"
            className="input"
            value={tags}
            maxLength={500}
            data-testid="notes-create-tags"
            onChange={(event) => {
              setTags(event.target.value)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="notes-create-links">{t('notes.linkTo')}</label>
          <input
            id="notes-create-links"
            className="input"
            value={links}
            maxLength={1000}
            data-testid="notes-create-links"
            onChange={(event) => {
              setLinks(event.target.value)
            }}
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={action.busy || title.trim() === ''}
            data-testid="notes-create-submit"
          >
            {t('notes.create.button')}
          </button>
        </div>
      </form>
      <ActionStatus action={action} testId="notes-create" />
      {written ? (
        <ul className="small" data-testid="notes-backlinks">
          {written.backlinks.map((item) => (
            <li key={item.path} data-added={item.added}>
              {t(item.added ? 'notes.backlinkAdded' : 'notes.backlinkExisting', {
                path: item.path
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
