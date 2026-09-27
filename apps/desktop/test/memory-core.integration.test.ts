import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryCandidateInput, MemoryQuery, PlanDraft } from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, removeDir } from '@jupiter/testing'
import { checkMarkdown } from '@jupiter/testing/documents'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import {
  nonLoopbackAddress,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotesHost } from '../src/main/notes-host'
import {
  call,
  failure,
  server,
  settled,
  standard,
  startCore,
  stopCore,
  useCoreHarness,
  withModel,
  type Running
} from './core-harness'
import { envelope } from './helpers'

/**
 * SET 11 with the real Core, SQLite database and Obsidian notes host: the
 * Memory Policy, long-term and session memory, search (including semantic
 * search under the privacy mode, against real model servers), sealing of
 * sensitive memories, and an Obsidian vault on disk — AT1–AT10.
 */

useCoreHarness('jupiter-memory-core')

let vaults: string
let cloud: ProtocolServer

beforeAll(async () => {
  vaults = await createTempDir('jupiter-vaults')
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('These tests need a non-loopback network interface for the "cloud" server')
  cloud = await startOpenAiCompatibleServer({ host: address })
})

afterAll(async () => {
  await cloud.close()
  await removeDir(vaults)
})

beforeEach(() => {
  cloud.reset()
})

const user = { kind: 'user' as const, label: 'You', ref: null }

function candidate(
  content: string,
  extra: Partial<MemoryCandidateInput> = {}
): MemoryCandidateInput {
  return { content, type: 'facts', source: user, explicit: true, ...extra }
}

function query(extra: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    mode: 'keyword',
    text: '',
    types: [],
    tags: [],
    sensitivity: null,
    relatedTo: null,
    includeForgotten: false,
    minConfidence: 0,
    limit: 50,
    ...extra
  }
}

/** Everything Jupiter keeps on disk for this profile: the database, its WAL and the logs in memory. */
function persisted(running: Running): string {
  const files = readdirSync(running.dir).filter((name) => name.startsWith('jupiter.db'))
  return files.map((name) => readFileSync(join(running.dir, name)).toString('latin1')).join('\n')
}

function inLogs(running: Running, text: string): boolean {
  return JSON.stringify(running.logs.entries).includes(text)
}

function inEvents(running: Running, text: string): boolean {
  return JSON.stringify(running.events).includes(text)
}

async function answerAll(running: Running, decision: 'ALLOW_ONCE' | 'ALWAYS_ALLOW' = 'ALLOW_ONCE') {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes(decision) ? decision : 'ALLOW_ONCE'
    })
  return requests
}

/** Runs a capability; each time it waits for a permission, answers it (Allow once) and runs it again. */
async function granted<T>(running: Running, run: () => Promise<T>): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await run()
    } catch (error) {
      if (!String(error).includes('PERMISSION_REQUIRED') || round >= 10) throw error
      await answerAll(running)
    }
  }
}

/** A refusal that is not a permission question: answers permission requests on the way. */
async function refusedAfterAsking(running: Running, run: () => ReturnType<typeof failure>) {
  for (let round = 0; round < 10; round++) {
    const refused = await run()
    if (refused.code !== 'PERMISSION_REQUIRED') return refused
    await answerAll(running)
  }
  throw new Error('Still asking for permissions after 10 answers')
}

