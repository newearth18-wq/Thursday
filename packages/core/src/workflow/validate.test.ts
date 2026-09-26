import type { PlanDraft, PlanStep } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { stepTypeInfo } from './catalogue'
import { plannerMessages, templatePlanDraft } from './planner'
import { backoffBefore, parsePlanText, referencesIn, substitute, validatePlan } from './validate'

/** SET 5 plan validation: what may reach the Workflow Engine, and what may not. */

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    description: '',
    skillId: 'model.generate',
    dependencies: [],
    input: { prompt: `Do ${id}` },
    condition: null,
    timeoutMs: 60_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
    verification: null,
    required: true,
    ...overrides
  }
}

function draft(steps: PlanStep[], overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    goal: 'Test goal',
    assumptions: [],
    rationale: 'Because.',
    steps,
    requiredSkills: [...new Set(steps.map((item) => item.skillId))],
    requiredPermissions: [],
    expectedArtifacts: [],
    verificationPlan: {
      checks: [{ step: steps[0]?.id ?? 'a', check: 'non-empty', description: 'Output present' }]
    },
    ...overrides
  }
}

const codes = (plan: PlanDraft) => validatePlan(plan).map((issue) => issue.code)

describe('parsing planner output (strict schema)', () => {
  it('accepts a valid plan as JSON, also inside one ```json fence', () => {
    const plan = draft([step('a'), step('b', { dependencies: ['a'], input: { prompt: '{{a}}' } })])
    const parsed = parsePlanText(JSON.stringify(plan))
    expect(parsed).toEqual({ ok: true, draft: plan })
    expect(parsePlanText('```json\n' + JSON.stringify(plan) + '\n```')).toEqual({
      ok: true,
      draft: plan
    })
  })

  it('rejects text that is not JSON, and JSON with unknown or missing fields', () => {
    expect(parsePlanText('Sure! Here is my plan: first I will…')).toMatchObject({
      ok: false,
      issues: [{ code: 'not-json' }]
    })
    const withReasoning = { ...draft([step('a')]), reasoning: 'hidden thoughts' }
    const refused = parsePlanText(JSON.stringify(withReasoning))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.issues[0]?.code).toBe('schema')
    const { verificationPlan: _dropped, ...noVerification } = draft([step('a')])
    const missing = parsePlanText(JSON.stringify(noVerification))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.issues[0]?.message).toMatch(/verificationPlan/)
  })

  it('names the step a schema problem is in', () => {
    const bad = draft([step('a'), step('b', { timeoutMs: 5 })])
    const parsed = parsePlanText(JSON.stringify(bad))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues[0]).toMatchObject({ code: 'schema', step: 'b' })
  })
})

