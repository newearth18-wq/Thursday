import type { DocumentContent, DocumentFormat, DocumentMetadata } from '@jupiter/contracts'
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { DocumentError, openPackage, type Package } from './package'
import { LIMITS } from './protocol'
import {
  attr,
  relId,
  childOf,
  childrenOf,
  descendants,
  isElement,
  textOf,
  XmlError,
  type XmlElement
} from './xml'

/**
 * Reading documents (SET 10). Every document is untrusted input: what it
 * says is returned as data. A document that is damaged, protected or not
 * what its name says fails with a structured error; nothing is guessed.
 */

type Content = DocumentContent
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const MAX_PAGE_TEXT = 20_000
const MAX_CELL = 2_000

function blankMetadata(): Mutable<DocumentMetadata> {
  return {
    title: null,
    author: null,
    subject: null,
    createdAt: null,
    modifiedAt: null,
    pages: null,
    slides: null,
    sheets: null,
    words: null
  }
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed.slice(0, max)
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function finish(
  format: DocumentFormat,
  full: string,
  maxChars: number,
  metadata: Mutable<DocumentMetadata>,
  parts: Partial<Pick<Content, 'headings' | 'pages' | 'slides' | 'sheets'>> = {}
): Content {
  metadata.words ??= words(full)
  return {
    format,
    text: full.slice(0, maxChars),
    truncated: full.length > maxChars,
    characters: full.length,
    metadata,
    headings: (parts.headings ?? []).slice(0, 200).map((heading) => heading.slice(0, 300)),
    pages: parts.pages ?? [],
    slides: parts.slides ?? [],
    sheets: parts.sheets ?? []
  }
}

// ---- Plain text formats -------------------------------------------------------------------

export function decodeText(bytes: Uint8Array, format: string): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  const head = bytes.subarray(0, 8_192)
  if (head.includes(0))
    throw new DocumentError(
      'DOCUMENT_INVALID',
      `The file is not a ${format.toUpperCase()} text file: it contains binary data.`
    )
  const text = new TextDecoder('utf-8').decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readText(bytes: Uint8Array, format: 'txt' | 'md', maxChars: number): Content {
  const text = decodeText(bytes, format).replace(/\r\n?/g, '\n')
  const metadata = blankMetadata()
  const headings =
    format === 'md'
      ? text
          .split('\n')
          .filter((line) => /^#{1,6}\s+\S/.test(line))
          .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
      : []
  metadata.title = clip(headings[0] ?? null, 300)
  return finish(format, text, maxChars, metadata, { headings })
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (quoted)
    throw new DocumentError('DOCUMENT_INVALID', 'The CSV file ends inside a quoted field.')
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function readCsv(bytes: Uint8Array, maxChars: number): Content {
  const text = decodeText(bytes, 'csv')
  const rows = parseCsv(text)
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return finish('csv', text.replace(/\r\n?/g, '\n'), maxChars, blankMetadata(), {
    sheets: [
      {
        name: 'CSV',
        rows: rows.length,
        columns,
        cells: rows
          .slice(0, 200)
          .map((row) => row.slice(0, 50).map((cell) => cell.slice(0, MAX_CELL))),
        formulas: 0
      }
    ]
  })
}

function readJson(bytes: Uint8Array, maxChars: number): Content {
  const text = decodeText(bytes, 'json')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new DocumentError(
      'DOCUMENT_INVALID',
      `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`
    )
  }
  return finish('json', JSON.stringify(value, null, 2), maxChars, blankMetadata())
}

// ---- PDF ----------------------------------------------------------------------------------

type PdfModule = typeof PdfJs
let pdfjs: Promise<PdfModule> | null = null

function loadPdfjs(): Promise<PdfModule> {
  pdfjs ??= (async () => {
    // The worker runs in this process ("fake worker"): the runtime is already isolated.
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
    return import('pdfjs-dist/legacy/build/pdf.mjs')
  })()
  return pdfjs
}

function pdfDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value)
  if (!match) return clip(value, 64)
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match
  return `${year ?? ''}-${month}-${day}T${hour}:${minute}:${second}Z`
}

