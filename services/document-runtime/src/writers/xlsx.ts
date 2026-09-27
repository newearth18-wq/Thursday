import type { CellValue, SheetSpec } from '@jupiter/contracts'
import { DocumentError, writePackage } from '../package'
import { escapeXml } from '../xml'
import {
  NS,
  TYPE,
  XML_HEADER,
  appProperties,
  contentTypes,
  coreProperties,
  packageRels,
  relationships
} from './common'

/**
 * A SpreadsheetML workbook (SET 10). Every cell is written as its column's
 * type, checked first: numbers must be numbers, dates ISO dates, booleans
 * booleans. Only `formula` columns hold formulas, and only formulas made of
 * allowed functions, cell references, numbers and operators — no external
 * references, no other sheets' links, no strings. Text is always text: a
 * text cell that starts with = + - or @ is stored as a string and never
 * becomes a formula.
 */

const WORKBOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const WORKSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const STYLES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'

export const ALLOWED_FUNCTIONS = [
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'ROUND',
  'ABS',
  'IF',
  'AND',
  'OR',
  'NOT',
  'MEDIAN'
] as const

const TOKEN =
  /\s*(?:(\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?)(?![A-Z0-9(])|([A-Z][A-Z0-9.]*)\s*(?=\()|(\d+(?:\.\d+)?(?:E[+-]?\d+)?)|(<=|>=|<>|[-+*/^&=<>(),%]))/iy

/** Why a formula is not allowed, or null. `formula` starts with "=". */
export function formulaIssue(formula: string): string | null {
  if (!formula.startsWith('=')) return 'A formula must start with "=".'
  const body = formula.slice(1)
  if (body.trim() === '') return 'The formula is empty.'
  if (body.length > 1_000) return 'The formula is longer than 1,000 characters.'
  let depth = 0
  TOKEN.lastIndex = 0
  let position = 0
  while (position < body.length) {
    if (/^\s*$/.test(body.slice(position))) break
    TOKEN.lastIndex = position
    const match = TOKEN.exec(body)
    if (!match)
      return `The formula has something that is not allowed at "${body.slice(position, position + 12)}".`
    const name = match[2]
    if (
      name !== undefined &&
      !(ALLOWED_FUNCTIONS as readonly string[]).includes(name.toUpperCase())
    )
      return `The function ${name.toUpperCase()} is not allowed; allowed: ${ALLOWED_FUNCTIONS.join(', ')}.`
    if (match[4] === '(') depth += 1
    if (match[4] === ')') depth -= 1
    if (depth < 0) return 'The formula closes a bracket it did not open.'
    position = TOKEN.lastIndex
  }
  if (depth !== 0) return 'The formula leaves a bracket open.'
  return null
}

/** A1-style column letters for a 0-based index. */
export function columnLetters(index: number): string {
  let letters = ''
  let rest = index + 1
  while (rest > 0) {
    const remainder = (rest - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    rest = Math.floor((rest - 1) / 26)
  }
  return letters
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/

/** An ISO date as a spreadsheet serial number (days since 1899-12-30). */
export function dateSerial(value: string): number | null {
  const match = DATE.exec(value)
  if (!match) return null
  const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match
  const time = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
  if (Number.isNaN(time)) return null
  const check = new Date(time)
  if (check.getUTCMonth() !== Number(m) - 1 || check.getUTCDate() !== Number(d)) return null
  return (time - Date.UTC(1899, 11, 30)) / 86_400_000
}

type ColumnType = SheetSpec['columns'][number]['type']

function cell(reference: string, value: CellValue, type: ColumnType, where: string): string {
  if (value === null || value === '') return ''
  const fail = (message: string): never => {
    throw new DocumentError('DOCUMENT_SPEC_INVALID', `${where}: ${message}`)
  }
  switch (type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return fail(`"${String(value)}" is not a number.`)
      return `<c r="${reference}"><v>${String(value)}</v></c>`
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return fail(`"${String(value)}" is not TRUE or FALSE.`)
      return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`
    }
    case 'date': {
      const serial = typeof value === 'string' ? dateSerial(value) : null
      if (serial === null) return fail(`"${String(value)}" is not a date (YYYY-MM-DD).`)
      return `<c r="${reference}" s="2"><v>${String(serial)}</v></c>`
    }
    case 'formula': {
      if (typeof value !== 'string') return fail(`"${String(value)}" is not a formula.`)
      const issue = formulaIssue(value)
      if (issue) return fail(issue)
      return `<c r="${reference}"><f>${escapeXml(value.slice(1))}</f></c>`
    }
    case 'text':
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`
  }
}

function sheetXml(sheet: SheetSpec): string {
  const columns = sheet.columns.length
  const rows: string[] = []
  rows.push(
    `<row r="1">${sheet.columns
      .map(
        (column, index) =>
          `<c r="${columnLetters(index)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(column.header)}</t></is></c>`
      )
      .join('')}</row>`
  )
  for (const [rowIndex, row] of sheet.rows.entries()) {
    if (row.length > columns)
      throw new DocumentError(
        'DOCUMENT_SPEC_INVALID',
        `Sheet "${sheet.name}", row ${String(rowIndex + 2)}: ${String(row.length)} cells for ${String(columns)} columns.`
      )
    const number = rowIndex + 2
    rows.push(
      `<row r="${String(number)}">${row
        .map((value, column) =>
          cell(
            `${columnLetters(column)}${String(number)}`,
            value,
            sheet.columns[column]?.type ?? 'text',
            `Sheet "${sheet.name}", cell ${columnLetters(column)}${String(number)}`
          )
        )
        .join('')}</row>`
    )
  }
  const last = `${columnLetters(columns - 1)}${String(sheet.rows.length + 1)}`
  const widths = sheet.columns
    .map(
      (column, index) =>
        `<col min="${String(index + 1)}" max="${String(index + 1)}" width="${String(Math.min(60, Math.max(10, column.header.length + 4)))}" customWidth="1"/>`
    )
    .join('')
  return `${XML_HEADER}<worksheet xmlns="${NS.x}" xmlns:r="${NS.r}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${rows.join('')}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
}

const STYLES_XML = `${XML_HEADER}<styleSheet xmlns="${NS.x}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

export function writeXlsx(
  spec: { title: string; author: string; sheets: readonly SheetSpec[] },
  now: Date
): Uint8Array {
  const names = new Set<string>()
  for (const sheet of spec.sheets) {
    const key = sheet.name.toLowerCase()
    if (names.has(key))
      throw new DocumentError('DOCUMENT_SPEC_INVALID', `Two sheets are named "${sheet.name}".`)
    names.add(key)
  }
  const parts: Record<string, string> = {}
  const overrides: Record<string, string> = {
    'xl/workbook.xml': WORKBOOK,
    'xl/styles.xml': STYLES,
    'docProps/core.xml': TYPE.core,
    'docProps/app.xml': TYPE.app
  }
  const rels = spec.sheets.map((_, index) => ({
    id: `rId${String(index + 1)}`,
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
    target: `worksheets/sheet${String(index + 1)}.xml`
  }))
  for (const [index, sheet] of spec.sheets.entries()) {
    parts[`xl/worksheets/sheet${String(index + 1)}.xml`] = sheetXml(sheet)
    overrides[`xl/worksheets/sheet${String(index + 1)}.xml`] = WORKSHEET
  }
  const workbook = `${XML_HEADER}<workbook xmlns="${NS.x}" xmlns:r="${NS.r}"><bookViews><workbookView/></bookViews><sheets>${spec.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`
    )
    .join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`
  return writePackage({
    '[Content_Types].xml': contentTypes(overrides),
    '_rels/.rels': packageRels('xl/workbook.xml'),
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': relationships([
      ...rels,
      {
        id: `rId${String(rels.length + 1)}`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
        target: 'styles.xml'
      }
    ]),
    'xl/styles.xml': STYLES_XML,
    ...parts,
    'docProps/core.xml': coreProperties(spec.title, spec.author, now),
    'docProps/app.xml': appProperties()
  })
}
