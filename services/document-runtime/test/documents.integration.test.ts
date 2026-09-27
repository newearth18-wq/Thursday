import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentSpec } from '@jupiter/contracts'
import { createTempDir, removeDir } from '@jupiter/testing'
import { checkOffice, copyFixtures, documentFixture } from '@jupiter/testing/documents'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentRuntime, DocumentRuntimeError } from '../src'
import { bundleDocumentRuntime } from '../src/build'

/**
 * The document runtime (SET 10), bundled as the app ships it and run as its
 * own process: it reads documents made by other programs, writes Office
 * files that other programs open, checks them, and fails with a structured
 * error — without taking anything else down — on damaged or hostile files.
 */

let folder: string
let runtime: DocumentRuntime

beforeAll(async () => {
  folder = await createTempDir('jupiter-documents')
  copyFixtures(folder)
  const entry = join(folder, 'document-runtime.mjs')
  await bundleDocumentRuntime(entry)
  runtime = new DocumentRuntime({
    launch: { command: process.execPath, entry, memoryLimitMb: 512 },
    callTimeoutMs: 60_000,
    startTimeoutMs: 30_000
  })
}, 120_000)

afterAll(async () => {
  await runtime.stop()
  await removeDir(folder)
})

const at = (name: string) => join(folder, name)

async function failure(promise: Promise<unknown>): Promise<DocumentRuntimeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DocumentRuntimeError) return error
    throw error
  }
  throw new Error('expected a DocumentRuntimeError')
}

async function write(
  name: string,
  spec: DocumentSpec,
  images: { slide: number; path: string }[] = []
) {
  const path = at(`${randomUUID()}-${name}`)
  await runtime.call('write', { path, spec, images })
  const checked = await runtime.call('validate', { path, format: spec.format, spec })
  return { path, checked }
}

describe('reading documents made by other programs', () => {
  it('reads TXT, Markdown, CSV and JSON', async () => {
    const txt = await runtime.call('extract', {
      path: at('notes.txt'),
      format: 'txt',
      maxChars: 1000
    })
    expect(txt.text).toBe('Mission notes\nLine two with ภาษาไทย.\n')
    const md = await runtime.call('extract', { path: at('plan.md'), format: 'md', maxChars: 1000 })
    expect(md.headings).toEqual(['Plan', 'Steps'])
    const csv = await runtime.call('extract', {
      path: at('planets.csv'),
      format: 'csv',
      maxChars: 1000
    })
    expect(csv.sheets[0]?.cells).toEqual([
      ['name', 'moons'],
      ['Jupiter', '95'],
      ['Saturn, the ringed', '146']
    ])
    const json = await runtime.call('extract', {
      path: at('planet.json'),
      format: 'json',
      maxChars: 1000
    })
    expect(JSON.parse(json.text)).toEqual({ planet: 'Jupiter', moons: 95, rings: true })
  })

  it('parses a PDF (Chromium-made): pages, text and metadata', async () => {
    const pdf = await runtime.call('extract', {
      path: at('report.pdf'),
      format: 'pdf',
      maxChars: 10_000
    })
    expect(pdf.metadata).toMatchObject({ title: 'Jupiter Quarterly Report', pages: 2 })
    expect(pdf.pages.map((page) => page.number)).toEqual([1, 2])
    expect(pdf.pages[0]?.text).toContain('The Great Red Spot is a storm larger than Earth.')
    expect(pdf.pages[1]?.text).toContain('Revenue grew by 12 percent.')
  })

  it('parses a DOCX (python-docx-made): headings, paragraphs, lists, tables, Thai text', async () => {
    const docx = await runtime.call('extract', {
      path: at('briefing.docx'),
      format: 'docx',
      maxChars: 10_000
    })
    expect(docx.metadata).toMatchObject({ title: 'Mission Briefing', author: 'Fixture Author' })
    expect(docx.headings).toEqual(['Mission Briefing', 'Moons'])
    for (const text of [
      'Jupiter has 95 known moons.',
      'Io is volcanic.',
      'Ganymede\t5268',
      'ภาษาไทย: ดาวพฤหัสบดี'
    ])
      expect(docx.text).toContain(text)
  })

  it('parses a PPTX (python-pptx-made): slides in order, titles, text, notes, images', async () => {
    const pptx = await runtime.call('extract', {
      path: at('review.pptx'),
      format: 'pptx',
      maxChars: 10_000
    })
    expect(pptx.metadata).toMatchObject({ title: 'Quarterly Review', slides: 2 })
    expect(pptx.slides).toEqual([
      {
        number: 1,
        title: 'Quarterly Review',
        text: 'Second quarter',
        notes: 'Welcome everyone.',
        images: 0
      },
      {
        number: 2,
        title: 'Results',
        text: 'Revenue grew 12%\nCosts fell 3%',
        notes: 'Mention the new office.',
        images: 1
      }
    ])
  })

  it('parses an XLSX (openpyxl-made): sheets, typed cells, formulas', async () => {
    const xlsx = await runtime.call('extract', {
      path: at('budget.xlsx'),
      format: 'xlsx',
      maxChars: 10_000
    })
    expect(xlsx.metadata).toMatchObject({ title: 'Budget 2026', sheets: 2 })
    const [budget, notes] = xlsx.sheets
    expect(budget).toMatchObject({ name: 'Budget', rows: 4, columns: 3, formulas: 1 })
    expect(budget?.cells[0]).toEqual(['Item', 'Amount', 'Date'])
    expect(budget?.cells[1]?.slice(0, 2)).toEqual(['Telescope', '1200'])
    expect(budget?.cells[2]?.slice(0, 2)).toEqual(['Filters', '300.5'])
    expect(notes).toMatchObject({ name: 'Notes', rows: 1, cells: [['Approved by the team']] })
  })
})

