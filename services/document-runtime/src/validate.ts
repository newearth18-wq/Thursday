import type { DocumentContent, DocumentFormat, DocumentSpec, FileCheck } from '@jupiter/contracts'
import { contentTypeOf, DocumentError, openPackage, type Package } from './package'
import { parseCsv, readDocument } from './readers'
import { neutralizeFormula } from './writers/text'
import { dateSerial } from './writers/xlsx'
import { childOf, childrenOf, relId } from './xml'

/**
 * Checking a document (SET 10), as another program would open it: the
 * package and its parts, then — when the spec it was written from is known
 * — its content, compared with what was asked for. Every check is reported
 * with what it found; a file is valid only when all of them pass.
 */

const MAIN_TYPES: Partial<Record<DocumentFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
}

class Checks {
  readonly list: FileCheck[] = []
  add(check: string, passed: boolean, detail: string): boolean {
    if (this.list.length < 40) this.list.push({ check, passed, detail: detail.slice(0, 500) })
    // Past the limit, a failure still makes the file invalid.
    else if (!passed)
      this.list[39] = { check: 'more', passed: false, detail: 'More checks failed.' }
    return passed
  }
  get valid(): boolean {
    return this.list.length > 0 && this.list.every((check) => check.passed)
  }
}

const squash = (text: string) => text.replace(/\s+/g, '')

function structure(pkg: Package, format: 'docx' | 'pptx' | 'xlsx', checks: Checks): boolean {
  const parts = pkg.names.filter((name) => !name.endsWith('/'))
  const types = pkg.xml('[Content_Types].xml')
  if (
    !checks.add(
      'content-types',
      types !== null,
      types ? 'Present.' : 'There is no [Content_Types].xml.'
    )
  )
    return false
  const untyped = parts.filter(
    (name) => name !== '[Content_Types].xml' && contentTypeOf(pkg, name) === null
  )
  checks.add(
    'content-types-complete',
    untyped.length === 0,
    untyped.length
      ? `No content type for: ${untyped.slice(0, 5).join(', ')}.`
      : `Every one of ${String(parts.length - 1)} parts has a content type.`
  )
  const broken: string[] = []
  for (const name of parts)
    if (name.endsWith('.xml') || name.endsWith('.rels'))
      try {
        pkg.xml(name)
      } catch (error) {
        broken.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
      }
  checks.add(
    'xml-well-formed',
    broken.length === 0,
    broken.length
      ? `Not well-formed: ${broken.slice(0, 3).join('; ')}.`
      : 'Every XML part is well-formed.'
  )
  const missing: string[] = []
  let count = 0
  for (const name of parts.filter((part) => part.endsWith('.rels'))) {
    const source = name.replace(/_rels\/([^/]+)\.rels$/, '$1')
    for (const rel of pkg.relationships(source === '.rels' ? '' : source)) {
      if (rel.external || rel.target === null) continue
      count += 1
      if (!pkg.has(rel.target)) missing.push(`${rel.target} (from ${name})`)
    }
  }
  checks.add(
    'relationships',
    missing.length === 0,
    missing.length
      ? `Missing targets: ${missing.slice(0, 5).join(', ')}.`
      : `All ${String(count)} internal relationships resolve.`
  )
  const main = pkg.relationshipsOfType('', '/officeDocument')[0]?.target ?? null
  const type = main ? contentTypeOf(pkg, main) : null
  checks.add(
    'main-part',
    main !== null && type === MAIN_TYPES[format],
    main ? `${main}: ${type ?? 'no content type'}.` : 'There is no main document part.'
  )
  if (!main) return false
  const root = pkg.xml(main)
  if (!root) return false
  if (format === 'docx')
    checks.add('body', childOf(root, 'body') !== null, 'The document has a body.')
  if (format === 'xlsx') {
    const rels = new Map(pkg.relationships(main).map((rel) => [rel.id, rel.target]))
    const sheets = childrenOf(childOf(root, 'sheets') ?? root, 'sheet')
    const bad = sheets.filter((sheet) => {
      const target = rels.get(relId(sheet) ?? '')
      return !target || !pkg.xml(target) || !childOf(pkg.xml(target) ?? root, 'sheetData')
    })
    checks.add(
      'sheets',
      sheets.length > 0 && bad.length === 0,
      `${String(sheets.length)} sheet(s); ${String(bad.length)} without data.`
    )
  }
  if (format === 'pptx') {
    const rels = new Map(pkg.relationships(main).map((rel) => [rel.id, rel.target]))
    const ids = childrenOf(childOf(root, 'sldIdLst') ?? root, 'sldId')
    const problems: string[] = []
    for (const [index, id] of ids.entries()) {
      const slide = rels.get(relId(id) ?? '')
      if (!slide || !pkg.xml(slide)) {
        problems.push(`slide ${String(index + 1)} is missing`)
        continue
      }
      const layout = pkg.relationshipsOfType(slide, '/slideLayout')[0]?.target
      if (!layout || !pkg.has(layout)) problems.push(`slide ${String(index + 1)} has no layout`)
      else if (!pkg.relationshipsOfType(layout, '/slideMaster')[0]?.target)
        problems.push(`the layout of slide ${String(index + 1)} has no master`)
      const notes = pkg.relationshipsOfType(slide, '/notesSlide')[0]?.target
      if (notes && !pkg.relationshipsOfType(notes, '/notesMaster')[0]?.target)
        problems.push(`the notes of slide ${String(index + 1)} have no notes master`)
    }
    checks.add(
      'slides',
      ids.length > 0 && problems.length === 0,
      problems.length
        ? problems.slice(0, 5).join('; ')
        : `${String(ids.length)} slide(s), each with its layout and master.`
    )
  }
  return true
}