describe('SET 11 — the Memory System', () => {
  it('AT1: saves an allowed memory, with its source, confidence and a SAVE decision', async () => {
    const running = await startCore(standard())
    const saved = await call(
      running,
      'memory.propose',
      candidate('I prefer green tea in the morning.', {
        type: 'preferences',
        tags: ['drinks'],
        confidence: 0.95,
        importance: 0.7
      })
    )
    expect(saved.decision).toBe('SAVE')
    expect(saved.reasons.map((reason) => reason.code)).toEqual(['explicit-request'])
    expect(saved.memory).toMatchObject({
      type: 'preferences',
      content: 'I prefer green tea in the morning.',
      source: user,
      confidence: 0.95,
      importance: 0.7,
      tags: ['drinks'],
      sensitivity: 'normal',
      layer: 'long-term',
      state: 'active'
    })
    const found = await call(running, 'memory.search', query({ text: 'green tea' }))
    expect(found.hits.map((hit) => hit.memory.memoryId)).toEqual([saved.memory?.memoryId])
    expect(found.hits[0]?.score).toBe(1)
    // The decision is recorded — without the content.
    const { decisions } = await call(running, 'memory.decisions', { limit: 10 })
    expect(decisions[0]).toMatchObject({
      decision: 'SAVE',
      decidedBy: 'policy',
      memoryId: saved.memory?.memoryId
    })
    expect(JSON.stringify(decisions)).not.toContain('green tea')
    // No permission was asked: the Memory System's visible default grants cover its own store.
    const grants = await call(running, 'permissions.grants', { includeEnded: false, limit: 100 })
    expect(
      grants.grants
        .filter((grant) => grant.subject.id === 'memory')
        .map((grant) => [grant.capability, grant.target, grant.createdBy])
        .sort()
    ).toEqual([
      ['memory.read', 'jupiter:memory', 'core'],
      ['memory.write', 'jupiter:memory', 'core']
    ])
  })

  it('AT2: a long-term memory is there after a restart; a session memory is not', async () => {
    const first = await startCore(standard())
    const kept = await call(
      first,
      'memory.propose',
      candidate('Our project deadline is 15 October.', { type: 'tasks' })
    )
    const session = await call(
      first,
      'memory.propose',
      candidate('Today I am working from the library.', { retention: { kind: 'session' } })
    )
    expect(session.memory?.layer).toBe('session')
    expect((await call(first, 'memory.status', {})).session).toBe(1)
    await stopCore(first)

    const second = await startCore(standard())
    const all = await call(second, 'memory.search', query({ mode: 'metadata' }))
    expect(all.hits.map((hit) => hit.memory)).toEqual([kept.memory])
    await expect(
      call(second, 'memory.get', { memoryId: session.memory?.memoryId, reveal: false })
    ).rejects.toThrow('MEMORY_NOT_FOUND')
  })

  it('AT3: DO_NOT_SAVE is respected — credentials, duplicates, trivia and ordinary chat turns are not remembered', async () => {
    const running = await startCore(standard())
    await withModel(running)
    const key = fakeCredentials().find((item) => item.patternId === 'openai-api-key')?.value ?? ''
    for (const content of [
      `Remember my API key: ${key}`,
      'My email password is Jupiter-rocks-42',
      'รหัสผ่านอีเมลของฉันคือ saturn-ring-99'
    ]) {
      const result = await call(running, 'memory.propose', candidate(content))
      expect(result, content).toMatchObject({
        decision: 'DO_NOT_SAVE',
        memory: null,
        candidate: null
      })
      expect(result.reasons[0]?.code).toBe('credential')
    }
    await call(running, 'memory.propose', candidate('The telescope is in the garage.'))
    const duplicate = await call(
      running,
      'memory.propose',
      candidate('the telescope is in the garage')
    )
    expect(duplicate).toMatchObject({ decision: 'DO_NOT_SAVE', reasons: [{ code: 'duplicate' }] })
    expect(duplicate.duplicateOf).not.toBeNull()
    // Not asked for, and not worth remembering.
    expect(
      (await call(running, 'memory.propose', candidate('ok thanks', { explicit: false })))
        .reasons[0]?.code
    ).toBe('too-short')
    expect(
      (
        await call(
          running,
          'memory.propose',
          candidate('The weather looked a little cloudy this afternoon.', {
            explicit: false,
            importance: 0.1
          })
        )
      ).reasons[0]?.code
    ).toBe('low-importance')

    // A chat turn that does not ask Jupiter to remember is never a candidate.
    const before = (await call(running, 'memory.decisions', { limit: 100 })).decisions.length
    await call(running, 'chat.send', { conversationId: null, text: 'What is the largest planet?' })
    expect((await call(running, 'memory.decisions', { limit: 100 })).decisions).toHaveLength(before)
    // One that asks is: the policy decides.
    await call(running, 'chat.send', {
      conversationId: null,
      text: 'Remember that my favourite planet is Jupiter.'
    })
    const found = await call(running, 'memory.search', query({ text: 'favourite planet' }))
    expect(found.hits[0]?.memory).toMatchObject({
      content: 'my favourite planet is Jupiter.',
      source: { kind: 'chat', label: 'Chat' }
    })

    const all = await call(
      running,
      'memory.search',
      query({ mode: 'metadata', includeForgotten: true })
    )
    expect(all.hits.map((hit) => hit.memory.content).sort()).toEqual([
      'The telescope is in the garage.',
      'my favourite planet is Jupiter.'
    ])
    // Nothing that was refused is anywhere on disk, in the logs or in events.
    for (const secret of [key, 'Jupiter-rocks-42', 'saturn-ring-99']) {
      expect(persisted(running).includes(secret), secret).toBe(false)
      expect(inLogs(running, secret), secret).toBe(false)
      expect(inEvents(running, secret), secret).toBe(false)
    }
  })

  it('AT4: ASK_USER waits for the person — nothing is saved until they decide', async () => {
    const running = await startCore(standard())
    const asked = await call(
      running,
      'memory.propose',
      candidate('I take insulin every morning for my diabetes.', { type: 'routines' })
    )
    expect(asked.decision).toBe('ASK_USER')
    expect(asked.reasons.map((reason) => reason.code)).toEqual(['health'])
    expect(asked.candidate).toMatchObject({ sensitivity: 'sensitive', sensitiveKinds: ['health'] })
    const unsure = await call(
      running,
      'memory.propose',
      candidate('Maybe the meeting with the robotics club moved to Thursday.', {
        explicit: false,
        confidence: 0.4
      })
    )
    expect(unsure).toMatchObject({ decision: 'ASK_USER', reasons: [{ code: 'low-confidence' }] })

    // Waiting: listed as candidates, not saved, not searchable.
    expect(
      (await call(running, 'memory.candidates', {})).candidates
        .map((item) => item.candidateId)
        .sort()
    ).toEqual([asked.candidate?.candidateId, unsure.candidate?.candidateId].sort())
    expect((await call(running, 'memory.search', query({ mode: 'metadata' }))).hits).toEqual([])
    expect(persisted(running).includes('insulin')).toBe(false)

    // The person declines one and keeps the other.
    const declined = await call(running, 'memory.decide', {
      candidateId: unsure.candidate?.candidateId,
      decision: 'DO_NOT_SAVE'
    })
    expect(declined).toMatchObject({
      decision: 'DO_NOT_SAVE',
      reasons: [{ code: 'person-declined' }]
    })
    const kept = await call(running, 'memory.decide', {
      candidateId: asked.candidate?.candidateId,
      decision: 'SAVE'
    })
    expect(kept).toMatchObject({
      decision: 'SAVE',
      reasons: [{ code: 'person-saved' }],
      memory: { sensitivity: 'sensitive', content: null, contentHidden: true }
    })
    expect((await call(running, 'memory.candidates', {})).candidates).toEqual([])
    // Revealed only when the person asks, from the sealed form.
    const revealed = await call(running, 'memory.get', {
      memoryId: kept.memory?.memoryId,
      reveal: true
    })
    expect(revealed.content).toBe('I take insulin every morning for my diabetes.')
    const { decisions } = await call(running, 'memory.decisions', { limit: 10 })
    expect(decisions.map((item) => [item.decision, item.decidedBy])).toEqual([
      ['SAVE', 'person'],
      ['DO_NOT_SAVE', 'person'],
      ['ASK_USER', 'policy'],
      ['ASK_USER', 'policy']
    ])
    // Only the person may answer.
    const again = await call(running, 'memory.propose', candidate('My blood type is O negative.'))
    const denied = await running.core.dispatch(
      {
        ...envelope('memory.decide', {
          candidateId: again.candidate?.candidateId,
          decision: 'SAVE'
        })
      },
      { type: 'automation', id: 'automation:1' }
    )
    expect(denied.ok).toBe(false)
  })

  it('AT5: the person corrects, forgets, restores and deletes a memory (delete asks for its permission)', async () => {
    const running = await startCore(standard())
    const saved = await call(
      running,
      'memory.propose',
      candidate('My sister lives in Chiang Mai.', { type: 'people' })
    )
    const id = saved.memory?.memoryId ?? ''
    const corrected = await call(running, 'memory.update', {
      memoryId: id,
      content: 'My sister lives in Chiang Rai.',
      tags: ['family']
    })
    expect(corrected).toMatchObject({
      content: 'My sister lives in Chiang Rai.',
      tags: ['family'],
      corrections: 1
    })
    expect((await call(running, 'memory.search', query({ text: 'Mai' }))).hits).toEqual([])
    expect((await call(running, 'memory.search', query({ text: 'Chiang Rai' }))).hits).toHaveLength(
      1
    )
    // A correction cannot smuggle a secret in.
    expect(
      (
        await failure(running, 'memory.update', {
          memoryId: id,
          content: 'Her wifi password is hunter2hunter2'
        })
      ).code
    ).toBe('MEMORY_REFUSED')

    await call(running, 'memory.forget', { memoryId: id, forgotten: true })
    expect((await call(running, 'memory.search', query({ text: 'Chiang Rai' }))).hits).toEqual([])
    expect(
      (await call(running, 'memory.search', query({ text: 'Chiang Rai', includeForgotten: true })))
        .hits[0]?.memory.state
    ).toBe('forgotten')
    await call(running, 'memory.forget', { memoryId: id, forgotten: false })

    const asked = await failure(running, 'memory.delete', { memoryId: id })
    expect(asked.code).toBe('PERMISSION_REQUIRED')
    const [request] = await answerAll(running)
    expect(request).toMatchObject({
      capability: 'memory.delete',
      target: `memory:${id}`,
      risk: 'HIGH'
    })
    expect(await call(running, 'memory.delete', { memoryId: id })).toEqual({ deleted: true })
    expect((await failure(running, 'memory.get', { memoryId: id, reveal: false })).code).toBe(
      'MEMORY_NOT_FOUND'
    )
    expect(persisted(running).includes('Chiang Rai')).toBe(false)
    expect(
      running.events.some(
        (event) => event.type === 'memory.changed' && event.payload.change === 'deleted'
      )
    ).toBe(true)
  })

  it('searches by metadata, keyword and relationship, and exports without sensitive content', async () => {
    const running = await startCore(standard())
    const project = await call(
      running,
      'memory.propose',
      candidate('Project Aurora builds a weather balloon.', { type: 'projects', tags: ['aurora'] })
    )
    const person = await call(
      running,
      'memory.propose',
      candidate('Nok leads the Aurora electronics team.', {
        type: 'people',
        relationships: [{ kind: 'part-of', memoryId: project.memory?.memoryId ?? '' }]
      })
    )
    await call(running, 'memory.propose', candidate('ดาวพฤหัสบดีเป็นดาวเคราะห์ที่ใหญ่ที่สุด'))
    expect(
      (
        await call(running, 'memory.search', query({ mode: 'metadata', types: ['people'] }))
      ).hits.map((hit) => hit.memory.memoryId)
    ).toEqual([person.memory?.memoryId])
    expect((await call(running, 'memory.search', query({ text: 'aurora' }))).total).toBe(2)
    // Thai has no spaces between words: part of a word still matches.
    expect((await call(running, 'memory.search', query({ text: 'ดาวพฤหัส' }))).total).toBe(1)
    const related = await call(
      running,
      'memory.search',
      query({ mode: 'relationship', relatedTo: project.memory?.memoryId ?? null })
    )
    expect(related.hits.map((hit) => [hit.memory.memoryId, hit.relation])).toEqual([
      [person.memory?.memoryId, 'part-of']
    ])
  })
})

