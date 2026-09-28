import {
  type ActorType,
  type Artifact,
  type ArtifactSource,
  type DocumentContent,
  type DocumentSpec,
  type DomainEventType,
  type EventPayload,
  type FileEntry,
  type FileListing,
  type FileLocation,
  type FileQuery,
  type FilesStatus,
  type PermissionSubject,
  type ResolvedLocation,
  type SuspiciousContent,
  type UserRoot
} from '@jupiter/contracts'
import { findSuspiciousInstructions } from '../browser/injection'
import { JupiterError } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import { permissionUserAction, type PermissionEngine } from '../permissions/engine'
import type { DatabasePort } from '../ports'
import type { FileDriver } from './driver'

/**
 * The File Agent and the Artifact Manager (SET 10).
 *
 * The host resolves every location inside an approved folder and refuses
 * links, junctions and escapes; Core decides whether an operation may
 * happen. Each one is checked by the Permission Engine at the moment of use,
 * for its exact target (the resolved path): listing a folder, reading a
 * file, writing a new one, opening it, and — CRITICAL, asked every time —
 * moving a file to the Recycle Bin. What a document says is untrusted data:
 * text that tries to direct Jupiter is labelled, never followed.
 *
 * The Artifact Manager keeps a record of every file Jupiter produces: where
 * it is, what it came from (lineage), its version, size and SHA-256, and how
 * it was verified. Records are never deleted. Cleanup removes a Mission's
 * intermediate files only, never what the person chose to keep.
 */

export const FILE_AGENT: PermissionSubject = { kind: 'agent', id: 'files', name: 'File Agent' }

export interface FileContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly missionId?: string | null
  readonly missionTitle?: string | null
  readonly stepId?: string | null
  readonly stepTitle?: string | null
  readonly signal?: AbortSignal
}

export interface FileAgentOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly driver: FileDriver
}

type Operation = EventPayload<'file.operation'>['op']

const SHARED_FOLDER = 'shared'

export class FileAgent {
  constructor(private readonly options: FileAgentOptions) {}

  status(): Promise<FilesStatus> {
    return this.options.driver.call('status', {})
  }

  // ---- the File Agent -----------------------------------------------------------------------

  async find(query: FileQuery, context: FileContext): Promise<FileListing> {
    return this.operation('find', { root: query.root, path: query.folder }, context, async () => {
      const folder = await this.resolve({ root: query.root, path: query.folder }, context)
      this.permit('files.list', folder.path, `Look for files in ${folder.path}`, context)
      return this.options.driver.call('list', { query }, context.signal)
    })
  }

  async read(
    location: FileLocation,
    maxChars: number,
    context: FileContext
  ): Promise<{ file: FileEntry; content: DocumentContent; suspicious: SuspiciousContent[] }> {
    return this.operation('read', location, context, async () => {
      const resolved = await this.resolve(location, context)
      // Nothing to ask the person about when there is no file to read.
      if (!resolved.exists || resolved.kind !== 'file')
        throw new JupiterError('FILE_NOT_FOUND', `There is no file at ${resolved.path}.`, {
          category: 'validation',
          userAction: 'Check the name and folder, then try again.'
        })
      this.permit('files.read', resolved.path, `Read ${resolved.path}`, context)
      const file = await this.options.driver.call('stat', { location }, context.signal)
      const content = await this.options.driver.call(
        'extract',
        { location, maxChars },
        context.signal
      )
      return { file, content, suspicious: findSuspiciousInstructions(content.text) }
    })
  }

  async copy(from: FileLocation, to: FileLocation, context: FileContext): Promise<FileEntry> {
    return this.operation('copy', to, context, async () => {
      const source = await this.resolve(from, context)
      const target = await this.resolve(to, context)
      if (from.root !== 'workspace')
        this.permit('files.read', source.path, `Copy ${source.path}`, context)
      this.permit(
        'files.write',
        target.path,
        `Save a copy of ${source.path} as ${target.path}`,
        context
      )
      const written = await this.options.driver.call('copy', { from, to }, context.signal)
      return this.options.driver.call('stat', { location: written.location }, context.signal)
    })
  }

  async move(from: FileLocation, to: FileLocation, context: FileContext): Promise<FileEntry> {
    return this.operation('move', from, context, async () => {
      const source = await this.resolve(from, context)
      const target = await this.resolve(to, context)
      this.permit('files.write', source.path, `Move ${source.path} to ${target.path}`, context)
      this.permit('files.write', target.path, `Move ${source.path} to ${target.path}`, context)
      const moved = await this.options.driver.call('move', { from, to }, context.signal)
      return this.options.driver.call('stat', { location: moved.location }, context.signal)
    })
  }