function compareContent(
  spec: DocumentSpec,
  content: DocumentContent,
  bytes: Uint8Array,
  checks: Checks
): void {
  switch (spec.format) {
    case 'txt':
    case 'md': {
      const same =
        content.text === spec.text.replace(/\r\n?/g, '\n') ||
        (content.truncated && spec.text.startsWith(content.text))
      checks.add(
        'content',
        same,
        same
          ? `The text (${String(content.characters)} characters) is as written.`
          : 'The text differs from what was written.'
      )
      return
    }
    case 'json': {
      const same = content.text === JSON.stringify(spec.value, null, 2)
      checks.add(
        'content',
        same,
        same ? 'The JSON value is as written.' : 'The JSON value differs from what was written.'
      )
      return
    }
    case 'csv': {
      const rows = parseCsv(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''))
      const expected = [
        spec.headers,
        ...spec.rows.map((row) =>
          row.map((cell) =>
            cell === null ? '' : typeof cell === 'string' ? neutralizeFormula(cell) : String(cell)
          )
        )
      ]
      const same = JSON.stringify(rows) === JSON.stringify(expected)
      checks.add(
        'content',
        same,
        same
          ? `${String(spec.rows.length)} row(s) and the header, as written; text that could start a formula is escaped.`
          : 'The rows differ from what was written.'
      )
      return
    }
    case 'docx':
    case 'pdf': {
      checks.add(
        'title',
        spec.format === 'pdf' || content.metadata.title === spec.title.trim(),
        `Title: "${content.metadata.title ?? ''}".`
      )
      const text = squash(content.text)
      let from = 0
      const missing: string[] = []
      const expected = [
        spec.title,
        ...spec.blocks.flatMap((block) =>
          block.type === 'table' ? block.rows.flat() : [block.text]
        )
      ].filter((value) => value.trim())
      for (const piece of expected) {
        const at = text.indexOf(squash(piece), from)
        if (at === -1) missing.push(piece.slice(0, 60))
        else from = at + squash(piece).length
      }
      checks.add(
        'content',
        missing.length === 0,
        missing.length
          ? `Not found in order: ${missing
              .slice(0, 3)
              .map((piece) => `"${piece}"`)
              .join(', ')}.`
          : `All ${String(expected.length)} pieces of text are there, in order.`
      )
      if (spec.format === 'pdf')
        checks.add(
          'pages',
          (content.metadata.pages ?? 0) > 0,
          `${String(content.metadata.pages ?? 0)} page(s).`
        )
      else {
        const headings = spec.blocks.filter((block) => block.type === 'heading').length + 1
        checks.add(
          'headings',
          content.headings.length === headings,
          `${String(content.headings.length)} of ${String(headings)} headings (with the title) are styled as headings.`
        )
      }
      return
    }
    case 'pptx': {
      checks.add(
        'slide-count',
        content.slides.length === spec.slides.length,
        `${String(content.slides.length)} of ${String(spec.slides.length)} slides.`
      )
      for (const [index, slide] of spec.slides.entries()) {
        const got = content.slides[index]
        const bullets = slide.bullets.length
          ? slide.bullets
          : slide.subtitle
            ? slide.subtitle.split('\n')
            : []
        const problems: string[] = []
        if (!got) problems.push('missing')
        else {
          if (got.title !== slide.title.trim()) problems.push(`title "${got.title}"`)
          if (squash(got.text) !== squash(bullets.join(''))) problems.push('text differs')
          if (squash(got.notes) !== squash(slide.notes)) problems.push('notes differ')
          if (got.images !== (slide.image ? 1 : 0)) problems.push(`${String(got.images)} image(s)`)
        }
        checks.add(
          `slide-${String(index + 1)}`,
          problems.length === 0,
          problems.length
            ? `Slide ${String(index + 1)}: ${problems.join(', ')}.`
            : `Slide ${String(index + 1)} (${slide.layout} layout): title, text, notes${slide.image ? ' and image' : ''} as written.`
        )
      }
      return
    }
    case 'xlsx': {
      const names = content.sheets.map((sheet) => sheet.name)
      checks.add(
        'sheet-names',
        JSON.stringify(names) === JSON.stringify(spec.sheets.map((sheet) => sheet.name)),
        `Sheets: ${names.join(', ')}.`
      )
      for (const [index, sheet] of spec.sheets.entries()) {
        const got = content.sheets[index]
        const problems: string[] = []
        if (!got) problems.push('missing')
        else {
          const header = got.cells[0] ?? []
          if (
            JSON.stringify(header) !== JSON.stringify(sheet.columns.map((column) => column.header))
          )
            problems.push('the header row differs')
          for (const [r, row] of sheet.rows.slice(0, 199).entries())
            for (const [c, value] of row.entries()) {
              if (c >= 50) continue
              const type = sheet.columns[c]?.type ?? 'text'
              const cell = got.cells[r + 1]?.[c] ?? ''
              if (type === 'formula') continue
              const expected =
                value === null
                  ? ''
                  : type === 'boolean'
                    ? value
                      ? 'TRUE'
                      : 'FALSE'
                    : type === 'date' && typeof value === 'string'
                      ? String(dateSerial(value))
                      : String(value)
              if (cell !== expected && problems.length < 3)
                problems.push(
                  `cell ${String.fromCharCode(65 + (c % 26))}${String(r + 2)} is "${cell}", not "${expected}"`
                )
            }
          const written = sheet.rows.reduce(
            (sum, row) =>
              sum +
              row.filter(
                (value, c) => sheet.columns[c]?.type === 'formula' && value !== null && value !== ''
              ).length,
            0
          )
          if (got.formulas !== written)
            problems.push(`${String(got.formulas)} formula(s), not ${String(written)}`)
          if (got.rows !== sheet.rows.length + 1)
            problems.push(`${String(got.rows)} rows, not ${String(sheet.rows.length + 1)}`)
        }
        checks.add(
          `sheet-${String(index + 1)}`,
          problems.length === 0,
          problems.length
            ? `Sheet "${sheet.name}": ${problems.join('; ')}.`
            : `Sheet "${sheet.name}": header, ${String(sheet.rows.length)} typed row(s) and formulas as written.`
        )
      }
      return
    }
  }
}