describe('plan validation', () => {
  it('accepts the template plan and a well-formed graph', () => {
    expect(validatePlan(templatePlanDraft('Write a haiku'))).toEqual([])
    const plan = draft([
      step('research'),
      step('outline'),
      step('write', {
        dependencies: ['research', 'outline'],
        input: { prompt: 'Use {{research}} and {{ outline }}' }
      }),
      step('fallback', {
        skillId: 'text.compose',
        dependencies: ['write'],
        input: { template: 'Could not write it.' },
        condition: { step: 'write', outcome: 'completed' },
        required: false
      })
    ])
    expect(validatePlan(plan)).toEqual([])
  })

  it('rejects cycles, including a step that depends on itself', () => {
    expect(
      codes(
        draft([
          step('a', { dependencies: ['c'] }),
          step('b', { dependencies: ['a'] }),
          step('c', { dependencies: ['b'] })
        ])
      )
    ).toContain('cycle')
    expect(codes(draft([step('a', { dependencies: ['a'] })]))).toContain('cycle')
  })

  it('rejects missing dependencies and duplicate step ids', () => {
    expect(codes(draft([step('a', { dependencies: ['ghost'] })]))).toEqual(['missing-dependency'])
    expect(codes(draft([step('a'), step('a')]))).toContain('duplicate-step')
  })

  it('rejects unknown and unavailable skills, and undeclared ones', () => {
    expect(codes(draft([step('a', { skillId: 'files.delete' })]))).toContain('unknown-skill')
    const identity = draft([
      step('a'),
      step('b', { skillId: 'checkpoint.identity', input: { reason: 'Bank login' } })
    ])
    expect(codes(identity)).toContain('unavailable-skill')
    expect(codes(draft([step('a')], { requiredSkills: [] }))).toEqual(['skills-not-declared'])
    expect(
      codes(draft([step('a')], { requiredSkills: ['model.generate', 'text.compose'] }))
    ).toEqual(['skills-not-declared'])
  })

  it('accepts known capabilities (asked for at run time) and rejects unknown ones', () => {
    expect(codes(draft([step('a')], { requiredPermissions: ['files.write'] }))).toEqual([])
    expect(codes(draft([step('a')], { requiredPermissions: ['files.teleport'] }))).toEqual([
      'permission-unavailable'
    ])
  })

  it('rejects invalid timeouts and missing inputs', () => {
    expect(codes(draft([step('a', { timeoutMs: 2_000 })]))).toEqual(['invalid-timeout'])
    expect(
      codes(
        draft([
          step('a', {
            timeoutMs: 600_000,
            retryPolicy: { maxAttempts: 5, backoffMs: 60_000, multiplier: 4 }
          })
        ])
      )
    ).toEqual(['invalid-timeout'])
    expect(codes(draft([step('a', { input: {} })]))).toEqual(['missing-input'])
    expect(codes(draft([step('a', { input: { prompt: 'x', extra: 'y' } })]))).toEqual(['schema'])
  })

  it('rejects ambiguous artifact references', () => {
    // Not a step, not a dependency, a step without output, a malformed reference.
    expect(codes(draft([step('a', { input: { prompt: '{{nothing}}' } })]))).toEqual([
      'ambiguous-artifact'
    ])
    expect(codes(draft([step('a'), step('b', { input: { prompt: '{{a}}' } })]))).toEqual([
      'ambiguous-artifact'
    ])
    expect(
      codes(
        draft([
          step('a'),
          step('ok', {
            skillId: 'checkpoint.approval',
            input: { question: 'Go on?' },
            dependencies: ['a']
          }),
          step('b', { dependencies: ['ok'], input: { prompt: 'Use {{ok}}' } })
        ])
      )
    ).toEqual(['ambiguous-artifact'])
    expect(
      codes(draft([step('a')], { expectedArtifacts: [{ step: 'zzz', description: 'A file' }] }))
    ).toEqual(['ambiguous-artifact'])
  })

  it('rejects conditions on steps that are not dependencies, or on failure of a required step', () => {
    expect(
      codes(
        draft([
          step('a'),
          step('b', { condition: { step: 'a', outcome: 'completed' }, required: false })
        ])
      )
    ).toEqual(['invalid-condition'])
    expect(
      codes(
        draft([
          step('a'),
          step('b', {
            dependencies: ['a'],
            condition: { step: 'a', outcome: 'failed' },
            required: false
          })
        ])
      )
    ).toEqual(['invalid-condition'])
  })

  it('needs a verification plan that checks a required step’s output', () => {
    expect(
      codes(
        draft([step('a'), step('b', { required: false })], {
          verificationPlan: { checks: [{ step: 'b', check: 'non-empty', description: 'x' }] }
        })
      )
    ).toEqual(['no-verification'])
    expect(
      codes(
        draft([step('a')], {
          verificationPlan: { checks: [{ step: 'a', check: 'contains', description: 'x' }] }
        })
      )
    ).toEqual(['invalid-verification'])
  })
})

describe('artifact passing and retry helpers', () => {
  it('substitutes {{step-id}} with the output of that step', () => {
    expect(referencesIn('A {{one}} and {{ two }}')).toEqual(['one', 'two'])
    expect(
      substitute(
        'A {{one}} and {{ two }}',
        new Map([
          ['one', '1'],
          ['two', '2']
        ])
      )
    ).toBe('A 1 and 2')
  })

  it('grows the wait before each retry by the multiplier', () => {
    const policy = { retryPolicy: { maxAttempts: 4, backoffMs: 500, multiplier: 2 } }
    expect([2, 3, 4].map((attempt) => backoffBefore(policy, attempt))).toEqual([500, 1000, 2000])
  })
})

describe('planner prompt', () => {
  it('offers only available step types and asks for JSON, not reasoning', () => {
    const { system, user } = plannerMessages({
      request: 'Plan a trip',
      previous: null,
      failure: null,
      feedback: 'I travel by train'
    })
    expect(system).toContain('model.generate')
    expect(system).not.toContain('checkpoint.identity')
    expect(system).toMatch(/no reasoning/)
    expect(user).toContain('I travel by train')
    expect(stepTypeInfo().find((type) => type.skillId === 'checkpoint.identity')?.available).toBe(
      false
    )
  })
})