  async mkdir(location: FileLocation, context: FileContext): Promise<FileEntry> {
    return this.operation('mkdir', location, context, async () => {
      const target = await this.resolve(location, context)
      this.permit('files.write', target.path, `Create the folder ${target.path}`, context)
      await this.options.driver.call('mkdir', { location }, context.signal)
      return this.options.driver.call('stat', { location }, context.signal)
    })
  }

  async open(location: FileLocation, context: FileContext): Promise<{ done: boolean }> {
    return this.operation('open', location, context, async () => {
      const target = await this.resolve(location, context)
      this.permit('files.open', target.path, `Open ${target.path}`, context)
      return this.options.driver.call('open', { location }, context.signal)
    })
  }

  async reveal(location: FileLocation, context: FileContext): Promise<{ done: boolean }> {
    return this.operation('reveal', location, context, async () => {
      const target = await this.resolve(location, context)
      this.permit('files.open', target.path, `Show ${target.path} in its folder`, context)
      return this.options.driver.call('reveal', { location }, context.signal)
    })
  }

  /** Moves one file to the Recycle Bin: CRITICAL, for the exact file, asked every time. */
  async delete(location: FileLocation, context: FileContext): Promise<{ done: boolean }> {
    return this.operation('delete', location, context, async () => {
      const target = await this.resolve(location, context)
      if (!target.exists || target.kind !== 'file')
        throw new JupiterError('FILE_NOT_FOUND', `There is no file at ${target.path}.`, {
          category: 'validation',
          userAction: null
        })
      this.permit('files.delete', target.path, `Move ${target.path} to the Recycle Bin`, context)
      const done = await this.options.driver.call('trash', { location }, context.signal)
      for (const artifact of this.options
        .database()
        .artifacts.atLocation(location.root, target.location.path))
        this.markDeleted(artifact, context, 'deleted')
      return done
    })
  }

  // ---- the Artifact Manager -------------------------------------------------------------------

  artifacts(options: {
    missionId: string | null
    includeDeleted: boolean
    limit: number
  }): Artifact[] {
    return this.options.database().artifacts.list(options)
  }

  forMission(missionId: string): Artifact[] {
    return this.options.database().artifacts.forMission(missionId)
  }

  /**
   * Creates a document in the Mission's workspace folder (or Jupiter's
   * shared one), written atomically and checked by the host, and records it.
   * A second document of the same name in the same Mission is its next
   * version; the first is kept.
   */
  async createArtifact(
    input: {
      missionId: string | null
      name: string
      spec: DocumentSpec
      stepId?: string | null
      source?: ArtifactSource
    },
    context: FileContext
  ): Promise<Artifact> {
    const folder: FileLocation = { root: 'workspace', path: input.missionId ?? SHARED_FOLDER }
    return this.operation('create', folder, context, async () => {
      const resolved = await this.resolve(folder, context)
      this.permit(
        'artifacts.create',
        resolved.path,
        `Create "${input.name}" in ${resolved.path}`,
        context
      )
      const written = await this.options.driver.call(
        'create',
        { folder, name: input.name, spec: input.spec },
        context.signal
      )
      const database = this.options.database()
      const previous = database.artifacts.latestNamed(input.missionId, input.name)
      const now = this.now()
      const artifact: Artifact = {
        artifactId: uuidv7(),
        missionId: input.missionId,
        stepId: input.stepId ?? null,
        name: input.name,
        type: input.spec.format,
        location: written.location,
        path: written.path,
        createdAt: now,
        source: input.source ?? {
          kind: 'generated',
          transformation: `Created a ${input.spec.format.toUpperCase()} document${previous ? ` (a new version of version ${String(previous.version)})` : ''}`,
          fromArtifactId: previous?.artifactId ?? null,
          fromFile: null
        },
        version: previous ? previous.version + 1 : 1,
        size: written.size,
        hash: written.hash,
        verificationStatus: written.valid ? 'VERIFIED' : 'FAILED',
        verificationDetails: written.checks,
        verifiedAt: now,
        kept: false,
        deletedAt: null
      }
      database.transactions.run(() => {
        database.artifacts.save(artifact)
        this.publish(
          artifact.artifactId,
          'artifact.created',
          {
            artifactId: artifact.artifactId,
            missionId: artifact.missionId,
            name: artifact.name,
            type: artifact.type,
            version: artifact.version,
            verificationStatus: artifact.verificationStatus
          },
          context,
          artifact.missionId
        )
      })
      return artifact
    })
  }

  private find_(artifactId: string): Artifact {
    const artifact = this.options.database().artifacts.artifact(artifactId)
    if (!artifact)
      throw new JupiterError('ARTIFACT_NOT_FOUND', 'There is no such artifact.', {
        category: 'validation',
        userAction: null
      })
    return artifact
  }

