import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Artifact, PlanDraft } from '@jupiter/contracts'
import { bundleDocumentRuntime } from '@jupiter/document-runtime/build'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, removeDir } from '@jupiter/testing'
import { checkOffice, documentFixture } from '@jupiter/testing/documents'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileHost } from '../src/main/file-host'
import {
  call,
  failure,
  server,
  settled,
  standard,
  startCore,
  useCoreHarness,
  withModel,
  type Running
} from './core-harness'

/**
 * SET 10 with the real Core, the real file host and the real document
 * runtime (bundled as the app ships it) on a controlled set of approved
 * folders: the File Agent, documents, the Artifact Manager and their
 * permissions, AT1–AT10.
 */

useCoreHarness('jupiter-files-core')

let folder: string
let host: FileHost
let outside: string
const trashed: string[] = []

const roots = () => ({
  downloads: join(folder, 'downloads'),
  documents: join(folder, 'documents'),
  desktop: join(folder, 'desktop'),
  workspace: join(folder, 'workspace')
})

beforeAll(async () => {
  folder = await createTempDir('jupiter-files')
  outside = await createTempDir('jupiter-outside')
  for (const path of Object.values(roots())) mkdirSync(path, { recursive: true })
  const downloads = roots().downloads
  // AT1: a controlled fixture — the newest PDF by modified time is not the first or last by name.
  const put = (name: string, source: Parameters<typeof documentFixture>[0], when: string) => {
    copyFileSync(documentFixture(source), join(downloads, name))
    const time = new Date(when)
    utimesSync(join(downloads, name), time, time)
  }
  put('a-old-report.pdf', 'report.pdf', '2026-01-10T10:00:00Z')
  put('m-newest-report.pdf', 'report.pdf', '2026-09-20T08:30:00Z')
  put('z-middle-report.pdf', 'report.pdf', '2026-05-05T12:00:00Z')
  put('newer-but-docx.docx', 'briefing.docx', '2026-09-25T09:00:00Z')
  for (const name of [
    'notes.txt',
    'briefing.docx',
    'review.pptx',
    'budget.xlsx',
    'chart.png'
  ] as const)
    copyFileSync(documentFixture(name), join(roots().documents, name))
  writeFileSync(join(outside, 'secret.txt'), 'outside the approved folders')
  const entry = join(folder, 'document-runtime.mjs')
  await bundleDocumentRuntime(entry)
  host = new FileHost({
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] }),
    roots: roots(),
    runtimeEntry: entry,
    command: process.execPath,
    printPdf: null,
    openPath: () => Promise.resolve(''),
    showItemInFolder: () => undefined,
    // The test's own "Recycle Bin": the file is moved there, never destroyed.
    trash: async (path) => {
      trashed.push(path)
      const bin = join(folder, 'recycle-bin')
      mkdirSync(bin, { recursive: true })
      await rename(path, join(bin, `${uuidv7()}-${basename(path)}`))
    }
  })
  await host.probe()
}, 120_000)

afterAll(async () => {
  await host.stop()
  await removeDir(folder)
  await removeDir(outside)
})

async function start(): Promise<Running> {
  return startCore(standard(), new Map(), [], {}, null, null, (input) => host.call(input))
}

/** Answers the pending requests as the person would (Always allow where offered). */
async function answerAll(
  running: Running,
  decision: 'ALWAYS_ALLOW' | 'ALLOW_ONCE' = 'ALWAYS_ALLOW'
) {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes(decision) ? decision : 'ALLOW_ONCE'
    })
  return requests
}

/** A refused call; when it first waits for a permission, answers it and calls again. */
async function refusedAfterAsking(
  running: Running,
  run: () => ReturnType<typeof failure>
): ReturnType<typeof failure> {
  const first = await run()
  if (first.code !== 'PERMISSION_REQUIRED') return first
  await answerAll(running)
  return run()
}

/** Runs a capability; if it waits for a permission, answers it and runs it again. */
async function granted<T>(running: Running, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!String(error).includes('PERMISSION_REQUIRED')) throw error
    await answerAll(running)
    return run()
  }
}

