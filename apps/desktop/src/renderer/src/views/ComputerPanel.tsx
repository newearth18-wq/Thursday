import type { ComputerTask } from '@jupiter/contracts'
import { useI18n, type MessageKey } from '../i18n'
import { TASK_TONE, methodText } from '../computerText'
import { useComputer } from '../useComputer'

/**
 * Diagnostics › Computer Agent (SET 8): whether the agent can act on this
 * computer (and why not), its runtime process, and the last tasks with what
 * each action really observed. A coordinate click is labelled as such.
 */
export function ComputerPanel({
  coreSession,
  formatTime
}: {
  readonly coreSession: string | null
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  const { status, tasks } = useComputer(coreSession)
  return (
    <section className="card" aria-labelledby="diag-computer" data-testid="diag-computer">
      <h2 id="diag-computer">{t('computer.title')}</h2>
      {status.state === 'error' ? (
        <p className="notice notice-error" role="alert">
          {t('computer.statusFailed')}: {status.error.message}
        </p>
      ) : null}
      {status.state === 'ready' ? (
        <table className="facts-table">
          <tbody>
            <tr>
              <th scope="row">{t('computer.availability')}</th>
              <td data-testid="computer-availability" data-available={status.value.available}>
                <span className={`badge badge-${status.value.available ? 'success' : 'muted'}`}>
                  {t(status.value.available ? 'computer.available' : 'availability.UNAVAILABLE')}
                </span>{' '}
                {status.value.reason ?? ''}
              </td>
            </tr>
            <tr>
              <th scope="row">{t('computer.runtime')}</th>
              <td data-testid="computer-runtime">
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
            {status.value.screen ? (
              <tr>
                <th scope="row">{t('computer.screen')}</th>
                <td>
                  {status.value.screen.width}×{status.value.screen.height}
                </td>
              </tr>
            ) : null}
            {status.value.saveFolder ? (
              <tr>
                <th scope="row">{t('computer.saveFolder')}</th>
                <td>
                  <code>{status.value.saveFolder}</code>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}

      <h3>{t('computer.tasks')}</h3>
      {tasks.state === 'ready' && tasks.value.length === 0 ? (
        <p className="muted small">{t('computer.noTasks')}</p>
      ) : null}
      {tasks.state === 'ready' && tasks.value.length > 0 ? (
        <ol className="permission-list" data-testid="computer-tasks">
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
  readonly task: ComputerTask
  readonly formatTime: (iso: string | null) => string
}) {
  const { t } = useI18n()
  return (
    <li className="permission-item" data-testid="computer-task" data-status={task.status}>
      <div className="permission-item-main">
        <span>
          <strong>{task.title}</strong>{' '}
          <span className={`badge badge-${TASK_TONE[task.status]}`}>
            {t(`computerStatus.${task.status}` as MessageKey)}
          </span>
        </span>
        <span className="muted small">{formatTime(task.createdAt)}</span>
        {task.error ? <span className="small">{task.error.message}</span> : null}
        <ol className="computer-actions">
          {task.results.map((result) => (
            <li
              key={result.index}
              data-testid="computer-action"
              data-action={result.action}
              data-method={result.method}
              data-success={result.success}
            >
              <span className={`badge badge-${result.success ? 'success' : 'error'}`}>
                {t(result.success ? 'computer.done' : 'computer.notDone')}
              </span>{' '}
              <code>{result.action}</code>{' '}
              <span
                className={`badge badge-${result.method === 'coordinate' ? 'warning' : 'muted'}`}
              >
                {methodText(result.method, t)}
              </span>{' '}
              <span className="small">{result.observation}</span>
            </li>
          ))}
        </ol>
      </div>
    </li>
  )
}
