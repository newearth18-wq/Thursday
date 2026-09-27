import type { BrowserActionResult, BrowserTask } from '@jupiter/contracts'
import { BROWSER_TASK_TONE, browserMethodText } from '../browserText'
import { useI18n, type MessageKey } from '../i18n'
import { useBrowser } from '../useBrowser'

/**
 * Diagnostics › Browser Agent (SET 9): whether the agent can browse (and why
 * not), the browser and runtime it uses, where downloads and uploads are
 * kept, and the last tasks with each action's page, method and observation.
 * Page content is marked as untrusted; text that tried to direct the agent
 * and a stop for an unexpected site are shown as such.
 */
export function BrowserPanel({
  coreSession,
  formatTime
}: {
  readonly coreSession: string | null
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const { status, tasks } = useBrowser(coreSession)
  return (
    <section className="card" aria-labelledby="diag-browser" data-testid="diag-browser">
      <h2 id="diag-browser">{t('browser.title')}</h2>
      {status.state === 'error' ? (
        <p className="notice notice-error" role="alert">
          {t('browser.statusFailed')}: {status.error.message}
        </p>
      ) : null}
      {status.state === 'ready' ? (
        <table className="facts-table">
          <tbody>
            <tr>
              <th scope="row">{t('browser.availability')}</th>
              <td data-testid="browser-availability" data-available={status.value.available}>
                <span className={`badge badge-${status.value.available ? 'success' : 'muted'}`}>
                  {t(status.value.available ? 'browser.available' : 'availability.UNAVAILABLE')}
                </span>{' '}
                {status.value.reason ?? ''}
              </td>
            </tr>
            {status.value.browser ? (
              <tr>
                <th scope="row">{t('browser.browser')}</th>
                <td data-testid="browser-name">
                  {status.value.browser}
                  {status.value.version ? ` ${status.value.version}` : ''}
                </td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">{t('browser.runtime')}</th>
              <td data-testid="browser-runtime">
                {t(`computerRuntime.${status.value.runtime.state}` as MessageKey)}
                {status.value.runtime.pid !== null
                  ? ` · ${t('computer.pid', { pid: status.value.runtime.pid })}`
                  : ''}
                {status.value.runtime.restarts > 0
                  ? ` · ${t('computer.restarts', { count: status.value.runtime.restarts })}`
                  : ''}
              </td>
            </tr>
            {status.value.runtime.lastError ? (
              <tr>
                <th scope="row">{t('computer.lastError')}</th>
                <td>{status.value.runtime.lastError}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">{t('browser.profile')}</th>
              <td data-testid="browser-profile">
                {t(
                  status.value.persistentProfile
                    ? 'browser.profilePersistent'
                    : 'browser.profileTemporary'
                )}
              </td>
            </tr>
            {status.value.downloadsFolder ? (
              <tr>
                <th scope="row">{t('browser.downloads')}</th>
                <td>
                  <code>{status.value.downloadsFolder}</code>
                </td>
              </tr>
            ) : null}
            {status.value.uploadsFolder ? (
              <tr>
                <th scope="row">{t('browser.uploads')}</th>
                <td>
                  <code>{status.value.uploadsFolder}</code>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}

      <h3>{t('browser.tasks')}</h3>
      {tasks.state === 'ready' && tasks.value.length === 0 ? (
        <p className="muted small">{t('browser.noTasks')}</p>
      ) : null}
      {tasks.state === 'ready' && tasks.value.length > 0 ? (
        <ol className="permission-list" data-testid="browser-tasks">
          {tasks.value.map((task) => (
            <TaskItem key={task.taskId} task={task} formatTime={formatTime} />
          ))}
        </ol>
      ) : null}
    </section>
  )
}

function TaskItem({
  task,
  formatTime
}: {
  readonly task: BrowserTask
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  return (
    <li className="permission-item" data-testid="browser-task" data-status={task.status}>
      <div className="permission-item-main">
        <span>
          <strong>{task.title}</strong>{' '}
          <span className={`badge badge-${BROWSER_TASK_TONE[task.status]}`}>
            {t(`browserStatus.${task.status}` as MessageKey)}
          </span>
        </span>
        <span className="muted small">
          {formatTime(task.createdAt)} · {t('browser.allowedOrigins')}:{' '}
          {task.allowedOrigins.join(', ') || '—'}
        </span>
        {task.error ? <span className="small">{task.error.message}</span> : null}
        <ol className="computer-actions">
          {task.results.map((result) => (
            <ActionItem key={result.index} result={result} />
          ))}
        </ol>
      </div>
    </li>
  )
}

function ActionItem({ result }: { readonly result: BrowserActionResult }) {
  const { t } = useI18n()
  return (
    <li
      data-testid="browser-action"
      data-action={result.action}
      data-method={result.method}
      data-success={result.success}
      data-suspicious={result.suspicious.length}
    >
      <span className={`badge badge-${result.success ? 'success' : 'error'}`}>
        {t(result.success ? 'computer.done' : 'computer.notDone')}
      </span>{' '}
      <code>{result.action}</code>{' '}
      <span className={`badge badge-${result.method === 'coordinate' ? 'warning' : 'muted'}`}>
        {browserMethodText(result.method, t)}
      </span>{' '}
      {result.origin ? <code className="small">{result.origin}</code> : null}{' '}
      <span className="small">{result.observation}</span>
      {result.content ? (
        <span className="badge badge-muted" data-testid="browser-untrusted">
          {t('browser.untrusted')}
        </span>
      ) : null}
      {result.suspicious.length > 0 ? (
        <ul className="computer-actions" data-testid="browser-suspicious">
          {result.suspicious.map((item) => (
            <li key={item.kind}>
              <span className="badge badge-warning">
                {t(`suspicious.${item.kind}` as MessageKey)}
              </span>{' '}
              <span className="small">“{item.excerpt}”</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
