import type { DatabaseSync } from 'node:sqlite'
import { Artifact } from '@jupiter/contracts'
import type { ArtifactStore } from '@jupiter/core'
import { json } from '../rows'

type Row = Record<string, unknown>

/** The Artifact Manager's records (SET 10). Rows are validated when read and never deleted. */
export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly db: DatabaseSync) {}

  save(input: Artifact): void {
    const artifact = Artifact.parse(input)
    this.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, mission_id, step_id, name, type, root, rel_path, version,
           size, hash, verification_status, kept, artifact_json, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (artifact_id) DO UPDATE SET size = excluded.size, hash = excluded.hash,
           verification_status = excluded.verification_status, kept = excluded.kept,
           artifact_json = excluded.artifact_json, deleted_at = excluded.deleted_at`
      )
      .run(
        artifact.artifactId,
        artifact.missionId,
        artifact.stepId,
        artifact.name,
        artifact.type,
        artifact.location.root,
        artifact.location.path,
        artifact.version,
        artifact.size,
        artifact.hash,
        artifact.verificationStatus,
        artifact.kept ? 1 : 0,
        JSON.stringify(artifact),
        artifact.createdAt,
        artifact.deletedAt
      )
  }

  artifact(artifactId: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId)
    return row ? toArtifact(row) : null
  }

  list(options: { missionId: string | null; includeDeleted: boolean; limit: number }): Artifact[] {
    const where = [
      options.missionId === null ? null : 'mission_id = ?',
      options.includeDeleted ? null : 'deleted_at IS NULL'
    ].filter((clause): clause is string => clause !== null)
    const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, artifact_id DESC LIMIT ?`
    const params: (string | number)[] = options.missionId === null ? [] : [options.missionId]
    return this.db
      .prepare(sql)
      .all(...params, options.limit)
      .map(toArtifact)
  }

  forMission(missionId: string): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at, artifact_id')
      .all(missionId)
      .map(toArtifact)
  }

  atLocation(root: string, path: string): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE root = ? AND rel_path = ? AND deleted_at IS NULL')
      .all(root, path)
      .map(toArtifact)
  }

  latestNamed(missionId: string | null, name: string): Artifact | null {
    const row =
      missionId === null
        ? this.db
            .prepare('SELECT * FROM artifacts WHERE mission_id IS NULL AND name = ? ORDER BY version DESC LIMIT 1')
            .get(name)
        : this.db
            .prepare('SELECT * FROM artifacts WHERE mission_id = ? AND name = ? ORDER BY version DESC LIMIT 1')
            .get(missionId, name)
    return row ? toArtifact(row) : null
  }
}

function toArtifact(row: Row): Artifact {
  return Artifact.parse(json(row, 'artifact_json'))
}
