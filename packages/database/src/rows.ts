/** Typed accessors for node:sqlite result rows, which are loosely typed. */
type Row = Record<string, unknown>

export function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Column ${key} is not text`)
  return value
}

export function nullableText(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Column ${key} is not text`)
  return value
}

export function integer(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(`Column ${key} is not an integer`)
  return value
}

export function nullableNumber(row: Row, key: string): number | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'number') throw new Error(`Column ${key} is not a number`)
  return value
}

export function json(row: Row, key: string): unknown {
  return JSON.parse(text(row, key))
}
