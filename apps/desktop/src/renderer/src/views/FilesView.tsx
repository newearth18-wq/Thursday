import { useState } from 'react'
import {
  DOCUMENT_FORMATS,
  FILE_ROOTS,
  type DocumentContent,
  type DocumentFormat,
  type ErrorEnvelope,
  type FileEntry,
  type FileListing,
  type FileRoot,
  type SuspiciousContent
} from '@jupiter/contracts'
import { request } from '../api'
import { ArtifactList } from '../components/ArtifactList'
import { Dialog } from '../components/Dialog'
import { Select, Switch } from '../components/FormControls'
import { StateMessage } from '../components/StateMessage'
import { formatBytes } from '../format'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { useFiles, withPermission } from '../useFiles'
import { coreSessionOf, envelopeOf, useRuntimeContext } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import { ViewHeader } from './ViewHeader'

/**
 * Files (SET 10): the approved folders Jupiter may use, finding files in
 * them (by their real modified time, name or size), reading a document —
 * shown as untrusted content — and every artifact Jupiter produced, with
 * how it was verified and what can be done with it. Each action that needs
 * a permission asks for it in the permission dialog first.
 */

type AnyFormat = DocumentFormat | 'any'
type Sort = 'modified' | 'name' | 'size'

interface Preview {
  readonly file: FileEntry
  readonly content: DocumentContent
  readonly suspicious: readonly SuspiciousContent[]
}