async function readPdf(bytes: Uint8Array, maxChars: number): Promise<Content> {
  const { getDocument, VerbosityLevel } = await loadPdfjs()
  const task = getDocument({
    data: bytes,
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
    stopAtErrors: true
  })
  let document: Awaited<typeof task.promise>
  try {
    document = await task.promise
  } catch (error) {
    const name = (error as { name?: unknown }).name
    if (name === 'PasswordException')
      throw new DocumentError(
        'DOCUMENT_PROTECTED',
        'The PDF is protected by a password; it was not read.'
      )
    throw new DocumentError(
      'DOCUMENT_INVALID',
      `The file is not a readable PDF: ${error instanceof Error ? error.message : String(error)}.`
    )
  }
  try {
    const metadata = blankMetadata()
    const info = (await document.getMetadata()).info as Record<string, unknown>
    metadata.title = clip(typeof info.Title === 'string' ? info.Title : null, 300)
    metadata.author = clip(typeof info.Author === 'string' ? info.Author : null, 200)
    metadata.subject = clip(typeof info.Subject === 'string' ? info.Subject : null, 300)
    metadata.createdAt = pdfDate(info.CreationDate)
    metadata.modifiedAt = pdfDate(info.ModDate)
    metadata.pages = document.numPages
    const pages: { number: number; text: string }[] = []
    let full = ''
    for (let number = 1; number <= Math.min(document.numPages, LIMITS.sections); number++) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items)
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '')
      text = text.replace(/[ \t]+\n/g, '\n').trim()
      pages.push({ number, text: text.slice(0, MAX_PAGE_TEXT) })
      full += (full ? '\n\n' : '') + text
      page.cleanup()
      if (full.length > maxChars * 2) break
    }
    return finish('pdf', full, maxChars, metadata, { pages })
  } finally {
    await task.destroy()
  }
}

// ---- Office packages ----------------------------------------------------------------------

function officeDocumentPart(pkg: Package, format: string): string {
  const main = pkg.relationshipsOfType('', '/officeDocument')[0]?.target
  if (!main || !pkg.has(main))
    throw new DocumentError(
      'DOCUMENT_INVALID',
      `The ${format.toUpperCase()} package has no main document part.`
    )
  return main
}

function coreMetadata(pkg: Package): Mutable<DocumentMetadata> {
  const metadata = blankMetadata()
  const part = pkg.relationshipsOfType('', '/core-properties')[0]?.target ?? 'docProps/core.xml'
  const core = pkg.has(part) ? pkg.xml(part) : null
  if (!core) return metadata
  const value = (local: string) => {
    const element = childOf(core, local)
    return element ? textOf(element) : null
  }
  metadata.title = clip(value('title'), 300)
  metadata.author = clip(value('creator'), 200)
  metadata.subject = clip(value('subject'), 300)
  metadata.createdAt = clip(value('created'), 64)
  metadata.modifiedAt = clip(value('modified'), 64)
  return metadata
}

/** The text of a WordprocessingML paragraph: runs, tabs and breaks. */
function paragraphText(paragraph: XmlElement): string {
  let text = ''
  const walk = (element: XmlElement) => {
    for (const child of element.children) {
      if (!isElement(child)) continue
      if (child.local === 't') text += textOf(child)
      else if (child.local === 'tab') text += '\t'
      else if (child.local === 'br' || child.local === 'cr') text += '\n'
      else if (child.local !== 'delText' && child.local !== 'instrText') walk(child)
    }
  }
  walk(paragraph)
  return text
}

function readDocx(bytes: Uint8Array, maxChars: number): Content {
  const pkg = openPackage(bytes, 'docx')
  const main = officeDocumentPart(pkg, 'docx')
  const document = pkg.xml(main)
  const body = document ? childOf(document, 'body') : null
  if (!body) throw new DocumentError('DOCUMENT_INVALID', 'The DOCX document has no body.')
  const metadata = coreMetadata(pkg)
  const lines: string[] = []
  const headings: string[] = []
  for (const block of body.children) {
    if (!isElement(block)) continue
    if (block.local === 'p') {
      const text = paragraphText(block)
      const style = attr(childOf(childOf(block, 'pPr') ?? block, 'pStyle') ?? block, 'val') ?? ''
      if (/^(heading\s?\d|title)$/i.test(style) && text.trim()) headings.push(text.trim())
      lines.push(text)
    } else if (block.local === 'tbl') {
      for (const row of childrenOf(block, 'tr'))
        lines.push(
          childrenOf(row, 'tc')
            .map((cell) => childrenOf(cell, 'p').map(paragraphText).join(' '))
            .join('\t')
        )
    } else if (block.local === 'sdt') {
      for (const paragraph of descendants(block, 'p')) lines.push(paragraphText(paragraph))
    }
  }
  const full = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return finish('docx', full, maxChars, metadata, { headings })
}

