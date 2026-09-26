import type { SkillSchema, ValueSummary } from '@jupiter/contracts'

/**
 * Validation for the JSON Schema subset Skills use (SET 6). Small on
 * purpose: the subset is what `SkillSchema` allows, and every keyword it
 * allows is enforced here.
 */

const MAX_DEPTH = 8
const MAX_ISSUES = 20

export interface SchemaIssue {
  readonly path: string
  readonly message: string
}

/** Problems with a schema itself (beyond its shape, which the contract checks). */
export function schemaDefinitionIssues(schema: SkillSchema, path = '$', depth = 0): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  if (depth > MAX_DEPTH)
    return [{ path, message: `nested deeper than ${String(MAX_DEPTH)} levels` }]
  const numeric = schema.type === 'number' || schema.type === 'integer'
  if (schema.properties && schema.type !== 'object')
    issues.push({ path, message: '"properties" is only allowed on objects' })
  if (schema.items && schema.type !== 'array')
    issues.push({ path, message: '"items" is only allowed on arrays' })
  if (schema.type === 'array' && !schema.items)
    issues.push({ path, message: 'an array needs "items"' })
  if (
    (schema.minLength !== undefined || schema.maxLength !== undefined) &&
    schema.type !== 'string'
  )
    issues.push({ path, message: 'length limits are only allowed on strings' })
  if ((schema.minimum !== undefined || schema.maximum !== undefined) && !numeric)
    issues.push({ path, message: 'minimum/maximum are only allowed on numbers' })
  if (
    schema.minLength !== undefined &&
    schema.maxLength !== undefined &&
    schema.minLength > schema.maxLength
  )
    issues.push({ path, message: 'minLength is greater than maxLength' })
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  )
    issues.push({ path, message: 'minimum is greater than maximum' })
  for (const name of schema.required ?? [])
    if (!schema.properties || !(name in schema.properties))
      issues.push({ path, message: `required field "${name}" is not in "properties"` })
  for (const [name, child] of Object.entries(schema.properties ?? {}))
    issues.push(...schemaDefinitionIssues(child, `${path}.${name}`, depth + 1))
  if (schema.items) issues.push(...schemaDefinitionIssues(schema.items, `${path}[]`, depth + 1))
  return issues.slice(0, MAX_ISSUES)
}

/** Why `value` does not match `schema`; empty when it does. */
export function validateValue(schema: SkillSchema, value: unknown, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  check(schema, value, path, issues, 0)
  return issues.slice(0, MAX_ISSUES)
}

function check(
  schema: SkillSchema,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  depth: number
): void {
  if (issues.length >= MAX_ISSUES) return
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: 'nested too deeply' })
    return
  }
  const fail = (message: string) => {
    issues.push({ path, message })
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        fail('expected a string')
        return
      }
      if (schema.minLength !== undefined && value.length < schema.minLength)
        fail(`shorter than ${String(schema.minLength)} characters`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        fail(`longer than ${String(schema.maxLength)} characters`)
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('expected a number')
        return
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) fail('expected a whole number')
      if (schema.minimum !== undefined && value < schema.minimum)
        fail(`less than ${String(schema.minimum)}`)
      if (schema.maximum !== undefined && value > schema.maximum)
        fail(`greater than ${String(schema.maximum)}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') {
        fail('expected true or false')
        return
      }
      break
    case 'array':
      if (!Array.isArray(value)) {
        fail('expected a list')
        return
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        fail(`more than ${String(schema.maxItems)} items`)
      if (schema.items) {
        const items = schema.items
        value.forEach((item: unknown, index) => {
          check(items, item, `${path}[${String(index)}]`, issues, depth + 1)
        })
      }
      break
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('expected an object')
        return
      }
      const record = value as Record<string, unknown>
      const properties = schema.properties ?? {}
      for (const name of schema.required ?? [])
        if (!(name in record) || record[name] === undefined)
          issues.push({ path: `${path}.${name}`, message: 'is required' })
      for (const [name, field] of Object.entries(record)) {
        const child = properties[name]
        if (child) check(child, field, `${path}.${name}`, issues, depth + 1)
        else if (schema.additionalProperties === false)
          issues.push({ path: `${path}.${name}`, message: 'is not a declared field' })
      }
      break
    }
  }
  if (schema.enum && !schema.enum.includes(value as string | number))
    fail(`must be one of ${schema.enum.map(String).join(', ')}`)
}

/** Shape and size of a value, never its content. */
export function summarize(value: unknown): ValueSummary {
  if (value === null || value === undefined) return { type: 'null', size: null, fields: [] }
  if (typeof value === 'string') return { type: 'string', size: value.length, fields: [] }
  if (typeof value === 'number') return { type: 'number', size: null, fields: [] }
  if (typeof value === 'boolean') return { type: 'boolean', size: null, fields: [] }
  if (Array.isArray(value)) return { type: 'array', size: value.length, fields: [] }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return {
      type: 'object',
      size: keys.length,
      fields: keys.filter((key) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)).slice(0, 32)
    }
  }
  return { type: 'other', size: null, fields: [] }
}

export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
}