export function FilesView() {
  const { t, locale: language } = useI18n()
  const { status: runtime } = useRuntimeContext()
  const coreSession = coreSessionOf(runtime)
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const { status, artifacts } = useFiles(coreSession, { missionId: null, includeDeleted })
  const [root, setRoot] = useState<FileRoot>('downloads')
  const [format, setFormat] = useState<AnyFormat>('any')
  const [sort, setSort] = useState<Sort>('modified')
  const [recursive, setRecursive] = useState(false)
  const [name, setName] = useState('')
  const [listing, setListing] = useState<FileListing | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<ErrorEnvelope | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<FileEntry | null>(null)
  const locale = intlLocale(language)
  const formatTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—'

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

  const find = () =>
    run(
      () =>
        request('files.find', {
          query: {
            root,
            folder: '',
            recursive,
            formats: format === 'any' ? [] : [format],
            nameContains: name.trim() || null,
            sortBy: sort,
            order: sort === 'name' ? 'asc' : 'desc',
            limit: 100
          },
          missionId: null
        }),
      (result) => {
        setListing(result)
        setPreview(null)
      }
    )

  const read = (entry: FileEntry) =>
    run(
      () =>
        request('files.read', {
          location: { root: entry.root, path: entry.path },
          maxChars: 20_000,
          missionId: null
        }),
      (result) => {
        setPreview(result)
      }
    )

  const location = (entry: FileEntry) => ({ root: entry.root, path: entry.path })

  return (
    <section className="view view-files" aria-labelledby="files-title">
      <ViewHeader id="files-title" title={t('nav.files')} />
      <p className="muted">{t('files.intro')}</p>
      {coreSession === null ? (
        <StateMessage kind="unavailable" title={t('files.coreDown')} testId="files-core-down" />
      ) : null}

      <section className="card" aria-labelledby="files-roots-title" data-testid="files-roots">
        <h2 id="files-roots-title">{t('files.roots')}</h2>
        {status.state === 'error' ? (
          <LoadFailure title={t('files.statusFailed')} error={status.error} />
        ) : null}
        {status.state === 'ready' ? (
          <>
            <p data-testid="files-availability" data-available={status.value.available}>
              <span className={`badge badge-${status.value.available ? 'success' : 'muted'}`}>
                {t(status.value.available ? 'files.available' : 'availability.UNAVAILABLE')}
              </span>{' '}
              {status.value.reason ??
                t('files.formats', {
                  read: status.value.readFormats.map((item) => item.toUpperCase()).join(', '),
                  create: status.value.createFormats.map((item) => item.toUpperCase()).join(', ')
                })}
            </p>
            <table className="facts-table">
              <tbody>
                {status.value.roots.map((item) => (
                  <tr
                    key={item.root}
                    data-testid="files-root"
                    data-root={item.root}
                    data-available={item.available}
                  >
                    <th scope="row">{t(`files.root.${item.root}` as MessageKey)}</th>
                    <td>
                      {item.path ? <code>{item.path}</code> : null}{' '}
                      {item.available ? null : (
                        <span className="badge badge-muted">{t('availability.UNAVAILABLE')}</span>
                      )}{' '}
                      {item.reason ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </section>

      <section className="card" aria-labelledby="files-find-title">
        <h2 id="files-find-title">{t('files.find')}</h2>
        <form
          className="files-find-form"
          onSubmit={(event) => {
            event.preventDefault()
            void find()
          }}
        >
          <Select
            label={t('files.folder')}
            value={root}
            testId="files-root-select"
            choices={FILE_ROOTS.map((value) => ({
              value,
              label: t(`files.root.${value}` as MessageKey)
            }))}
            onChange={setRoot}
          />
          <Select<AnyFormat>
            label={t('files.format')}
            value={format}
            testId="files-format-select"
            choices={[
              { value: 'any', label: t('files.anyFormat') },
              ...DOCUMENT_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))
            ]}
            onChange={setFormat}
          />
          <Select<Sort>
            label={t('files.sort')}
            value={sort}
            testId="files-sort-select"
            choices={[
              { value: 'modified', label: t('files.sort.modified') },
              { value: 'name', label: t('files.sort.name') },
              { value: 'size', label: t('files.sort.size') }
            ]}
            onChange={setSort}
          />
          <div className="field">
            <label htmlFor="files-name">{t('files.nameContains')}</label>
            <input
              id="files-name"
              className="input"
              value={name}
              maxLength={100}
              data-testid="files-name"
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          </div>
          <Switch
            label={t('files.recursive')}
            checked={recursive}
            testId="files-recursive"
            onChange={setRecursive}
          />
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || coreSession === null}
            data-testid="files-find"
          >
            {t('files.findButton')}
          </button>
        </form>
        <p className="small" role="status" data-testid="files-status">
          {waiting ? t('files.waitingPermission') : busy ? t('files.working') : (done ?? '')}
        </p>
        {error ? (
          <LoadFailure title={t('files.actionFailed')} error={error} testId="files-error" />
        ) : null}
        {listing ? (
          <>
            <p className="muted small" data-testid="files-summary">
              {t('files.found', { count: listing.entries.length, scanned: listing.scanned })}
              {listing.skipped > 0 ? ` ${t('files.skipped', { count: listing.skipped })}` : ''}
            </p>
            <table className="data-table" data-testid="files-results">
              <thead>
                <tr>
                  <th scope="col">{t('files.name')}</th>
                  <th scope="col">{t('files.modified')}</th>
                  <th scope="col">{t('files.size')}</th>
                  <th scope="col">{t('files.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {listing.entries.map((entry) => (
                  <tr
                    key={`${entry.root}/${entry.path}`}
                    data-testid="files-entry"
                    data-name={entry.name}
                  >
                    <td>
                      {entry.path}
                      {entry.format ? (
                        <span className="badge badge-muted">{entry.format.toUpperCase()}</span>
                      ) : null}
                    </td>
                    <td>{formatTime(entry.modifiedAt)}</td>
                    <td>
                      {entry.kind === 'file' ? formatBytes(t, entry.size) : t('files.folderKind')}
                    </td>
                    <td className="actions">
                      {entry.format ? (
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          data-testid="files-read"
                          onClick={() => void read(entry)}
                        >
                          {t('files.read')}
                        </button>
                      ) : null}
                      {entry.kind === 'file' ? (
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          data-testid="files-open"
                          onClick={() =>
                            void run(
                              () => request('files.open', { location: location(entry) }),
                              () => {
                                setDone(t('artifacts.opened'))
                              }
                            )
                          }
                        >
                          {t('artifacts.open')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        data-testid="files-reveal"
                        onClick={() =>
                          void run(
                            () => request('files.reveal', { location: location(entry) }),
                            () => {
                              setDone(t('artifacts.revealed'))
                            }
                          )
                        }
                      >
                        {t('artifacts.reveal')}
                      </button>
                      {entry.kind === 'file' ? (
                        <button
                          type="button"
                          className="button button-danger"
                          disabled={busy}
                          data-testid="files-delete"
                          onClick={() => {
                            setDeleting(entry)
                          }}
                        >
                          {t('artifacts.delete')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
        {preview ? <DocumentPreview preview={preview} formatTime={formatTime} /> : null}
      </section>

      <section
        className="card"
        aria-labelledby="files-artifacts-title"
        data-testid="files-artifacts"
      >
        <h2 id="files-artifacts-title">{t('artifacts.title')}</h2>
        <p className="muted small">{t('artifacts.intro')}</p>
        <Switch
          label={t('artifacts.showDeleted')}
          checked={includeDeleted}
          testId="artifacts-show-deleted"
          onChange={setIncludeDeleted}
        />
        {artifacts.state === 'error' ? (
          <LoadFailure title={t('artifacts.loadFailed')} error={artifacts.error} />
        ) : null}
        {artifacts.state === 'ready' ? (
          <ArtifactList artifacts={artifacts.value} formatTime={formatTime} />
        ) : null}
      </section>

      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null)
        }}
        title={t('artifacts.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('files.deleteDescription', { path: deleting?.path ?? '' })}
        role="alertdialog"
        testId="files-delete-dialog"
        footer={
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                setDeleting(null)
              }}
            >
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              className="button button-danger"
              data-testid="files-delete-confirm"
              onClick={() => {
                const entry = deleting
                setDeleting(null)
                if (entry)
                  void run(
                    () => request('files.delete', { location: location(entry), missionId: null }),
                    () => {
                      setDone(t('artifacts.deletedDone'))
                      setListing((current) =>
                        current
                          ? {
                              ...current,
                              entries: current.entries.filter((item) => item !== entry)
                            }
                          : current
                      )
                    }
                  )
              }}
            >
              {t('artifacts.deleteConfirm')}
            </button>
          </>
        }
      />
    </section>
  )
}

function DocumentPreview({
  preview,
  formatTime
}: {
  readonly preview: Preview
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const { file, content, suspicious } = preview
  const meta = content.metadata
  return (
    <section
      className="document-preview"
      aria-labelledby="files-preview-title"
      data-testid="files-preview"
      data-format={content.format}
    >
      <h3 id="files-preview-title">{file.name}</h3>
      <p>
        <span className="badge badge-warning" data-testid="files-untrusted">
          {t('files.untrusted')}
        </span>{' '}
        <span className="muted small">{t('files.untrustedHint')}</span>
      </p>
      {suspicious.length > 0 ? (
        <ul className="small" data-testid="files-suspicious">
          {suspicious.map((item) => (
            <li key={item.kind}>
              <span className="badge badge-warning">
                {t(`suspicious.${item.kind}` as MessageKey)}
              </span>{' '}
              “{item.excerpt}”
            </li>
          ))}
        </ul>
      ) : null}
      <table className="facts-table">
        <tbody>
          {meta.title ? (
            <tr>
              <th scope="row">{t('files.meta.title')}</th>
              <td data-testid="files-meta-title">{meta.title}</td>
            </tr>
          ) : null}
          {meta.author ? (
            <tr>
              <th scope="row">{t('files.meta.author')}</th>
              <td>{meta.author}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">{t('files.meta.shape')}</th>
            <td data-testid="files-meta-shape">
              {meta.pages !== null ? t('files.meta.pages', { count: meta.pages }) : null}
              {meta.slides !== null ? t('files.meta.slides', { count: meta.slides }) : null}
              {meta.sheets !== null ? t('files.meta.sheets', { count: meta.sheets }) : null}
              {meta.pages === null && meta.slides === null && meta.sheets === null
                ? t('files.meta.characters', { count: content.characters })
                : null}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('files.modified')}</th>
            <td>{formatTime(file.modifiedAt)}</td>
          </tr>
        </tbody>
      </table>
      {content.slides.length > 0 ? (
        <ol className="small" data-testid="files-slides">
          {content.slides.map((slide) => (
            <li key={slide.number}>
              <strong>{slide.title || t('files.untitled')}</strong>
              {slide.notes ? (
                <span className="muted">
                  {' '}
                  — {t('files.notes')}: {slide.notes}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {content.sheets.length > 0 ? (
        <ul className="small" data-testid="files-sheets">
          {content.sheets.map((sheet) => (
            <li key={sheet.name}>
              <strong>{sheet.name}</strong> —{' '}
              {t('files.sheetShape', {
                rows: sheet.rows,
                columns: sheet.columns,
                formulas: sheet.formulas
              })}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="document-text" data-testid="files-text" tabIndex={0}>
        {content.text}
      </pre>
      {content.truncated ? (
        <p className="muted small">
          {t('files.truncated', { shown: content.text.length, total: content.characters })}
        </p>
      ) : null}
    </section>
  )
}