describe('writing Office files that other programs open', () => {
  it('DOCX: opens in python-docx with the title, headings, bullets and table, and passes structural validation', async () => {
    const { path, checked } = await write('report.docx', {
      format: 'docx',
      title: 'Findings',
      author: 'Jupiter test',
      blocks: [
        { type: 'heading', level: 1, text: 'Summary' },
        { type: 'paragraph', text: 'The storm is shrinking.\nSecond line.' },
        { type: 'bullet', text: 'First point' },
        { type: 'bullet', text: 'สรุปภาษาไทย' },
        {
          type: 'table',
          rows: [
            ['Moon', 'Km'],
            ['Io', '3643']
          ]
        }
      ]
    })
    expect(checked.valid, JSON.stringify(checked.checks, null, 2)).toBe(true)
    expect(checked.checks.map((check) => check.check)).toEqual(
      expect.arrayContaining([
        'package',
        'content-types-complete',
        'xml-well-formed',
        'relationships',
        'main-part',
        'body',
        'content',
        'headings'
      ])
    )
    const opened = checkOffice(path, 'docx') as {
      title: string
      paragraphs: { style: string; text: string }[]
      tables: string[][][]
    }
    expect(opened.title).toBe('Findings')
    expect(opened.paragraphs.slice(0, 5)).toEqual([
      { style: 'Title', text: 'Findings' },
      { style: 'Heading 1', text: 'Summary' },
      { style: 'Normal', text: 'The storm is shrinking.\nSecond line.' },
      { style: 'List Bullet', text: 'First point' },
      { style: 'List Bullet', text: 'สรุปภาษาไทย' }
    ])
    expect(opened.tables).toEqual([
      [
        ['Moon', 'Km'],
        ['Io', '3643']
      ]
    ])
  })

  it('PPTX: theme, title and content layouts, an image and speaker notes open in python-pptx; every slide validates', async () => {
    const { path, checked } = await write(
      'deck.pptx',
      {
        format: 'pptx',
        title: 'Mission Update',
        author: 'Jupiter test',
        theme: { accent: '2F6FDE', font: 'Segoe UI' },
        slides: [
          {
            layout: 'title',
            title: 'Mission Update',
            subtitle: 'September',
            bullets: [],
            image: null,
            notes: 'Open with the goal.'
          },
          {
            layout: 'content',
            title: 'Progress',
            subtitle: '',
            bullets: ['Three moons mapped', 'ภาษาไทย'],
            image: { location: { root: 'workspace', path: 'chart.png' }, alt: 'A chart' },
            notes: 'Point at the chart.'
          }
        ]
      },
      [{ slide: 1, path: at('chart.png') }]
    )
    expect(checked.valid, JSON.stringify(checked.checks, null, 2)).toBe(true)
    expect(
      checked.checks.filter((check) => check.check.startsWith('slide')).map((check) => check.check)
    ).toEqual(['slides', 'slide-count', 'slide-1', 'slide-2'])
    const opened = checkOffice(path, 'pptx') as {
      title: string
      width: number
      height: number
      slides: { layout: string; title: string; texts: string[]; notes: string; pictures: number }[]
    }
    expect(opened).toMatchObject({ title: 'Mission Update', width: 12_192_000, height: 6_858_000 })
    expect(opened.slides).toEqual([
      {
        layout: 'Title Slide',
        title: 'Mission Update',
        texts: ['September'],
        notes: 'Open with the goal.',
        pictures: 0
      },
      {
        layout: 'Title and Content',
        title: 'Progress',
        texts: ['Three moons mapped\nภาษาไทย'],
        notes: 'Point at the chart.',
        pictures: 1
      }
    ])
    // The theme carries the accent colour and font that were asked for.
    const theme = new TextDecoder().decode(
      (await import('fflate')).unzipSync(new Uint8Array(readFileSync(path)))['ppt/theme/theme1.xml']
    )
    expect(theme).toContain('<a:accent1><a:srgbClr val="2F6FDE"/></a:accent1>')
    expect(theme).toContain('<a:latin typeface="Segoe UI"/>')
  })

  it('XLSX: typed cells and checked formulas open in openpyxl; text that looks like a formula stays text', async () => {
    const { path, checked } = await write('budget.xlsx', {
      format: 'xlsx',
      title: 'Budget',
      author: 'Jupiter test',
      sheets: [
        {
          name: 'Costs',
          columns: [
            { header: 'Item', type: 'text' },
            { header: 'Amount', type: 'number' },
            { header: 'Paid', type: 'boolean' },
            { header: 'Due', type: 'date' },
            { header: 'Running total', type: 'formula' }
          ],
          rows: [
            ['Lens', 120.5, true, '2026-10-01', '=SUM(B2:B2)'],
            [
              '=HYPERLINK("http://example.invalid","click")',
              30,
              false,
              '2026-10-02',
              '=ROUND(SUM(B2:B3),1)'
            ]
          ]
        }
      ]
    })
    expect(checked.valid, JSON.stringify(checked.checks, null, 2)).toBe(true)
    const opened = checkOffice(path, 'xlsx') as {
      title: string
      sheets: { name: string; rows: { value: unknown; type: string; format: string }[][] }[]
    }
    const rows = opened.sheets[0]?.rows ?? []
    expect(opened.sheets.map((sheet) => sheet.name)).toEqual(['Costs'])
    expect(rows[0]?.map((cell) => cell.value)).toEqual([
      'Item',
      'Amount',
      'Paid',
      'Due',
      'Running total'
    ])
    expect(rows[1]?.map((cell) => [cell.value, cell.type])).toEqual([
      ['Lens', 's'],
      [120.5, 'n'],
      [true, 'b'],
      ['2026-10-01T00:00:00', 'd'],
      ['=SUM(B2:B2)', 'f']
    ])
    expect(rows[1]?.[3]?.format).toBe('yyyy-mm-dd')
    // Untrusted text that starts with "=" is a string, not a formula.
    expect(rows[2]?.[0]).toMatchObject({
      value: '=HYPERLINK("http://example.invalid","click")',
      type: 's'
    })
    expect(rows[2]?.[4]).toMatchObject({ value: '=ROUND(SUM(B2:B3),1)', type: 'f' })
  })

  it('refuses a formula that is not allowed and a cell of the wrong type; nothing is written', async () => {
    const sheet = (rows: string[][], type: 'formula' | 'number'): DocumentSpec => ({
      format: 'xlsx',
      title: 'x',
      author: '',
      sheets: [{ name: 'S', columns: [{ header: 'A', type }], rows }]
    })
    const path = at(`${randomUUID()}.xlsx`)
    const external = await failure(
      runtime.call('write', {
        path,
        spec: sheet([['=WEBSERVICE("http://example.invalid")']], 'formula'),
        images: []
      })
    )
    expect(external.code).toBe('DOCUMENT_SPEC_INVALID')
    expect(external.message).toContain('WEBSERVICE is not allowed')
    const linked = await failure(
      runtime.call('write', {
        path,
        spec: sheet([["='[other.xlsx]Sheet1'!A1"]], 'formula'),
        images: []
      })
    )
    expect(linked.code).toBe('DOCUMENT_SPEC_INVALID')
    const wrongType = await failure(
      runtime.call('write', { path, spec: sheet([['twelve']], 'number'), images: [] })
    )
    expect(wrongType.message).toContain('"twelve" is not a number')
  })

  it('CSV, JSON, TXT and Markdown are written exactly; CSV neutralises formula injection', async () => {
    const csv = await write('rows.csv', {
      format: 'csv',
      headers: ['name', 'note'],
      rows: [
        ['Io', '=cmd|" /C calc"!A0'],
        ['Europa', '+1+1'],
        ['Callisto', 'plain, with comma']
      ]
    })
    expect(csv.checked.valid, JSON.stringify(csv.checked.checks)).toBe(true)
    const text = readFileSync(csv.path, 'utf8')
    expect(text).toContain(`Io,"'=cmd|"" /C calc""!A0"`)
    expect(text).toContain("Europa,'+1+1")
    for (const spec of [
      { format: 'json' as const, value: { a: [1, 2, { b: 'ภาษาไทย' }] } },
      { format: 'txt' as const, text: 'Line 1\nLine 2' },
      { format: 'md' as const, text: '# Title\n\nBody' }
    ]) {
      const written = await write(`file.${spec.format}`, spec)
      expect(written.checked.valid, JSON.stringify(written.checked.checks)).toBe(true)
    }
  })
})

