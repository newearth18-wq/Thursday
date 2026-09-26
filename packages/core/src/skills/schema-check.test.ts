import type { SkillSchema } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { schemaDefinitionIssues, summarize, validateValue } from './schema-check'

/** The JSON Schema subset Skills use (SET 6): every keyword it allows is enforced. */

const input: SkillSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 5 },
    count: { type: 'integer', minimum: 0, maximum: 3 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    flag: { type: 'boolean' }
  },
  required: ['text'],
  additionalProperties: false
}

const paths = (value: unknown) => validateValue(input, value).map((issue) => issue.path)

describe('skill schema subset', () => {
  it('accepts valid values', () => {
    expect(
      validateValue(input, { text: 'hi', count: 2, mode: 'a', tags: ['x'], flag: true })
    ).toEqual([])
  })

  it('rejects wrong types, limits, enums, missing and undeclared fields', () => {
    expect(paths({})).toEqual(['$.text'])
    expect(paths({ text: 'too long' })).toEqual(['$.text'])
    expect(paths({ text: 'a', count: 1.5 })).toEqual(['$.count'])
    expect(paths({ text: 'a', count: 9 })).toEqual(['$.count'])
    expect(paths({ text: 'a', mode: 'c' })).toEqual(['$.mode'])
    expect(paths({ text: 'a', tags: ['x', 'y', 'z'] })).toEqual(['$.tags'])
    expect(paths({ text: 'a', tags: [1] })).toEqual(['$.tags[0]'])
    expect(paths({ text: 'a', secret: 'x' })).toEqual(['$.secret'])
    expect(paths('not an object')).toEqual(['$'])
  })

  it('finds problems in schema definitions', () => {
    expect(
      schemaDefinitionIssues({
        type: 'object',
        properties: { a: { type: 'string', minimum: 1 } },
        required: ['b']
      }).map((issue) => issue.message)
    ).toEqual([
      'required field "b" is not in "properties"',
      'minimum/maximum are only allowed on numbers'
    ])
    expect(schemaDefinitionIssues({ type: 'array' })[0]?.message).toBe('an array needs "items"')
  })

  it('summarizes shape and size, never content', () => {
    expect(summarize({ password: 'hunter2', text: 'x' })).toEqual({
      type: 'object',
      size: 2,
      fields: ['password', 'text']
    })
    expect(JSON.stringify(summarize({ password: 'hunter2' }))).not.toContain('hunter2')
    expect(summarize('secret value')).toEqual({ type: 'string', size: 12, fields: [] })
  })
})
