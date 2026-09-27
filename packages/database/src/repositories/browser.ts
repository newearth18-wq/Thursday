import type { DatabaseSync } from 'node:sqlite'
import { BrowserTask } from '@jupiter/contracts'
import type { BrowserTaskStore } from '@jupiter/core'
import { json } from '../rows'

type Row = Record<string, unknown>

/** Browser Agent tasks (SET 9). Rows are validated when read. */
export class SqliteBrowserTaskStore implements BrowserTaskStore {
  constructor(private readonly db: DatabaseSync) {}

  save(input: BrowserTask): void {
    const task = BrowserTask.parse(input)
    this.db
      .prepare(
        `INSERT INTO browser_tasks (task_id, mission_id, session_id, status, task_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET status = excluded.status,
           task_json = excluded.task_json, completed_at = excluded.completed_at`
      )
      .run(
        task.taskId,
        task.missionId,
        task.sessionId,
        task.status,
        JSON.stringify(task),
        task.createdAt,
        task.completedAt
      )
  }

  task(taskId: string): BrowserTask | null {
    const row = this.db.prepare('SELECT * FROM browser_tasks WHERE task_id = ?').get(taskId)
    return row ? toTask(row) : null
  }

  /** Newest first. */
  tasks(limit: number): BrowserTask[] {
    return this.db
      .prepare('SELECT * FROM browser_tasks ORDER BY created_at DESC, task_id DESC LIMIT ?')
      .all(limit)
      .map(toTask)
  }

  /** A Mission's browser tasks, oldest first: the evidence linked to it. */
  forMission(missionId: string): BrowserTask[] {
    return this.db
      .prepare('SELECT * FROM browser_tasks WHERE mission_id = ? ORDER BY created_at, task_id')
      .all(missionId)
      .map(toTask)
  }

  running(): BrowserTask[] {
    return this.db
      .prepare("SELECT * FROM browser_tasks WHERE status = 'RUNNING' ORDER BY created_at")
      .all()
      .map(toTask)
  }
}

function toTask(row: Row): BrowserTask {
  return BrowserTask.parse(json(row, 'task_json'))
}