export async function validateDocument(
  bytes: Uint8Array,
  format: DocumentFormat,
  spec: DocumentSpec | null
): Promise<{ valid: boolean; checks: FileCheck[] }> {
  const checks = new Checks()
  checks.add('non-empty', bytes.length > 0, `${String(bytes.length)} bytes.`)
  if (format === 'docx' || format === 'pptx' || format === 'xlsx') {
    let pkg: Package
    try {
      pkg = openPackage(bytes, format)
      checks.add('package', true, `A ZIP package of ${String(pkg.names.length)} parts.`)
    } catch (error) {
      checks.add('package', false, error instanceof Error ? error.message : String(error))
      return { valid: false, checks: checks.list }
    }
    if (!structure(pkg, format, checks)) return { valid: false, checks: checks.list }
  }
  let content: DocumentContent
  try {
    content = await readDocument(bytes, format, 200_000)
    checks.add(
      'opens',
      true,
      `Opens as ${format.toUpperCase()}${content.metadata.pages ? ` (${String(content.metadata.pages)} page(s))` : ''}.`
    )
  } catch (error) {
    checks.add(
      'opens',
      false,
      error instanceof DocumentError || error instanceof Error ? error.message : String(error)
    )
    return { valid: false, checks: checks.list }
  }
  if (spec) {
    if (spec.format !== format)
      checks.add('format', false, `Written as ${spec.format}, checked as ${format}.`)
    else compareContent(spec, content, bytes, checks)
  }
  return { valid: checks.valid, checks: checks.list }
}
