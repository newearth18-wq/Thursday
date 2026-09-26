import type { DatabaseSync } from 'node:sqlite'
import { ComputerTask } from '@jupiter/contracts'
import type { ComputerTaskStore } from '@jupiter/core'
import { json } from '../rows'

type Row = Record<string, unknown>

/** Computer Agent tasks (SET 8). Rows are validated when read. */
export class SqliteComputerTaskStore implements ComputerTaskStore {
  constructor(private readonly db: DatabaseSync) {}

  save(input: ComputerTask): void {
    const task = ComputerTask.parse(input)
    this.db
      .prepare(
        `INSERT INTO computer_tasks (task_id, mission_id, status, task_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET status = excluded.status,
           task_json = excluded.task_json, completed_at = excluded.completed_at`
      )
      .run(
        task.taskId,
        task.missionId,
        task.status,
        JSON.stringify(task),
        task.createdAt,
        task.completedAt
      )
  }

  task(taskId: string): ComputerTask | null {
    const row = this.db.prepare('SELECT * FROM computer_tasks WHERE task_id = ?').get(taskId)
    return row ? toTask(row) : null
  }

  /** Newest first. */
  tasks(limit: number): ComputerTask[] {
    return this.db
      .prepare('SELECT * FROM computer_tasks ORDER BY created_at DESC, task_id DESC LIMIT ?')
      .all(limit)
      .map(toTask)
  }

  running(): ComputerTask[] {
    return this.db
      .prepare("SELECT * FROM computer_tasks WHERE status = 'RUNNING' ORDER BY created_at")
      .all()
      .map(toTask)
  }
}

function toTask(row: Row): ComputerTask {
  return ComputerTask.parse(json(row, 'task_json'))
}