  private live(artifactId: string): Artifact {
    const artifact = this.find_(artifactId)
    if (artifact.deletedAt)
      throw new JupiterError(
        'ARTIFACT_DELETED',
        `"${artifact.name}" was moved to the Recycle Bin.`,
        {
          category: 'validation',
          userAction: 'Restore it from the Recycle Bin to use it again.'
        }
      )
    return artifact
  }

  /** Checks the file again: still there, the same content, still a valid document. */
  async verifyArtifact(artifactId: string, context: FileContext): Promise<Artifact> {
    const artifact = this.live(artifactId)
    const result = await this.options.driver.call(
      'verify',
      { location: artifact.location, format: artifact.type, hash: artifact.hash },
      context.signal
    )
    const updated: Artifact = {
      ...artifact,
      verificationStatus: !result.exists ? 'MISSING' : result.valid ? 'VERIFIED' : 'FAILED',
      verificationDetails: result.checks,
      verifiedAt: this.now()
    }
    this.saveChange(updated, 'verified', context)
    return updated
  }

  openArtifact(artifactId: string, context: FileContext): Promise<{ done: boolean }> {
    return this.open(this.live(artifactId).location, context)
  }

  revealArtifact(artifactId: string, context: FileContext): Promise<{ done: boolean }> {
    return this.reveal(this.live(artifactId).location, context)
  }

  /** Share: a copy in one of the person's folders, under a free name. The copy is kept. */
  async shareArtifact(artifactId: string, root: UserRoot, context: FileContext): Promise<Artifact> {
    const artifact = this.live(artifactId)
    const file = artifact.location.path.split('/').at(-1) ?? artifact.name
    const dot = file.lastIndexOf('.')
    const stem = dot > 0 ? file.slice(0, dot) : file
    const extension = dot > 0 ? file.slice(dot) : ''
    let target: ResolvedLocation | null = null
    for (let index = 1; index <= 100 && !target; index++) {
      const candidate = await this.resolve(
        { root, path: index === 1 ? file : `${stem} (${String(index)})${extension}` },
        context
      )
      if (!candidate.exists) target = candidate
    }
    if (!target)
      throw new JupiterError('FILE_EXISTS', `There are already 100 files named like "${file}".`, {
        category: 'validation',
        userAction: 'Move or rename some of them first.'
      })
    const destination = target
    return this.operation('copy', destination.location, context, async () => {
      this.permit(
        'files.write',
        destination.path,
        `Save a copy of "${artifact.name}" as ${destination.path}`,
        context
      )
      const written = await this.options.driver.call(
        'copy',
        { from: artifact.location, to: destination.location },
        context.signal
      )
      const now = this.now()
      const copy: Artifact = {
        ...artifact,
        artifactId: uuidv7(),
        location: written.location,
        path: written.path,
        createdAt: now,
        source: {
          kind: 'shared',
          transformation: `Saved a copy in ${root}`,
          fromArtifactId: artifact.artifactId,
          fromFile: artifact.location
        },
        size: written.size,
        hash: written.hash,
        verificationStatus: written.valid ? 'VERIFIED' : 'FAILED',
        verificationDetails: written.checks,
        verifiedAt: now,
        kept: true,
        deletedAt: null
      }
      const database = this.options.database()
      database.transactions.run(() => {
        database.artifacts.save(copy)
        this.publish(
          copy.artifactId,
          'artifact.created',
          {
            artifactId: copy.artifactId,
            missionId: copy.missionId,
            name: copy.name,
            type: copy.type,
            version: copy.version,
            verificationStatus: copy.verificationStatus
          },
          context,
          copy.missionId
        )
        this.publish(
          artifact.artifactId,
          'artifact.changed',
          {
            artifactId: artifact.artifactId,
            missionId: artifact.missionId,
            change: 'shared',
            verificationStatus: artifact.verificationStatus
          },
          context,
          artifact.missionId
        )
      })
      return copy
    })
  }

  keepArtifact(artifactId: string, kept: boolean, context: FileContext): Artifact {
    const updated = { ...this.find_(artifactId), kept }
    this.saveChange(updated, kept ? 'kept' : 'released', context)
    return updated
  }

  /** Moves the artifact's file to the Recycle Bin (CRITICAL, asked every time); the record stays. */
  async deleteArtifact(artifactId: string, context: FileContext): Promise<Artifact> {
    const artifact = this.live(artifactId)
    await this.delete(artifact.location, context)
    return this.find_(artifactId)
  }