function shapeText(shape: XmlElement): string {
  const body = childOf(shape, 'txBody')
  if (!body) return ''
  return childrenOf(body, 'p')
    .map((paragraph) => descendants(paragraph, 't').map(textOf).join(''))
    .join('\n')
    .trim()
}

function placeholderType(shape: XmlElement): string | null {
  const nv = childOf(shape, 'nvSpPr')
  const ph = nv ? childOf(childOf(nv, 'nvPr') ?? nv, 'ph') : null
  return ph ? (attr(ph, 'type') ?? 'body') : null
}

function readPptx(bytes: Uint8Array, maxChars: number): Content {
  const pkg = openPackage(bytes, 'pptx')
  const main = officeDocumentPart(pkg, 'pptx')
  const presentation = pkg.xml(main)
  if (!presentation)
    throw new DocumentError('DOCUMENT_INVALID', 'The PPTX package has no presentation.')
  const rels = new Map(pkg.relationships(main).map((rel) => [rel.id, rel]))
  const list = childOf(presentation, 'sldIdLst')
  const slideParts = (list ? childrenOf(list, 'sldId') : [])
    .map((id) => rels.get(relId(id) ?? '')?.target ?? null)
    .filter((part): part is string => part !== null)
  const metadata = coreMetadata(pkg)
  metadata.slides = slideParts.length
  const slides: Content['slides'][number][] = []
  const lines: string[] = []
  for (const [index, part] of slideParts.slice(0, LIMITS.sections).entries()) {
    const slide = pkg.xml(part)
    if (!slide)
      throw new DocumentError(
        'DOCUMENT_INVALID',
        `Slide ${String(index + 1)} is missing from the package.`
      )
    let title = ''
    const texts: string[] = []
    for (const shape of descendants(slide, 'sp')) {
      const text = shapeText(shape)
      if (!text) continue
      const type = placeholderType(shape)
      if ((type === 'title' || type === 'ctrTitle') && !title) title = text
      else if (type !== 'sldNum' && type !== 'dt' && type !== 'ftr') texts.push(text)
    }
    for (const frame of descendants(slide, 'graphicFrame'))
      for (const cell of descendants(frame, 'tc')) {
        const text = descendants(cell, 't').map(textOf).join('')
        if (text) texts.push(text)
      }
    let notes = ''
    const notesPart = pkg.relationshipsOfType(part, '/notesSlide')[0]?.target
    const notesXml = notesPart ? pkg.xml(notesPart) : null
    if (notesXml)
      notes = descendants(notesXml, 'sp')
        .filter((shape) => placeholderType(shape) === 'body')
        .map(shapeText)
        .filter(Boolean)
        .join('\n')
    const images = descendants(slide, 'pic').length
    slides.push({
      number: index + 1,
      title: title.slice(0, 300),
      text: texts.join('\n').slice(0, MAX_PAGE_TEXT),
      notes: notes.slice(0, 5_000),
      images
    })
    lines.push([title, ...texts].filter(Boolean).join('\n'))
  }
  const headings = slides.map((slide) => slide.title).filter(Boolean)
  return finish('pptx', lines.join('\n\n').trim(), maxChars, metadata, { slides, headings })
}

