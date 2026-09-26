import {
  CREDENTIAL_ASSIGNMENT,
  SECRET_PATTERNS,
  isPlaceholderValue,
  isSensitiveKey
} from './secret-patterns'

/**
 * Redaction for anything that is about to be logged, persisted as a
 * diagnostic, or shown in an error.
 *
 * Two independent layers:
 *  1. structural — values under credential-named keys are always replaced;
 *  2. textual — credential formats are replaced wherever they appear in text.
 *
 * Redaction happens before truncation, so a secret is never half-shown
 * because a length limit cut through it.
 */

export const REDACTED = '[REDACTED]'

export interface RedactOptions {
  /** Nesting depth kept before a value is summarised. Default 6. */
  readonly maxDepth?: number
  /** Longest string kept, after redaction. Default 2000. */
  readonly maxStringLength?: number
  /** Array elements kept. Default 50. */
  readonly maxArrayLength?: number
  /** Object keys kept. Default 50. */
  readonly maxKeys?: number
}

const DEFAULTS: Required<RedactOptions> = {
  maxDepth: 6,
  maxStringLength: 2000,
  maxArrayLength: 50,
  maxKeys: 50
}

/** Hard ceiling on how much text the patterns ever scan. */
const SCAN_LIMIT = 65_536

export function redactString(input: string, maxLength = DEFAULTS.maxStringLength): string {
  let text = input.length > SCAN_LIMIT ? input.slice(0, SCAN_LIMIT) : input
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern.regex, `[REDACTED:${pattern.id}]`)
  }
  text = text.replace(CREDENTIAL_ASSIGNMENT.regex, (whole, ...args: unknown[]) => {
    const groups = args.at(-1) as { prefix?: string; quote?: string; value?: string } | undefined
    const value = groups?.value ?? ''
    if (isPlaceholderValue(value)) return whole
    const quote = groups?.quote ?? '"'
    return `${groups?.prefix ?? ''}${quote}${REDACTED}${quote}`
  })
  if (text.length > maxLength) {
    const dropped = text.length - maxLength
    text = `${text.slice(0, maxLength)}… [truncated ${String(dropped)} chars]`
  }
  return text
}

function isBinary(value: object): value is ArrayBufferView | ArrayBuffer {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer
}

function redactError(
  error: Error,
  options: Required<RedactOptions>,
  depth: number,
  seen: WeakSet<object>
) {
  const result: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message, options.maxStringLength)
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') result.code = code
  if (typeof error.stack === 'string') {
    result.stack = redactString(
      error.stack.split('\n').slice(0, 12).join('\n'),
      options.maxStringLength
    )
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined) result.cause = walk(cause, options, depth + 1, seen)
  return result
}

function walk(
  value: unknown,
  options: Required<RedactOptions>,
  depth: number,
  seen: WeakSet<object>
): unknown {
  switch (typeof value) {
    case 'string':
      return redactString(value, options.maxStringLength)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
    case 'undefined':
      return value
    case 'bigint':
      return `${value.toString()}n`
    case 'symbol':
      return '[Symbol]'
    case 'function':
      return '[Function]'
    case 'object':
      break
  }
  if (value === null) return null
  const object = value
  if (seen.has(object)) return '[Circular]'
  if (depth >= options.maxDepth) return '[MaxDepth]'
  if (isBinary(object)) return `[Binary ${String(object.byteLength)} bytes]`
  if (object instanceof Date)
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString()

  seen.add(object)
  try {
    if (object instanceof Error) return redactError(object, options, depth, seen)
    if (Array.isArray(object)) {
      const items = object
        .slice(0, options.maxArrayLength)
        .map((item: unknown) => walk(item, options, depth + 1, seen))
      if (object.length > options.maxArrayLength) {
        items.push(`[${String(object.length - options.maxArrayLength)} more items]`)
      }
      return items
    }
    if (object instanceof Map) {
      return walk(Object.fromEntries(object), options, depth + 1, seen)
    }
    if (object instanceof Set) {
      return walk([...object], options, depth + 1, seen)
    }
    const entries = Object.entries(object)
    const result: Record<string, unknown> = {}
    for (const [key, entry] of entries.slice(0, options.maxKeys)) {
      result[key] = isSensitiveKey(key) ? REDACTED : walk(entry, options, depth + 1, seen)
    }
    if (entries.length > options.maxKeys) {
      result['…'] = `[${String(entries.length - options.maxKeys)} more keys]`
    }
    return result
  } finally {
    seen.delete(object)
  }
}

/** Return a JSON-safe, redacted copy of `value`. The input is never modified. */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  return walk(value, { ...DEFAULTS, ...options }, 0, new WeakSet())
}