describe('SET 11 — Obsidian notes', () => {
  let vault: string
  let host: NotesHost
  let chosen: string | null

  const notes = () => (input: unknown) => host.call(input)

  beforeEach(async () => {
    vault = await createTempDir('jupiter-vault')
    mkdirSync(join(vault, '.obsidian'))
    mkdirSync(join(vault, 'Space'))
    // An existing note with CRLF line endings, a byte order mark and its own frontmatter.
    writeFileSync(
      join(vault, 'Space', 'Jupiter.md'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          '---\r\naliases: [Jove]\r\nrating: 5\r\n---\r\n\r\n# Jupiter\r\n\r\nThe largest planet. #planet\r\n\r\n## Backlinks\r\n\r\n- [[Saturn]]\r\n\r\n## Moons\r\n\r\nIo, Europa.\r\n',
          'utf8'
        )
      ])
    )
    writeFileSync(join(vault, 'Saturn.md'), '# Saturn\n\nRings.\n')
    chosen = vault
    host = new NotesHost({
      logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] }),
      stateFile: join(vaults, `${uuidv7()}-notes-vault.json`),
      backupDirectory: join(vaults, 'backups'),
      chooseFolder: () => Promise.resolve(chosen)
    })
  })

  it('AT6: connects only the vault the person chose; anything else is refused and nothing changes', async () => {
    const running = await startCore(standard(), undefined, [], {}, null, null, null, {
      notes: notes()
    })
    expect(await call(running, 'notes.status', {})).toMatchObject({ vault: null })
    const plain = await createTempDir('jupiter-not-a-vault')
    chosen = plain
    expect((await failure(running, 'notes.connect', { kind: 'obsidian-vault' })).code).toBe(
      'NOT_A_VAULT'
    )
    chosen = null
    expect((await failure(running, 'notes.connect', { kind: 'obsidian-vault' })).code).toBe(
      'VAULT_NOT_CHOSEN'
    )
    chosen = vault
    const connected = await call(running, 'notes.connect', { kind: 'obsidian-vault' })
    expect(connected.vault).toMatchObject({
      kind: 'obsidian-vault',
      notesFolder: '',
      name: expect.any(String) as unknown
    })
    // Only the person connects a vault.
    const automation = await running.core.dispatch(
      envelope('notes.connect', { kind: 'obsidian-vault' }),
      { type: 'automation', id: 'automation:1' }
    )
    expect(automation.ok).toBe(false)
    // Paths are resolved inside the vault only.
    for (const path of ['../outside.md', '/etc/passwd.md', '.obsidian/app.md'])
      expect((await failure(running, 'notes.read', { path, missionId: null })).code, path).toMatch(
        /INVALID_PAYLOAD|PATH_REFUSED/
      )
    // Jupiter Brain inside an existing vault: its own folder and the suggested structure, nothing else touched.
    const brain = await call(running, 'notes.connect', { kind: 'jupiter-brain' })
    expect(brain.vault).toMatchObject({ kind: 'jupiter-brain', notesFolder: 'Jupiter Brain' })
    const structure = await granted(running, () => call(running, 'notes.structure', {}))
    expect(structure.created).toHaveLength(9)
    expect(readdirSync(join(vault, 'Jupiter Brain')).sort()).toEqual(
      [
        'Archive',
        'Daily',
        'Ideas',
        'Meetings',
        'People',
        'Projects',
        'Reference',
        'School',
        'Tasks'
      ].sort()
    )
    expect((await granted(running, () => call(running, 'notes.structure', {}))).created).toEqual([])
    expect(readdirSync(vault).sort()).toEqual(
      ['.obsidian', 'Jupiter Brain', 'Saturn.md', 'Space'].sort()
    )
    await removeDir(plain)
  })

  it('AT7 + AT8: creates a valid note with valid backlinks; existing notes stay intact (a copy is kept first)', async () => {
    const running = await startCore(standard(), undefined, [], {}, null, null, null, {
      notes: notes()
    })
    await call(running, 'notes.connect', { kind: 'obsidian-vault' })
    const original = readFileSync(join(vault, 'Space', 'Jupiter.md'))
    const input = {
      folder: 'Space',
      title: 'Great Red Spot',
      body: 'A storm larger than Earth.\n\n- Seen since 1830',
      tags: ['storm', 'planet/jupiter'],
      links: ['Jupiter', 'Saturn'],
      missionId: null
    }
    const first = await failure(running, 'notes.create', input)
    expect(first.code).toBe('PERMISSION_REQUIRED')
    const asked = await answerAll(running, 'ALWAYS_ALLOW')
    expect(asked.map((request) => [request.capability, request.target])).toEqual([
      ['notes.write', `${vault}/Space/Great Red Spot.md`]
    ])
    const created = await granted(running, () => call(running, 'notes.create', input))
    expect(created.entry.path).toBe('Space/Great Red Spot.md')
    expect(created.backlinks).toEqual([
      { path: 'Space/Jupiter.md', added: true },
      { path: 'Saturn.md', added: true }
    ])

    // Valid Markdown with valid YAML frontmatter, read by an independent parser.
    const note = checkMarkdown(join(vault, 'Space', 'Great Red Spot.md'))
    expect(note.frontmatter).toMatchObject({
      title: 'Great Red Spot',
      source: 'Jupiter',
      tags: ['jupiter', 'storm', 'planet/jupiter']
    })
    expect(note.links).toEqual(['Jupiter', 'Saturn'])
    // Every link points at a note that exists.
    const titles = ['Jupiter', 'Saturn', 'Great Red Spot']
    for (const link of note.links) expect(titles).toContain(link)
    // Backlinks: added once, where missing; never duplicated.
    const saturn = checkMarkdown(join(vault, 'Saturn.md'))
    expect(saturn.links).toEqual(['Great Red Spot'])
    expect(readFileSync(join(vault, 'Saturn.md'), 'utf8').startsWith('# Saturn\n\nRings.\n')).toBe(
      true
    )

    // AT8: Jupiter.md needed a backlink under its existing "## Backlinks" section.
    const jupiter = readFileSync(join(vault, 'Space', 'Jupiter.md'))
    const parsed = checkMarkdown(join(vault, 'Space', 'Jupiter.md'))
    expect(parsed.bom).toBe(true)
    expect(parsed.crlf).toBe(true)
    expect(parsed.frontmatter).toEqual({ aliases: ['Jove'], rating: 5 })
    expect(parsed.links).toEqual(['Saturn', 'Great Red Spot'])
    // Every original line is still there, in order; only the backlink line was added.
    const lines = (bytes: Buffer) => bytes.toString('utf8').split('\r\n')
    expect(lines(jupiter).filter((line) => line !== '- [[Great Red Spot]]')).toEqual(
      lines(original)
    )
    // A copy of the note as it was, outside the vault.
    const backups = readdirSync(join(vaults, 'backups'), { recursive: true }).map(String)
    const copy = backups.find((path) => path.endsWith('Jupiter.md'))
    expect(copy).toBeDefined()
    expect(readFileSync(join(vaults, 'backups', copy ?? '')).equals(original)).toBe(true)

    // Appending keeps every byte that was there.
    const before = readFileSync(join(vault, 'Saturn.md'))
    const appended = await granted(running, () =>
      call(running, 'notes.append', {
        path: 'Saturn.md',
        heading: 'Missions',
        text: 'Cassini, 2004–2017.',
        missionId: null
      })
    )
    const after = readFileSync(join(vault, 'Saturn.md'))
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    expect(after.toString('utf8').slice(before.length)).toBe(
      '\n## Missions\n\nCassini, 2004–2017.\n'
    )
    expect(appended.backupPath).not.toBeNull()
    // Linking again changes nothing (no duplicate), and a second note with the same title gets a free name.
    await granted(running, () =>
      call(running, 'notes.link', {
        from: 'Space/Great Red Spot.md',
        to: 'Saturn',
        missionId: null
      })
    )
    expect(checkMarkdown(join(vault, 'Saturn.md')).links).toEqual(['Great Red Spot'])
    const second = await granted(running, () =>
      call(running, 'notes.create', { ...input, links: [] })
    )
    expect(second.entry.path).toBe('Space/Great Red Spot (2).md')
    expect(readFileSync(join(vault, 'Space', 'Great Red Spot.md'), 'utf8')).toContain(
      'A storm larger than Earth.'
    )
    // A link to a note that does not exist is refused; nothing is written.
    expect(
      (
        await refusedAfterAsking(running, () =>
          failure(running, 'notes.create', { ...input, title: 'Uranus', links: ['Pluto'] })
        )
      ).code
    ).toBe('NOTE_LINK_TARGET_MISSING')
    expect(existsSync(join(vault, 'Space', 'Uranus.md'))).toBe(false)
  })

  it('refuses to overwrite a note that changed since Jupiter read it', async () => {
    const running = await startCore(standard(), undefined, [], {}, null, null, null, {
      notes: notes()
    })
    await call(running, 'notes.connect', { kind: 'obsidian-vault' })
    const raw = (await host.call({ op: 'read', params: { path: 'Saturn.md' } })) as { hash: string }
    writeFileSync(join(vault, 'Saturn.md'), '# Saturn\n\nChanged by the person in Obsidian.\n')
    await expect(
      host.call({
        op: 'update',
        params: {
          path: 'Saturn.md',
          text: 'replaced',
          expectedHash: raw.hash,
          bom: false,
          eol: '\n'
        }
      })
    ).rejects.toThrow(/changed since Jupiter read it/)
    expect(readFileSync(join(vault, 'Saturn.md'), 'utf8')).toBe(
      '# Saturn\n\nChanged by the person in Obsidian.\n'
    )
  })

  it('Mission steps: recall memories and read and create notes, fenced as data', async () => {
    const running = await startCore(standard(), undefined, [], {}, null, null, null, {
      notes: notes()
    })
    await withModel(running)
    await call(running, 'notes.connect', { kind: 'obsidian-vault' })
    await call(
      running,
      'memory.propose',
      candidate('I prefer short summaries with bullet points.', { type: 'preferences' })
    )
    const kept = await call(
      running,
      'memory.propose',
      candidate('My bank account number is 123-456-789.')
    )
    await call(running, 'memory.decide', {
      candidateId: kept.candidate?.candidateId,
      decision: 'SAVE'
    })
    const plan: PlanDraft = {
      goal: 'Summarise my Saturn note the way I like',
      assumptions: [],
      rationale: 'Recall preferences, read the note, summarise, save a note.',
      steps: [
        {
          id: 'prefs',
          title: 'Recall my preferences',
          description: 'Memory',
          skillId: 'memory.recall',
          dependencies: [],
          input: { query: 'summaries bank' },
          condition: null,
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'note',
          title: 'Read the Saturn note',
          description: 'Notes',
          skillId: 'notes.read',
          dependencies: [],
          input: { path: 'Saturn.md' },
          condition: null,
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'sum',
          title: 'Summarise',
          description: 'Model',
          skillId: 'model.generate',
          dependencies: ['prefs', 'note'],
          input: { prompt: '{{prefs}}\n{{note}}' },
          condition: null,
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'save',
          title: 'Save the summary',
          description: 'Notes',
          skillId: 'notes.create',
          dependencies: ['sum'],
          input: { title: 'Saturn summary', content: '{{sum}}', links: 'Saturn', tags: 'summary' },
          condition: null,
          timeoutMs: 30_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        }
      ],
      requiredSkills: ['memory.recall', 'notes.read', 'model.generate', 'notes.create'],
      requiredPermissions: ['memory.read', 'notes.read', 'notes.write'],
      expectedArtifacts: [],
      verificationPlan: { checks: [{ step: 'sum', check: 'non-empty', description: 'Summarised' }] }
    }
    server.enqueue({ chunks: [JSON.stringify(plan)] })
    server.enqueue({ chunks: ['- Saturn has rings.'] })
    const missionId = (
      await call(running, 'missions.create', {
        request: 'Summarise my Saturn note',
        planner: 'model'
      })
    ).mission.missionId
    for (let round = 0; round < 6; round++) {
      await expect
        .poll(async () => (await call(running, 'missions.get', { missionId })).mission.status)
        .toMatch(/WAITING_APPROVAL|COMPLETED|FAILED/)
      if (
        (await call(running, 'missions.get', { missionId })).mission.status !== 'WAITING_APPROVAL'
      )
        break
      await answerAll(running)
    }
    await settled(running, missionId, 'COMPLETED')
    const prompt = JSON.stringify(
      server.requests.filter((request) => request.method === 'POST').at(-1)?.body
    )
    expect(prompt).toContain('BEGIN MEMORY')
    expect(prompt).toContain('I prefer short summaries with bullet points.')
    expect(prompt).toContain('BEGIN UNTRUSTED NOTE TEXT')
    // Sensitive memories are never recalled into a model request.
    expect(prompt).not.toContain('123-456-789')
    expect(checkMarkdown(join(vault, 'Saturn summary.md')).links).toEqual(['Saturn'])
  })
})

