import { join } from 'node:path'
import type { Artifact } from '@jupiter/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

/** SET 10 table on real SQLite files: the Artifact Manager's records, validated when read and never deleted. */

let dir: string
let cleanup: () => void
const opened: JupiterDatabase[] = []

beforeEach(() => {
  ;({ dir, cleanup } = tempDirectory())
})

afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  cleanup()
})

async function open(): Promise<JupiterDatabase> {
  const { database } = await JupiterDatabase.open({
    path: join(dir, 'jupiter.db'),
    backupDirectory: join(dir, 'backups')
  })
  opened.push(database)
  return database
}

const MISSION = '01a0d82f-22b6-762b-b369-29675d970c01'
const OTHER_MISSION = '01a0d82f-22b6-762b-b369-29675d970c02'
const STEP = '01a0d82f-22b6-762b-b369-29675d970d01'
const HASH = 'a'.repeat(64)

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  artifactId: '01a0d82f-22b6-762b-b369-29675d970e01',
  missionId: MISSION,
  stepId: STEP,
  name: 'summary.docx',
  type: 'docx',
  location: { root: 'workspace', path: `${MISSION}/summary.docx` },
  path: `/tmp/workspace/${MISSION}/summary.docx`,
  createdAt: '2026-09-27T10:00:00.000Z',
  source: {
    kind: 'generated',
    transformation: 'Created a DOCX document from step “Summarise”',
    fromArtifactId: null,
    fromFile: { root: 'downloads', path: 'report.pdf' }
  },
  version: 1,
  size: 1234,
  hash: HASH,
  verificationStatus: 'VERIFIED',
  verificationDetails: [
    { check: 'content-types-complete', passed: true, detail: 'All parts have a type.' }
  ],
  verifiedAt: '2026-09-27T10:00:00.000Z',
  kept: false,
  deletedAt: null,
  ...overrides
})

describe('artifact store', () => {
  it('saves an artifact with its lineage, updates it, and reads it back validated', async () => {
    const database = await open()
    database.artifacts.save(artifact())
    expect(database.artifacts.artifact(artifact().artifactId)).toEqual(artifact())

    database.artifacts.save(artifact({ kept: true, verificationStatus: 'MISSING' }))
    const updated = database.artifacts.artifact(artifact().artifactId)
    expect(updated?.kept).toBe(true)
    expect(updated?.verificationStatus).toBe('MISSING')
    expect(updated?.source.fromFile).toEqual({ root: 'downloads', path: 'report.pdf' })
    expect(database.artifacts.artifact('01a0d82f-22b6-762b-b369-29675d970eff')).toBeNull()
  })

  it('lists per Mission, newest first, hides deleted files unless asked, and finds the latest version', async () => {
    const database = await open()
    const first = artifact()
    const second = artifact({
      artifactId: '01a0d82f-22b6-762b-b369-29675d970e02',
      name: 'summary.docx',
      location: { root: 'workspace', path: `${MISSION}/summary (2).docx` },
      version: 2,
      createdAt: '2026-09-27T10:01:00.000Z',
      source: { ...first.source, fromArtifactId: first.artifactId }
    })
    const other = artifact({
      artifactId: '01a0d82f-22b6-762b-b369-29675d970e03',
      missionId: OTHER_MISSION,
      name: 'table.xlsx',
      type: 'xlsx',
      location: { root: 'workspace', path: `${OTHER_MISSION}/table.xlsx` },
      createdAt: '2026-09-27T10:02:00.000Z',
      deletedAt: '2026-09-27T10:03:00.000Z'
    })
    for (const item of [first, second, other]) database.artifacts.save(item)

    expect(database.artifacts.forMission(MISSION).map((item) => item.version)).toEqual([1, 2])
    expect(database.artifacts.latestNamed(MISSION, 'summary.docx')?.artifactId).toBe(
      second.artifactId
    )
    expect(database.artifacts.latestNamed(null, 'summary.docx')).toBeNull()
    expect(
      database.artifacts
        .list({ missionId: null, includeDeleted: false, limit: 10 })
        .map((item) => item.artifactId)
    ).toEqual([second.artifactId, first.artifactId])
    expect(
      database.artifacts
        .list({ missionId: null, includeDeleted: true, limit: 10 })
        .map((item) => item.artifactId)
    ).toEqual([other.artifactId, second.artifactId, first.artifactId])
    expect(database.artifacts.atLocation('workspace', `${OTHER_MISSION}/table.xlsx`)).toEqual([])
    expect(database.artifacts.atLocation('workspace', `${MISSION}/summary.docx`)).toHaveLength(1)
  })

  it('refuses invalid artifacts and never lets a record be deleted', async () => {
    const database = await open()
    expect(() => {
      database.artifacts.save(artifact({ hash: 'not-a-hash' }))
    }).toThrow()
    expect(() => {
      database.artifacts.save(artifact({ location: { root: 'workspace', path: '../escape.docx' } }))
    }).toThrow()
    database.artifacts.save(artifact())
    database.close()
    opened.splice(0)

    const direct = raw(join(dir, 'jupiter.db'))
    try {
      expect(() => direct.prepare('DELETE FROM artifacts').run()).toThrow(/never deleted/)
      expect(() =>
        direct.prepare("UPDATE artifacts SET verification_status = 'MAYBE'").run()
      ).toThrow(/CHECK/)
      expect(direct.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 1 })
    } finally {
      direct.close()
    }
  })
})
