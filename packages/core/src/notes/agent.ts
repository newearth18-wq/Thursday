import {
  NoteOps,
  type ActorType,
  type Note,
  type NoteCreateInput,
  type NoteEntry,
  type NoteOp,
  type NoteParams,
  type NoteResult,
  type NoteSearchHit,
  type NoteWriteResult,
  type NotesStatus,
  type PermissionSubject,
  type Vault
} from '@jupiter/contracts'
import { JupiterError } from '../errors'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import type { PermissionEngine } from '../permissions/engine'
import type { DatabasePort } from '../ports'
import {
  addLink,
  appendSection,
  buildNote,
  linkTextFor,
  parseNote,
  resolveLink,
  titleOf
} from './markdown'

/**
 * Obsidian notes, the knowledge base (SET 11).
 *
 * The host owns the approved vault and resolves every path inside it; Core
 * decides what may happen and checks `notes.read` / `notes.write` for the
 * exact note at the moment of use. Jupiter creates notes under names that do
 * not exist yet and changes an existing note only by adding lines (a section,
 * a link, a backlink) — after the host has kept a copy of it, and only if
 * it is still exactly as Jupiter read it. Links are never duplicated; a link
 * points only at a note that exists. Note text is untrusted content.
 */

export const NOTES_AGENT: PermissionSubject = { kind: 'agent', id: 'notes', name: 'Notes' }

export interface NoteDriver {
  call<O extends NoteOp>(op: O, params: NoteParams<O>, signal?: AbortSignal): Promise<NoteResult<O>>
}

export function checkedNoteDriver(
  transport: (op: NoteOp, params: unknown, signal?: AbortSignal) => Promise<unknown>
): NoteDriver {
  return {
    async call(op, params, signal) {
      const raw = await transport(op, params, signal)
      const parsed = NoteOps[op].result.safeParse(raw)
      if (!parsed.success)
        throw new JupiterError(
          'NOTES_REPLY_INVALID',
          `The host's reply to ${op} is not valid: ${parsed.error.message}`,
          {
            category: 'internal',
            userAction: null
          }
        )
      return parsed.data as NoteResult<typeof op>
    }
  }
}

export interface NotesContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly missionId?: string | null
  readonly missionTitle?: string | null
  readonly stepId?: string | null
  readonly stepTitle?: string | null
  readonly signal?: AbortSignal
}

export interface NotesAgentOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly driver: NoteDriver
}

type Op =
  | 'connected'
  | 'disconnected'
  | 'structure'
  | 'created'
  | 'appended'
  | 'linked'
  | 'read'
  | 'searched'

const MAX_SEARCHED = 500
const MAX_LISTED = 5_000

export class NotesAgent {
  constructor(private readonly options: NotesAgentOptions) {}

  status(): Promise<NotesStatus> {
    return this.options.driver.call('status', {})
  }

  /** The person approves a vault in the system's folder dialog. */
  async connect(
    kind: 'obsidian-vault' | 'jupiter-brain',
    context: NotesContext
  ): Promise<NotesStatus> {
    this.personOnly(context, 'connect a vault')
    return this.operation('connected', '', context, async () => {
      const status = await this.options.driver.call('connect', { kind }, context.signal)
      return { result: status, vaultId: status.vault?.vaultId ?? null }
    })
  }

  async disconnect(context: NotesContext): Promise<NotesStatus> {
    this.personOnly(context, 'disconnect the vault')
    const before = await this.status()
    return this.operation('disconnected', '', context, async () => ({
      result: await this.options.driver.call('disconnect', {}, context.signal),
      vaultId: before.vault?.vaultId ?? null
    }))
  }

  /** Adds the missing suggested folders; nothing existing is moved or renamed. */
  async structure(context: NotesContext): Promise<{ created: string[]; existing: string[] }> {
    this.personOnly(context, 'add the suggested folders')
    const vault = await this.vault()
    return this.operation('structure', vault.notesFolder, context, async () => {
      this.permit('notes.write', vault.path, `Add the suggested folders to ${vault.path}`, context)
      const result = await this.options.driver.call('structure', {}, context.signal)
      return {
        result: { created: result.created, existing: result.existing },
        vaultId: vault.vaultId
      }
    })
  }

  async list(
    folder: string,
    recursive: boolean,
    limit: number,
    context: NotesContext
  ): Promise<{ entries: NoteEntry[]; total: number }> {
    const vault = await this.vault()
    this.permit('notes.read', vault.path, `See the notes in ${vault.path}`, context)
    const listed = await this.options.driver.call(
      'list',
      { folder, recursive, limit: MAX_LISTED },
      context.signal
    )
    return { entries: listed.entries.slice(0, limit), total: listed.entries.length }
  }