describe('SET 10 — File Agent, documents and the Artifact Manager', () => {
  it('AT1: finds the newest file by its real modified time from a controlled fixture', async () => {
    const running = await start()
    const query = {
      root: 'downloads',
      folder: '',
      recursive: false,
      formats: ['pdf'],
      nameContains: null,
      sortBy: 'modified',
      order: 'desc',
      limit: 10
    }
    // Listing a folder needs its own permission first.
    const refused = await failure(running, 'files.find', { query, missionId: null })
    expect(refused.code).toBe('PERMISSION_REQUIRED')
    const asked = await answerAll(running)
    expect(asked.map((request) => [request.capability, request.target])).toEqual([
      ['files.list', roots().downloads]
    ])
    const listing = await call(running, 'files.find', { query, missionId: null })
    expect(listing.entries.map((entry) => [entry.name, entry.modifiedAt])).toEqual([
      ['m-newest-report.pdf', '2026-09-20T08:30:00.000Z'],
      ['z-middle-report.pdf', '2026-05-05T12:00:00.000Z'],
      ['a-old-report.pdf', '2026-01-10T10:00:00.000Z']
    ])
    // The newer DOCX is not a PDF: it is not a candidate.
    expect(listing.entries.every((entry) => entry.format === 'pdf')).toBe(true)
  })

  it('AT2–AT5: reads TXT, and parses PDF, DOCX, PPTX and XLSX content and metadata', async () => {
    const running = await start()
    const read = (root: string, path: string) =>
      granted(running, () =>
        call(running, 'files.read', { location: { root, path }, maxChars: 10_000, missionId: null })
      )
    const txt = await read('documents', 'notes.txt')
    expect(txt.content.text).toBe('Mission notes\nLine two with ภาษาไทย.\n')
    expect(txt.file).toMatchObject({ name: 'notes.txt', format: 'txt', size: 51 })
    const pdf = await read('downloads', 'm-newest-report.pdf')
    expect(pdf.content.metadata).toMatchObject({ title: 'Jupiter Quarterly Report', pages: 2 })
    expect(pdf.content.pages[1]?.text).toContain('Revenue grew by 12 percent.')
    const docx = await read('documents', 'briefing.docx')
    expect(docx.content.headings).toEqual(['Mission Briefing', 'Moons'])
    expect(docx.content.text).toContain('Ganymede\t5268')
    const pptx = await read('documents', 'review.pptx')
    expect(pptx.content.slides.map((slide) => [slide.title, slide.notes, slide.images])).toEqual([
      ['Quarterly Review', 'Welcome everyone.', 0],
      ['Results', 'Mention the new office.', 1]
    ])
    const xlsx = await read('documents', 'budget.xlsx')
    expect(xlsx.content.sheets.map((sheet) => [sheet.name, sheet.rows, sheet.formulas])).toEqual([
      ['Budget', 4, 1],
      ['Notes', 1, 0]
    ])
    expect(xlsx.content.metadata.title).toBe('Budget 2026')
  })

  it('AT6: generated DOCX, PPTX and XLSX open in independent parsers and pass structural validation', async () => {
    const running = await start()
    const create = (name: string, spec: unknown) =>
      granted(running, () => call(running, 'artifacts.create', { missionId: null, name, spec }))
    const docx = await create('findings.docx', {
      format: 'docx',
      title: 'Findings',
      author: 'Test',
      blocks: [
        { type: 'heading', level: 1, text: 'Summary' },
        { type: 'bullet', text: 'Point one' }
      ]
    })
    const pptx = await create('deck.pptx', {
      format: 'pptx',
      title: 'Deck',
      author: 'Test',
      theme: { accent: 'C0392B', font: 'Calibri' },
      slides: [
        {
          layout: 'title',
          title: 'Deck',
          subtitle: 'Intro',
          bullets: [],
          image: null,
          notes: 'Hello'
        },
        {
          layout: 'content',
          title: 'Chart',
          subtitle: '',
          bullets: ['One'],
          image: { location: { root: 'documents', path: 'chart.png' }, alt: 'Chart' },
          notes: 'Explain'
        }
      ]
    })
    const xlsx = await create('numbers.xlsx', {
      format: 'xlsx',
      title: 'Numbers',
      author: 'Test',
      sheets: [
        {
          name: 'Data',
          columns: [
            { header: 'Name', type: 'text' },
            { header: 'Value', type: 'number' },
            { header: 'Double', type: 'formula' }
          ],
          rows: [['a', 1, '=B2*2']]
        }
      ]
    })
    for (const artifact of [docx, pptx, xlsx]) {
      expect(artifact.verificationStatus, JSON.stringify(artifact.verificationDetails)).toBe(
        'VERIFIED'
      )
      expect(artifact.location.root).toBe('workspace')
      expect(artifact.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.verificationDetails.map((check) => check.check)).toEqual(
        expect.arrayContaining([
          'package',
          'content-types-complete',
          'relationships',
          'xml-well-formed',
          'atomic-write'
        ])
      )
    }
    expect(checkOffice(docx.path, 'docx')).toMatchObject({ title: 'Findings' })
    expect(checkOffice(pptx.path, 'pptx')).toMatchObject({
      slides: [{ title: 'Deck' }, { title: 'Chart', pictures: 1 }]
    })
    expect(checkOffice(xlsx.path, 'xlsx')).toMatchObject({ sheets: [{ name: 'Data' }] })
    // The same name again is a new version next to the first; nothing is replaced.
    const again = await create('findings.docx', {
      format: 'docx',
      title: 'Findings v2',
      author: 'Test',
      blocks: [{ type: 'paragraph', text: 'Second version' }]
    })
    expect(again.version).toBe(2)
    expect(again.source.fromArtifactId).toBe(docx.artifactId)
    expect(again.path).not.toBe(docx.path)
    expect(existsSync(docx.path)).toBe(true)
    // Nothing temporary is left behind.
    expect(
      readdirSync(join(roots().workspace, 'shared')).filter((name) => name.startsWith('.jupiter-'))
    ).toEqual([])
  })

  it('AT7 and the example workflow: "Find newest PDF in Downloads and summarize it"; the artifact appears in the Mission, verified', async () => {
    const running = await start()
    await withModel(running)
    const plan: PlanDraft = {
      goal: 'Summarise the newest PDF in Downloads',
      assumptions: [],
      rationale: 'Find and read it, summarise it, save the summary.',
      steps: [
        {
          id: 'read',
          title: 'Read the newest PDF',
          description: 'File Agent',
          skillId: 'document.read_newest',
          dependencies: [],
          input: { root: 'downloads', format: 'pdf' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'sum',
          title: 'Summarise it',
          description: 'Model',
          skillId: 'model.generate',
          dependencies: ['read'],
          input: { prompt: 'Summarise, citing the source file:\n{{read}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'save',
          title: 'Save the summary',
          description: 'Artifact Manager',
          skillId: 'document.create',
          dependencies: ['sum'],
          input: { format: 'docx', name: 'summary.docx', content: '# Summary\n\n{{sum}}' },
          condition: null,
          timeoutMs: 60_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        }
      ],
      requiredSkills: ['document.read_newest', 'model.generate', 'document.create'],
      requiredPermissions: ['files.list', 'files.read', 'artifacts.create'],
      expectedArtifacts: [{ step: 'save', description: 'The summary document' }],
      verificationPlan: { checks: [{ step: 'sum', check: 'non-empty', description: 'Summarised' }] }
    }
    server.enqueue({ chunks: [JSON.stringify(plan)] })
    server.enqueue({ chunks: ['The storm is larger than Earth (source: m-newest-report.pdf).'] })
    const missionId = (
      await call(running, 'missions.create', {
        request: 'Find newest PDF in Downloads and summarize it',
        planner: 'model'
      })
    ).mission.missionId
    // Each step waits for its permission; the person answers.
    for (let round = 0; round < 3; round++) {
      await expect
        .poll(async () => (await call(running, 'missions.get', { missionId })).mission.status)
        .toMatch(/WAITING_APPROVAL|COMPLETED/)
      if ((await call(running, 'missions.get', { missionId })).mission.status === 'COMPLETED') break
      await answerAll(running)
    }
    const done = await settled(running, missionId, 'COMPLETED')
    const [read, , save] = done.steps
    // The step reports which file it chose, by modified time, and passes it on fenced as untrusted data.
    expect(read?.detail).toContain('"m-newest-report.pdf", modified 2026-09-20T08:30:00.000Z')
    const prompt = JSON.stringify(
      server.requests.filter((request) => request.method === 'POST').at(-1)?.body
    )
    expect(prompt).toContain('BEGIN UNTRUSTED DOCUMENT TEXT')
    expect(prompt).toContain('m-newest-report.pdf')
    expect(prompt).toContain('The Great Red Spot is a storm larger than Earth.')
    expect(done.files).toHaveLength(1)
    const artifact: Artifact | undefined = done.files[0]
    if (!artifact) throw new Error('no artifact')
    expect(artifact).toMatchObject({
      missionId,
      stepId: save?.stepId,
      name: 'summary.docx',
      type: 'docx',
      version: 1,
      verificationStatus: 'VERIFIED',
      location: { root: 'workspace', path: `${missionId}/summary.docx` }
    })
    expect(artifact.source.transformation).toContain('Save the summary')
    const opened = checkOffice(artifact.path, 'docx') as { paragraphs: { text: string }[] }
    expect(opened.paragraphs.map((paragraph) => paragraph.text)).toContain(
      'The storm is larger than Earth (source: m-newest-report.pdf).'
    )
    expect(
      running.events.some(
        (event) => event.type === 'artifact.created' && event.missionId === missionId
      )
    ).toBe(true)
    // Checked again later: same hash, still valid.
    const again = await call(running, 'artifacts.verify', { artifactId: artifact.artifactId })
    expect(again.verificationStatus).toBe('VERIFIED')
    expect(again.verificationDetails.find((check) => check.check === 'unchanged')?.passed).toBe(
      true
    )
    // Cleanup never removes what the person kept.
    await call(running, 'artifacts.keep', { artifactId: artifact.artifactId, kept: true })
    const cleaned = await granted(running, () => call(running, 'artifacts.cleanup', { missionId }))
    expect(cleaned.removed).toBe(0)
    expect(existsSync(artifact.path)).toBe(true)
  }, 120_000)

  it('AT8: delete needs a CRITICAL permission for the exact file, asked every time; the file goes to the Recycle Bin', async () => {
    const running = await start()
    const downloads = roots().downloads
    writeFileSync(join(downloads, 'old-a.txt'), 'a')
    writeFileSync(join(downloads, 'old-b.txt'), 'b')
    const first = await failure(running, 'files.delete', {
      location: { root: 'downloads', path: 'old-a.txt' },
      missionId: null
    })
    expect(first.code).toBe('PERMISSION_REQUIRED')
    const { requests } = await call(running, 'permissions.requests', {
      status: 'PENDING',
      limit: 10
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      capability: 'files.delete',
      target: join(downloads, 'old-a.txt'),
      risk: 'CRITICAL'
    })
    expect(requests[0]?.offered).toEqual(['ALLOW_ONCE', 'DENY'])
    expect(existsSync(join(downloads, 'old-a.txt'))).toBe(true)
    await answerAll(running, 'ALLOW_ONCE')
    expect(
      await call(running, 'files.delete', {
        location: { root: 'downloads', path: 'old-a.txt' },
        missionId: null
      })
    ).toEqual({ done: true })
    expect(existsSync(join(downloads, 'old-a.txt'))).toBe(false)
    expect(trashed).toContain(join(downloads, 'old-a.txt'))
    // That answer covered that one file, once: the other file asks again, and nothing happens meanwhile.
    expect(
      (
        await failure(running, 'files.delete', {
          location: { root: 'downloads', path: 'old-b.txt' },
          missionId: null
        })
      ).code
    ).toBe('PERMISSION_REQUIRED')
    expect(existsSync(join(downloads, 'old-b.txt'))).toBe(true)
    // Denied: nothing is deleted.
    const pending = (await call(running, 'permissions.requests', { status: 'PENDING', limit: 10 }))
      .requests
    await call(running, 'permissions.decide', {
      requestId: pending[0]?.requestId,
      decision: 'DENY'
    })
    expect(
      (
        await failure(running, 'files.delete', {
          location: { root: 'downloads', path: 'old-b.txt' },
          missionId: null
        })
      ).code
    ).toBe('PERMISSION_REQUIRED')
    expect(existsSync(join(downloads, 'old-b.txt'))).toBe(true)
    // Deleting an artifact is the same: its exact file, CRITICAL; the record stays, marked deleted.
    const artifact = await granted(running, () =>
      call(running, 'artifacts.create', {
        missionId: null,
        name: 'temp.txt',
        spec: { format: 'txt', text: 'temporary' }
      })
    )
    expect(
      (await failure(running, 'artifacts.delete', { artifactId: artifact.artifactId })).code
    ).toBe('PERMISSION_REQUIRED')
    await answerAll(running, 'ALLOW_ONCE')
    const removed = await call(running, 'artifacts.delete', { artifactId: artifact.artifactId })
    expect(removed.deletedAt).not.toBeNull()
    expect(existsSync(artifact.path)).toBe(false)
    const listed = await call(running, 'artifacts.list', {
      missionId: null,
      includeDeleted: true,
      limit: 50
    })
    expect(
      listed.artifacts.find((item) => item.artifactId === artifact.artifactId)?.deletedAt
    ).not.toBeNull()
  })

  it('AT9: a missing or damaged file fails with a structured error, and Jupiter keeps working (even if the runtime crashes)', async () => {
    const running = await start()
    const documents = roots().documents
    const docx = readFileSync(documentFixture('briefing.docx'))
    writeFileSync(join(documents, 'damaged.docx'), docx.subarray(0, 1_000))
    writeFileSync(join(documents, 'fake.pdf'), 'not a pdf at all')
    const read = (path: string) =>
      failure(running, 'files.read', {
        location: { root: 'documents', path },
        maxChars: 1000,
        missionId: null
      })
    await granted(running, () =>
      call(running, 'files.read', {
        location: { root: 'documents', path: 'notes.txt' },
        maxChars: 100,
        missionId: null
      })
    )
    await answerAll(running)
    const missing = await refusedAfterAsking(running, () => read('nowhere.pdf'))
    expect(missing.code).toBe('FILE_NOT_FOUND')
    const damaged = await refusedAfterAsking(running, () => read('damaged.docx'))
    expect([damaged.code, damaged.category]).toEqual(['DOCUMENT_INVALID', 'validation'])
    const fake = await refusedAfterAsking(running, () => read('fake.pdf'))
    expect(fake.code).toBe('DOCUMENT_INVALID')
    // The runtime process dies: the next read is reported as such, then works on a new runtime.
    const pid = host.runtimePid
    process.kill(pid ?? 0, 'SIGKILL')
    await expect.poll(() => host.runtimePid).toBeNull()
    const crashed = await read('notes.txt')
    expect(crashed.code).toBe('RUNTIME_CRASHED')
    const again = await call(running, 'files.read', {
      location: { root: 'documents', path: 'notes.txt' },
      maxChars: 100,
      missionId: null
    })
    expect(again.content.text).toContain('Mission notes')
    expect(host.runtimePid).not.toBe(pid)
    expect((await call(running, 'files.status', {})).available).toBe(true)
  })

  it('AT10: path traversal, absolute paths and links out of an approved folder are rejected', async () => {
    const running = await start()
    const documents = roots().documents
    for (const path of [
      '../outside.txt',
      'a/../../x.txt',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'report.txt:hidden',
      'CON',
      'NUL.txt'
    ]) {
      const refused = await failure(running, 'files.read', {
        location: { root: 'documents', path },
        maxChars: 100,
        missionId: null
      })
      expect(refused.code, path).toBe('INVALID_PAYLOAD')
    }
    // A link to a file outside, and a junction (Windows) or symbolic link (elsewhere) to a folder outside.
    // A junction needs no privilege on Windows; a file symbolic link does (Developer Mode or admin).
    symlinkSync(
      outside,
      join(documents, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    let fileLink = true
    try {
      symlinkSync(join(outside, 'secret.txt'), join(documents, 'link.txt'), 'file')
    } catch (error) {
      if (process.platform !== 'win32') throw error
      fileLink = false
    }
    await answerAll(running)
    for (const path of fileLink ? ['link.txt', 'escape/secret.txt'] : ['escape/secret.txt']) {
      const refused = await granted(running, () =>
        failure(running, 'files.read', {
          location: { root: 'documents', path },
          maxChars: 100,
          missionId: null
        })
      )
      expect(refused.code, path).toBe('PATH_REFUSED')
    }
    const copy = await failure(running, 'files.copy', {
      from: { root: 'documents', path: 'notes.txt' },
      to: { root: 'documents', path: 'escape/copied.txt' },
      missionId: null
    })
    expect(copy.code).toBe('PATH_REFUSED')
    expect(existsSync(join(outside, 'copied.txt'))).toBe(false)
    // Listing never follows links; they are counted as skipped.
    const listing = await granted(running, () =>
      call(running, 'files.find', {
        query: {
          root: 'documents',
          folder: '',
          recursive: true,
          formats: [],
          nameContains: null,
          sortBy: 'name',
          order: 'asc',
          limit: 100
        },
        missionId: null
      })
    )
    expect(
      listing.entries.some((entry) => entry.name === 'secret.txt' || entry.name === 'link.txt')
    ).toBe(false)
    expect(listing.skipped).toBeGreaterThanOrEqual(fileLink ? 2 : 1)
    // Every refusal is on the record.
    expect(
      running.events.filter(
        (event) =>
          event.type === 'file.operation' &&
          (event.payload as { outcome: string }).outcome === 'refused'
      ).length
    ).toBeGreaterThanOrEqual(3)
  })
})