  /** Removes a finished Mission's workspace files that were not kept. */
  async cleanup(missionId: string, context: FileContext): Promise<{ removed: number }> {
    const database = this.options.database()
    const mission = database.missions.mission(missionId)
    if (!mission)
      throw new JupiterError('MISSION_NOT_FOUND', 'There is no such Mission.', {
        category: 'validation',
        userAction: null
      })
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(mission.status))
      throw new JupiterError(
        'MISSION_NOT_FINISHED',
        'A Mission that is still going keeps its files.',
        {
          category: 'validation',
          userAction: 'Clean up after the Mission has finished.'
        }
      )
    const all = database.artifacts.forMission(missionId)
    const keep = all
      .filter((artifact) => artifact.kept && artifact.location.root === 'workspace')
      .map((artifact) => artifact.location.path)
    return this.operation('cleanup', { root: 'workspace', path: missionId }, context, () =>
      this.clean(missionId, all, keep, context)
    )
  }

  private async clean(
    missionId: string,
    all: readonly Artifact[],
    keep: string[],
    context: FileContext
  ): Promise<{ removed: number }> {
    const folder = await this.resolve({ root: 'workspace', path: missionId }, context)
    if (!folder.exists) return { removed: 0 }
    this.permit(
      'files.delete',
      `${folder.path}/* (except ${String(keep.length)} kept file${keep.length === 1 ? '' : 's'})`,
      'Remove this Mission’s intermediate files; kept outputs stay',
      { ...context, missionId }
    )
    const { removed } = await this.options.driver.call(
      'cleanWorkspace',
      { missionId, keep },
      context.signal
    )
    const gone = new Set(removed)
    for (const artifact of all)
      if (
        !artifact.deletedAt &&
        artifact.location.root === 'workspace' &&
        gone.has(artifact.location.path)
      )
        this.markDeleted(artifact, context, 'cleaned')
    return { removed: removed.length }
  }

  // ---- helpers --------------------------------------------------------------------------------

  private resolve(location: FileLocation, context: FileContext): Promise<ResolvedLocation> {
    return this.options.driver.call('resolve', { location }, context.signal)
  }

  private permit(capability: string, target: string, reason: string, context: FileContext): void {
    const outcome = this.options.permissions.check({
      capability,
      subject: FILE_AGENT,
      actor: context.actor,
      target,
      reason,
      missionId: context.missionId ?? null,
      missionTitle: context.missionTitle ?? null,
      stepId: context.stepId ?? null,
      stepTitle: context.stepTitle ?? null,
      askIfNeeded: true
    })
    if (outcome.allowed) return
    throw new JupiterError(outcome.code, outcome.message, {
      category: 'permission',
      userAction: permissionUserAction(outcome.code),
      retryable: outcome.code !== 'PERMISSION_UNKNOWN',
      ...(outcome.requestId ? { details: { requestId: outcome.requestId } } : {})
    })
  }

  /** Runs one operation and records it (done, failed, or refused) as a `file.operation` event. */
  private async operation<T>(
    op: Operation,
    location: FileLocation,
    context: FileContext,
    work: () => Promise<T>
  ): Promise<T> {
    const record = (outcome: 'done' | 'failed' | 'refused', errorCode: string | null) => {
      const database = this.options.database()
      database.transactions.run(() => {
        this.options.bus.publish({
          type: 'file.operation',
          stream: { kind: 'files', id: location.root },
          payload: {
            op,
            root: location.root,
            path: location.path.slice(0, 1000),
            outcome,
            errorCode,
            missionId: context.missionId ?? null
          },
          persistent: true,
          correlationId: context.correlationId,
          actor: { type: context.actor, id: context.actor },
          missionId: context.missionId ?? null,
          executionId: null
        })
      })
    }
    try {
      const result = await work()
      record('done', null)
      return result
    } catch (error) {
      const code = error instanceof JupiterError ? error.code : 'FILE_OPERATION_FAILED'
      const refused = code === 'PATH_REFUSED' || code.startsWith('PERMISSION_')
      if (refused)
        this.options.logger.warn('files.refused', `Refused ${op} on ${location.root}: ${code}`, {
          root: location.root,
          code
        })
      record(refused ? 'refused' : 'failed', code.slice(0, 64))
      throw error
    }
  }

  private markDeleted(
    artifact: Artifact,
    context: FileContext,
    change: 'deleted' | 'cleaned'
  ): void {
    this.saveChange({ ...artifact, deletedAt: this.now() }, change, context)
  }

  private saveChange(
    artifact: Artifact,
    change: EventPayload<'artifact.changed'>['change'],
    context: FileContext
  ): void {
    const database = this.options.database()
    database.transactions.run(() => {
      database.artifacts.save(artifact)
      this.publish(
        artifact.artifactId,
        'artifact.changed',
        {
          artifactId: artifact.artifactId,
          missionId: artifact.missionId,
          change,
          verificationStatus: artifact.verificationStatus
        },
        context,
        artifact.missionId
      )
    })
  }

  private publish<T extends DomainEventType>(
    artifactId: string,
    type: T,
    payload: EventPayload<T>,
    context: FileContext,
    missionId: string | null
  ): void {
    this.options.bus.publish({
      type,
      stream: { kind: 'artifact', id: artifactId },
      payload,
      persistent: true,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor },
      missionId,
      executionId: null
    })
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}