/** A1-style column letters as a 0-based index. */
export function columnIndex(reference: string): number {
  const letters = /^\$?([A-Z]{1,3})/.exec(reference.toUpperCase())?.[1] ?? 'A'
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function readXlsx(bytes: Uint8Array, maxChars: number): Content {
  const pkg = openPackage(bytes, 'xlsx')
  const main = officeDocumentPart(pkg, 'xlsx')
  const workbook = pkg.xml(main)
  if (!workbook) throw new DocumentError('DOCUMENT_INVALID', 'The XLSX package has no workbook.')
  const rels = new Map(pkg.relationships(main).map((rel) => [rel.id, rel]))
  const sharedPart = pkg.relationshipsOfType(main, '/sharedStrings')[0]?.target
  const sharedXml = sharedPart ? pkg.xml(sharedPart) : null
  const shared = sharedXml
    ? // Plain text, or rich-text runs; phonetic guides (rPh) are not part of the value.
      childrenOf(sharedXml, 'si').map((item) =>
        [...childrenOf(item, 't'), ...childrenOf(item, 'r').flatMap((run) => childrenOf(run, 't'))]
          .map(textOf)
          .join('')
      )
    : []
  const sheetsList = childOf(workbook, 'sheets')
  const entries = sheetsList ? childrenOf(sheetsList, 'sheet') : []
  const metadata = coreMetadata(pkg)
  metadata.sheets = entries.length
  const sheets: Content['sheets'][number][] = []
  const lines: string[] = []
  for (const entry of entries.slice(0, 50)) {
    const name = attr(entry, 'name') ?? ''
    const part = rels.get(relId(entry) ?? '')?.target
    const sheet = part ? pkg.xml(part) : null
    if (!sheet)
      throw new DocumentError(
        'DOCUMENT_INVALID',
        `The sheet "${name}" is missing from the package.`
      )
    const data = childOf(sheet, 'sheetData')
    const grid: string[][] = []
    let rowCount = 0
    let columnCount = 0
    let formulas = 0
    for (const row of data ? childrenOf(data, 'row') : []) {
      const rowNumber = Number(attr(row, 'r') ?? rowCount + 1)
      rowCount = Math.max(rowCount, rowNumber)
      let nextColumn = 0
      for (const cell of childrenOf(row, 'c')) {
        const reference = attr(cell, 'r')
        const column = reference ? columnIndex(reference) : nextColumn
        nextColumn = column + 1
        columnCount = Math.max(columnCount, column + 1)
        if (childOf(cell, 'f')) formulas += 1
        const type = attr(cell, 't') ?? 'n'
        const v = childOf(cell, 'v')
        const raw = v ? textOf(v) : ''
        let value: string
        if (type === 's') value = shared[Number(raw)] ?? ''
        else if (type === 'inlineStr')
          value = descendants(childOf(cell, 'is') ?? cell, 't')
            .map(textOf)
            .join('')
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE'
        else value = raw
        if (rowNumber <= 200 && column < 50) {
          while (grid.length < rowNumber) grid.push([])
          const target = grid[rowNumber - 1] ?? []
          while (target.length < column) target.push('')
          target[column] = value.slice(0, MAX_CELL)
        }
      }
    }
    sheets.push({
      name: name.slice(0, 100),
      rows: rowCount,
      columns: columnCount,
      cells: grid,
      formulas
    })
    lines.push(`# ${name}`, ...grid.map((row) => row.join('\t')))
  }
  return finish('xlsx', lines.join('\n').trim(), maxChars, metadata, {
    sheets,
    headings: sheets.map((sheet) => sheet.name)
  })
}

export async function readDocument(
  bytes: Uint8Array,
  format: DocumentFormat,
  maxChars: number
): Promise<Content> {
  if (bytes.length > LIMITS.fileBytes)
    throw new DocumentError(
      'DOCUMENT_TOO_LARGE',
      'The file is larger than 100 MB; it was not read.'
    )
  if (bytes.length === 0) throw new DocumentError('DOCUMENT_EMPTY', 'The file is empty.')
  try {
    switch (format) {
      case 'txt':
      case 'md':
        return readText(bytes, format, maxChars)
      case 'csv':
        return readCsv(bytes, maxChars)
      case 'json':
        return readJson(bytes, maxChars)
      case 'pdf':
        return await readPdf(bytes, maxChars)
      case 'docx':
        return readDocx(bytes, maxChars)
      case 'pptx':
        return readPptx(bytes, maxChars)
      case 'xlsx':
        return readXlsx(bytes, maxChars)
    }
  } catch (error) {
    if (error instanceof XmlError)
      throw new DocumentError(
        'DOCUMENT_INVALID',
        `The ${format.toUpperCase()} document is damaged: ${error.message}`
      )
    throw error
  }
}