describe('SET 11 — privacy', () => {
  async function embeddingProvider(running: Running, target: ProtocolServer, name: string) {
    const provider = await call(running, 'ai.providers.add', {
      adapterId: 'openai-compatible',
      displayName: name,
      baseUrl: target.baseUrl
    })
    target.setModels([{ id: 'embed-model' }])
    await call(running, 'ai.providers.check', { providerId: provider.providerId })
    await call(running, 'ai.models.update', {
      providerId: provider.providerId,
      modelId: 'embed-model',
      enabled: true,
      capabilities: ['embeddings']
    })
    return provider
  }

  it('AT9: with LOCAL_ONLY, semantic search makes no cloud call; with a local model it runs on this computer', async () => {
    const running = await startCore(standard())
    cloud.embedByWords(true)
    server.embedByWords(true)
    await call(
      running,
      'memory.propose',
      candidate('I like hiking in the mountains on weekends.', { type: 'preferences' })
    )
    await call(
      running,
      'memory.propose',
      candidate('The quarterly budget review is on Monday.', { type: 'tasks' })
    )
    // Sensitive: waits for the person, so it is never embedded.
    await call(
      running,
      'memory.propose',
      candidate('I was diagnosed with a heart condition last year.')
    )
    await embeddingProvider(running, cloud, 'Cloud embeddings')
    await call(running, 'settings.update', { key: 'memory.semanticSearch', value: true })
    await call(running, 'settings.update', { key: 'ai.routingMode', value: 'LOCAL_ONLY' })
    cloud.reset()
    cloud.embedByWords(true)

    const blocked = await call(
      running,
      'memory.search',
      query({ mode: 'semantic', text: 'mountains hiking' })
    )
    expect(blocked.semantic).toMatchObject({ requested: true, used: false, locality: null })
    expect(blocked.semantic.reason).toMatch(/Keyword search was used/)
    expect(blocked.hits[0]?.memory.content).toBe('I like hiking in the mountains on weekends.')
    expect(cloud.connections()).toBe(0)
    expect((await call(running, 'memory.status', {})).semantic).toMatchObject({
      enabled: true,
      available: false
    })

    await embeddingProvider(running, server, 'Local embeddings')
    cloud.reset()
    const local = await call(
      running,
      'memory.search',
      query({ mode: 'semantic', text: 'hiking weekends' })
    )
    expect(local.semantic).toMatchObject({
      used: true,
      locality: 'this-device',
      providerName: 'Local embeddings'
    })
    expect(local.hits[0]).toMatchObject({
      matched: 'semantic',
      memory: { content: 'I like hiking in the mountains on weekends.' }
    })
    expect(cloud.connections()).toBe(0)
    const embedded = server.requests.filter((request) => request.path === '/v1/embeddings')
    expect(embedded.length).toBeGreaterThan(0)
    // Sensitive memories never go to any model (the health one was not saved without asking, either).
    expect(JSON.stringify(embedded.map((request) => request.body))).not.toContain('heart condition')
  })

  it('AT10: sensitive memory is never silently persisted or logged; without secure storage it is not kept at all', async () => {
    const card = '4111 1111 1111 1111'
    const running = await startCore(standard())
    const asked = await call(
      running,
      'memory.propose',
      candidate(`My credit card number is ${card}.`)
    )
    expect(asked).toMatchObject({
      decision: 'ASK_USER',
      candidate: { sensitiveKinds: ['financial'] }
    })
    // Waiting: in no file, log or event.
    expect(persisted(running).includes('4111')).toBe(false)
    expect(inLogs(running, '4111')).toBe(false)
    expect(inEvents(running, '4111')).toBe(false)
    const saved = await call(running, 'memory.decide', {
      candidateId: asked.candidate?.candidateId,
      decision: 'SAVE'
    })
    expect(saved.memory).toMatchObject({ sensitivity: 'sensitive', content: null })
    // Kept, sealed: still in no file, log or event in readable form.
    expect(persisted(running).includes('4111')).toBe(false)
    expect(inLogs(running, '4111')).toBe(false)
    expect(inEvents(running, '4111')).toBe(false)
    // Not in a search result, nor in an export.
    const found = await call(running, 'memory.search', query({ mode: 'metadata' }))
    expect(JSON.stringify(found)).not.toContain('4111')
    await stopCore(running)

    // A computer without OS-backed secure storage: the person's "keep it" cannot be honoured, and says so.
    const bare = await startCore(standard(), undefined, [], {}, null, null, null, {
      secureStorage: false
    })
    expect((await call(bare, 'memory.status', {})).secureStorage.available).toBe(false)
    const pending = await call(
      bare,
      'memory.propose',
      candidate('My passport number is AB1234567.')
    )
    expect(pending.decision).toBe('ASK_USER')
    const refused = await failure(bare, 'memory.decide', {
      candidateId: pending.candidate?.candidateId,
      decision: 'SAVE'
    })
    expect(refused.code).toBe('SECURE_STORAGE_UNAVAILABLE')
    // Still waiting for another answer; nothing stored.
    expect((await call(bare, 'memory.candidates', {})).candidates).toHaveLength(1)
    expect(persisted(bare).includes('AB1234567')).toBe(false)
    expect(inLogs(bare, 'AB1234567')).toBe(false)
  })
})
