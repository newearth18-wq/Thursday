import type { CellValue } from '@jupiter/contracts'

/**
 * Plain-text formats (SET 10): TXT and Markdown as given (UTF-8, LF line
 * ends), JSON pretty-printed, and CSV (RFC 4180, UTF-8 with a BOM so that
 * spreadsheet programs read the encoding right).
 *
 * CSV is where formula injection happens: a spreadsheet program runs a
 * field that starts with = + - @ or a tab/return as a formula. Text fields
 * that start that way are written with a leading apostrophe, so they stay
 * text. Numbers are written as numbers.
 */

const encoder = new TextEncoder()
const BOM = String.fromCharCode(0xfeff)

export function writeText(text: string): Uint8Array {
  return encoder.encode(text.replace(/\r\n?/g, '\n'))
}

export function writeJson(value: unknown): Uint8Array {
  const text = JSON.stringify(value, null, 2) as string | undefined
  if (text === undefined) throw new Error('The value cannot be written as JSON.')
  return encoder.encode(`${text}\n`)
}

/** A text field made safe for spreadsheet programs (no formula can start). */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

function field(value: CellValue): string {
  if (value === null) return ''
  const text = typeof value === 'string' ? neutralizeFormula(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function writeCsv(
  headers: readonly string[],
  rows: readonly (readonly CellValue[])[]
): Uint8Array {
  const lines = [headers.map(field).join(','), ...rows.map((row) => row.map(field).join(','))]
  return encoder.encode(`${BOM}${lines.join('\r\n')}\r\n`)
}
