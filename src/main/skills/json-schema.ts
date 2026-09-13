/**
 * Minimal JSON Schema validator.
 *
 * Deliberately supports only the subset a skill input object actually needs:
 * object/string/number/integer/boolean/array, `required`, `enum`, `minimum`,
 * `maximum`, `minLength`, `maxLength` and nested `properties`/`items`.
 * Anything it does not understand is allowed through rather than silently
 * rejected, so an unusual-but-valid schema never blocks a working skill.
 */

export interface ValidationIssue {
  path: string
  message: string
}

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = 'input'
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const type = schema.type

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    issues.push({
      path,
      message: `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`
    })
    return issues
  }

  if (typeof type === 'string' && !matchesType(value, type)) {
    issues.push({ path, message: `must be a ${type}, received ${describe(value)}` })
    return issues
  }

  if (type === 'string' && typeof value === 'string') {
    const min = schema.minLength
    const max = schema.maxLength
    if (typeof min === 'number' && value.length < min) {
      issues.push({ path, message: `must be at least ${min} character${min === 1 ? '' : 's'}` })
    }
    if (typeof max === 'number' && value.length > max) {
      issues.push({ path, message: `must be at most ${max} characters` })
    }
  }

  if ((type === 'number' || type === 'integer') && typeof value === 'number') {
    const min = schema.minimum
    const max = schema.maximum
    if (typeof min === 'number' && value < min) issues.push({ path, message: `must be >= ${min}` })
    if (typeof max === 'number' && value > max) issues.push({ path, message: `must be <= ${max}` })
  }

  if (type === 'object' || (type === undefined && isPlainObject(value) && schema.properties)) {
    if (!isPlainObject(value)) return issues
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []

    for (const key of required) {
      if (typeof key === 'string' && value[key] === undefined) {
        issues.push({ path: `${path}.${key}`, message: 'is required' })
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] === undefined || !isPlainObject(child)) continue
      issues.push(...validateAgainstSchema(value[key], child, `${path}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({ path: `${path}.${key}`, message: 'is not an accepted property' })
        }
      }
    }
  }

  if (type === 'array' && Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((entry, index) => {
      issues.push(...validateAgainstSchema(entry, schema.items as Record<string, unknown>, `${path}[${index}]`))
    })
  }

  return issues
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}