describe('damaged, hostile and missing files fail safely', () => {
  it('a missing, empty, truncated or mislabelled file is a structured failure, and the runtime keeps working', async () => {
    expect(
      (
        await failure(
          runtime.call('extract', { path: at('nope.pdf'), format: 'pdf', maxChars: 100 })
        )
      ).code
    ).toBe('FILE_NOT_FOUND')
    writeFileSync(at('empty.docx'), '')
    expect(
      (
        await failure(
          runtime.call('extract', { path: at('empty.docx'), format: 'docx', maxChars: 100 })
        )
      ).code
    ).toBe('DOCUMENT_EMPTY')
    const docx = readFileSync(documentFixture('briefing.docx'))
    writeFileSync(at('cut.docx'), docx.subarray(0, Math.floor(docx.length / 2)))
    expect(
      (
        await failure(
          runtime.call('extract', { path: at('cut.docx'), format: 'docx', maxChars: 100 })
        )
      ).code
    ).toBe('DOCUMENT_INVALID')
    const pdf = readFileSync(documentFixture('report.pdf'))
    writeFileSync(at('cut.pdf'), pdf.subarray(0, 600))
    expect(
      (
        await failure(
          runtime.call('extract', { path: at('cut.pdf'), format: 'pdf', maxChars: 100 })
        )
      ).code
    ).toBe('DOCUMENT_INVALID')
    writeFileSync(at('fake.xlsx'), 'This is not a spreadsheet.')
    const fake = await failure(
      runtime.call('extract', { path: at('fake.xlsx'), format: 'xlsx', maxChars: 100 })
    )
    expect([fake.code, fake.message]).toEqual([
      'DOCUMENT_INVALID',
      'The file is not a XLSX document: it is not a ZIP package.'
    ])
    // Still answering.
    expect((await runtime.call('ping', {})).pid).toBeGreaterThan(0)
  })

  it('refuses XML with entities (XXE, billion laughs) and a zip bomb without unpacking it', async () => {
    const xxe = zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>'
      )
    })
    writeFileSync(at('xxe.docx'), xxe)
    const refused = await failure(
      runtime.call('extract', { path: at('xxe.docx'), format: 'docx', maxChars: 100 })
    )
    expect(refused.code).toBe('DOCUMENT_INVALID')
    expect(refused.message).toContain('DOCTYPE')
    const bomb = zipSync({ 'xl/big.xml': new Uint8Array(250 * 1024 * 1024) }, { level: 9 })
    writeFileSync(at('bomb.xlsx'), bomb)
    const exploded = await failure(
      runtime.call('extract', { path: at('bomb.xlsx'), format: 'xlsx', maxChars: 100 })
    )
    expect(exploded.code).toBe('DOCUMENT_TOO_LARGE')
  }, 60_000)

  it('a crash of the runtime is reported once and the next call gets a new runtime', async () => {
    const pid = runtime.pid
    expect(pid).not.toBeNull()
    process.kill(pid ?? 0, 'SIGKILL')
    await expect.poll(() => runtime.state).toBe('crashed')
    expect((await failure(runtime.call('ping', {}))).code).toBe('RUNTIME_CRASHED')
    const again = await runtime.call('extract', {
      path: at('notes.txt'),
      format: 'txt',
      maxChars: 100
    })
    expect(again.text).toContain('Mission notes')
    expect(runtime.pid).not.toBe(pid)
  })
})