  async search(
    text: string,
    limit: number,
    context: NotesContext
  ): Promise<{ hits: NoteSearchHit[]; scanned: number }> {
    const vault = await this.vault()
    return this.operation('searched', '', context, async () => {
      this.permit('notes.read', vault.path, `Search the notes in ${vault.path}`, context)
      const listed = await this.options.driver.call(
        'list',
        { folder: '', recursive: true, limit: MAX_SEARCHED },
        context.signal
      )
      const terms = text.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean)
      const hits: NoteSearchHit[] = []
      let scanned = 0
      for (const entry of listed.entries) {
        if (context.signal?.aborted) break
        let raw
        try {
          raw = await this.options.driver.call('read', { path: entry.path }, context.signal)
        } catch {
          continue
        }
        scanned++
        const haystack = `${entry.title}\n${raw.text}`.normalize('NFC').toLowerCase()
        const matched = terms.filter((term) => haystack.includes(term)).length
        if (matched === 0) continue
        const first = terms.map((term) => haystack.indexOf(term)).filter((index) => index >= 0)
        const at = Math.max(0, Math.min(...first) - 60)
        const snippet = `${entry.title}\n${raw.text}`
          .normalize('NFC')
          .slice(at, at + 240)
          .replace(/\s+/g, ' ')
        hits.push({ entry, snippet: snippet.slice(0, 500), score: matched / terms.length })
      }
      hits.sort((a, b) => b.score - a.score || b.entry.modifiedAt.localeCompare(a.entry.modifiedAt))
      return { result: { hits: hits.slice(0, limit), scanned }, vaultId: vault.vaultId }
    })
  }

  async read(path: string, context: NotesContext): Promise<Note> {
    const vault = await this.vault()
    return this.operation('read', path, context, async () => {
      this.permit('notes.read', this.full(vault, path), `Read ${this.full(vault, path)}`, context)
      const raw = await this.options.driver.call('read', { path }, context.signal)
      return { result: parseNote(raw), vaultId: vault.vaultId }
    })
  }

  async create(input: NoteCreateInput, context: NotesContext): Promise<NoteWriteResult> {
    const vault = await this.vault()
    const folder = input.folder === '' ? vault.notesFolder : input.folder
    const wanted = folder ? `${folder}/${input.title}.md` : `${input.title}.md`
    return this.operation('created', wanted, context, async () => {
      this.permit(
        'notes.write',
        this.full(vault, wanted),
        `Create the note ${this.full(vault, wanted)}`,
        context
      )
      const all = (
        await this.options.driver.call(
          'list',
          { folder: '', recursive: true, limit: MAX_LISTED },
          context.signal
        )
      ).entries
      // Every link points at a note that exists.
      const targets = input.links.map((link) => {
        const found = resolveLink(link, all)
        if (!found)
          throw new JupiterError(
            'NOTE_LINK_TARGET_MISSING',
            `There is no note called "${link}" to link to.`,
            {
              category: 'validation',
              userAction: 'Check the title, or create that note first.'
            }
          )
        return found
      })
      for (const target of targets)
        this.permit(
          'notes.write',
          this.full(vault, target.path),
          `Add a backlink to ${this.full(vault, target.path)}`,
          context
        )
      if (folder) await this.options.driver.call('mkdir', { folder }, context.signal)
      const text = buildNote({
        title: input.title,
        body: input.body,
        tags: input.tags,
        links: targets.map((target) => linkTextFor(target, all)),
        created: this.options.now().toISOString()
      })
      const created = await this.options.driver.call(
        'create',
        { path: wanted, text },
        context.signal
      )
      const self = linkTextFor(created.entry, [...all, created.entry])
      const backlinks: NoteWriteResult['backlinks'] = []
      for (const target of targets) {
        const raw = await this.options.driver.call('read', { path: target.path }, context.signal)
        const changed = addLink(raw.text, 'Backlinks', self, raw.eol)
        if (changed.added)
          await this.options.driver.call(
            'update',
            {
              path: target.path,
              text: changed.text,
              expectedHash: raw.hash,
              bom: raw.bom,
              eol: raw.eol
            },
            context.signal
          )
        backlinks.push({ path: target.path, added: changed.added })
      }
      return {
        result: {
          entry: created.entry,
          created: true,
          hash: created.hash,
          backupPath: null,
          backlinks
        },
        vaultId: vault.vaultId
      }
    })
  }

  async append(
    path: string,
    heading: string | null,
    text: string,
    context: NotesContext
  ): Promise<NoteWriteResult> {
    const vault = await this.vault()
    return this.operation('appended', path, context, async () => {
      this.permit(
        'notes.write',
        this.full(vault, path),
        `Add to ${this.full(vault, path)}`,
        context
      )
      const raw = await this.options.driver.call('read', { path }, context.signal)
      const updated = await this.options.driver.call(
        'update',
        {
          path,
          text: appendSection(raw.text, heading, text, raw.eol),
          expectedHash: raw.hash,
          bom: raw.bom,
          eol: raw.eol
        },
        context.signal
      )
      return {
        result: {
          entry: updated.entry,
          created: false,
          hash: updated.hash,
          backupPath: updated.backupPath,
          backlinks: []
        },
        vaultId: vault.vaultId
      }
    })
  }

  /** `[[to]]` in `from` (under Links) and `[[from]]` in `to` (under Backlinks), each only once. */
  async link(from: string, to: string, context: NotesContext): Promise<NoteWriteResult> {
    const vault = await this.vault()
    return this.operation('linked', from, context, async () => {
      const all = (
        await this.options.driver.call(
          'list',
          { folder: '', recursive: true, limit: MAX_LISTED },
          context.signal
        )
      ).entries
      const target = resolveLink(to, all)
      if (!target)
        throw new JupiterError(
          'NOTE_LINK_TARGET_MISSING',
          `There is no note called "${to}" to link to.`,
          {
            category: 'validation',
            userAction: 'Check the title, or create that note first.'
          }
        )
      const source = all.find((entry) => entry.path.toLowerCase() === from.toLowerCase())
      if (!source)
        throw new JupiterError('NOTE_NOT_FOUND', `There is no note at ${from}.`, {
          category: 'validation',
          userAction: null
        })
      this.permit(
        'notes.write',
        this.full(vault, source.path),
        `Add a link to ${this.full(vault, source.path)}`,
        context
      )
      this.permit(
        'notes.write',
        this.full(vault, target.path),
        `Add a backlink to ${this.full(vault, target.path)}`,
        context
      )
      const raw = await this.options.driver.call('read', { path: source.path }, context.signal)
      const forward = addLink(raw.text, 'Links', linkTextFor(target, all), raw.eol)
      let entry = source
      let hash = raw.hash
      let backupPath: string | null = null
      if (forward.added) {
        const updated = await this.options.driver.call(
          'update',
          {
            path: source.path,
            text: forward.text,
            expectedHash: raw.hash,
            bom: raw.bom,
            eol: raw.eol
          },
          context.signal
        )
        ;({ entry, hash, backupPath } = updated)
      }
      const other = await this.options.driver.call('read', { path: target.path }, context.signal)
      const back = addLink(other.text, 'Backlinks', linkTextFor(source, all), other.eol)
      if (back.added)
        await this.options.driver.call(
          'update',
          {
            path: target.path,
            text: back.text,
            expectedHash: other.hash,
            bom: other.bom,
            eol: other.eol
          },
          context.signal
        )
      return {
        result: {
          entry,
          created: false,
          hash,
          backupPath,
          backlinks: [{ path: target.path, added: back.added }]
        },
        vaultId: vault.vaultId
      }
    })
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async vault(): Promise<Vault> {
    const status = await this.status()
    if (!status.vault)
      throw new JupiterError(
        'VAULT_NOT_CONNECTED',
        status.reason ?? 'No Obsidian vault is connected.',
        {
          category: 'configuration',
          userAction: 'Connect a vault in Memory › Obsidian.'
        }
      )
    return status.vault
  }

  private full(vault: Vault, path: string): string {
    return path ? `${vault.path}/${path}` : vault.path
  }

  private personOnly(context: NotesContext, what: string): void {
    if (context.actor !== 'user-interface')
      throw new JupiterError('PERMISSION_DENIED', `Only you can ${what}.`, {
        category: 'permission',
        userAction: null
      })
  }

  private permit(capability: string, target: string, reason: string, context: NotesContext): void {
    const outcome = this.options.permissions.check({
      capability,
      subject: NOTES_AGENT,
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
      userAction:
        outcome.code === 'PERMISSION_REQUIRED'
          ? 'Answer the permission request, then try again.'
          : null,
      retryable: outcome.code === 'PERMISSION_REQUIRED',
      ...(outcome.requestId ? { details: { requestId: outcome.requestId } } : {})
    })
  }

  /** Runs one operation and records it as a `notes.changed` event (done, failed or refused). */
  private async operation<T>(
    op: Op,
    path: string,
    context: NotesContext,
    work: () => Promise<{ result: T; vaultId: string | null }>
  ): Promise<T> {
    const record = (
      vaultId: string | null,
      outcome: 'done' | 'failed' | 'refused',
      errorCode: string | null
    ) => {
      const database = this.options.database()
      database.transactions.run(() => {
        this.options.bus.publish({
          type: 'notes.changed',
          stream: { kind: 'notes', id: vaultId ?? 'none' },
          payload: {
            vaultId,
            op,
            path: path.slice(0, 1000),
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
      const { result, vaultId } = await work()
      record(vaultId, 'done', null)
      return result
    } catch (error) {
      const code = error instanceof JupiterError ? error.code : 'NOTES_OPERATION_FAILED'
      const refused = code === 'PATH_REFUSED' || code.startsWith('PERMISSION_')
      if (refused) this.options.logger.warn('notes.refused', `Refused ${op}: ${code}`, { code })
      record(null, refused ? 'refused' : 'failed', code.slice(0, 64))
      throw error
    }
  }
}

export { titleOf }
