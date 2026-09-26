import type { DomainEvent, PlanDraft, PlanStep } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import {
  call,
  chatRequests,
  detail,
  failure,
  server,
  settled,
  standard,
  startCore,
  stopCore,
  useCoreHarness,
  withModel,
  type Running
} from './core-harness'

/**
 * SET 5, the Planner and Workflow Engine in Jupiter Core (in-process, see
 * core-harness.ts). The planning model is a real HTTP server speaking the
 * OpenAI-compatible protocol: each test scripts what "the model" answers —
 * a plan as JSON, then each model step's output — and checks what Jupiter
 * did with it.
 */

useCoreHarness('jupiter-workflow-core')

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    description: `Does ${id}.`,
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

function plan(steps: PlanStep[], overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    goal: 'Get it done',
    assumptions: ['The answer can be in English'],
    rationale: 'Small steps, each checked.',
    steps,
    requiredSkills: [...new Set(steps.map((item) => item.skillId))],
    requiredPermissions: [],
    expectedArtifacts: [],
    verificationPlan: {
      checks: [{ step: steps.at(-1)?.id ?? 'a', check: 'non-empty', description: 'Output present' }]
    },
    ...overrides
  }
}

/** What the planning model answers: the plan, as a JSON text. */
const planned = (draft: PlanDraft | Record<string, unknown>) => ({
  chunks: [JSON.stringify(draft)]
})

async function modelMission(running: Running, request: string) {
  return (await call(running, 'missions.create', { request, planner: 'model' })).mission.missionId
}

function posts(): { body: string; abortedAt: number | null; receivedAt: number }[] {
  return server.requests
    .filter((request) => request.method === 'POST')
    .map((request) => ({
      body: JSON.stringify(request.body),
      abortedAt: request.abortedAt,
      receivedAt: request.receivedAt
    }))
}

async function timeline(running: Running, missionId: string): Promise<DomainEvent[]> {
  return (await call(running, 'missions.timeline', { missionId })).events
}

describe('Planner', () => {
  it('AT1: the planner returns a plan in the valid schema, which is stored and run', async () => {
    const running = await startCore(standard())
    await withModel(running)
    const draft = plan(
      [
        step('outline', { title: 'Outline the note' }),
        step('write', {
          title: 'Write the note',
          dependencies: ['outline'],
          input: { prompt: 'Write it from this outline: {{outline}}' },
          verification: { check: 'non-empty' }
        })
      ],
      { expectedArtifacts: [{ step: 'write', description: 'The note' }] }
    )
    server.enqueue(planned(draft), { chunks: ['1. Hello'] }, { chunks: ['Hello, world.'] })
    const missionId = await modelMission(running, 'Write a short note')
    const done = await settled(running, missionId, 'COMPLETED')

    expect(done.plan).toMatchObject({
      ...draft,
      missionId,
      revision: 1,
      previousPlanId: null,
      source: 'model',
      reason: 'First plan'
    })
    expect(done.planRevisions).toHaveLength(1)
    expect(done.steps.map((item) => [item.key, item.dependencies, item.status])).toEqual([
      ['outline', [], 'COMPLETED'],
      ['write', ['outline'], 'COMPLETED']
    ])
    // The planner was asked for JSON only, with the request, and nothing else was stored.
    const [planning] = posts()
    expect(planning?.body).toContain('Reply with exactly one JSON object')
    expect(planning?.body).toContain('Write a short note')
    const events = await timeline(running, missionId)
    expect(events.find((event) => event.type === 'mission.planned')?.payload).toMatchObject({
      source: 'model',
      revision: 1,
      steps: 2
    })
    expect(done.verificationResults).toEqual([
      expect.objectContaining({ check: 'write-non-empty', passed: true })
    ])
  })

  it('AT2: output that is not a plan in the strict schema is rejected, stored with reasons, and nothing runs', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue({ chunks: ['Sure! First I will think about it step by step…'] })
    const prose = await modelMission(running, 'Plan something')
    const rejected = await settled(running, prose, 'FAILED')
    expect(rejected.planRejections).toEqual([
      { at: expect.any(String) as string, issues: [expect.objectContaining({ code: 'not-json' })] }
    ])
    expect(rejected.plan).toBeNull()
    expect(rejected.executionHistory).toEqual([])
    expect(rejected.errors.at(-1)?.error.code).toBe('PLAN_INVALID')
    expect(rejected.actions).toEqual(['replan', 'archive'])

    // Well-formed JSON with a field the schema does not have (e.g. reasoning) is refused too.
    server.enqueue(planned({ ...plan([step('a')]), reasoning: 'my hidden thoughts' }))
    const extra = await modelMission(running, 'Plan something else')
    const refused = await settled(running, extra, 'FAILED')
    expect(refused.planRejections[0]?.issues[0]?.code).toBe('schema')
    expect(JSON.stringify(refused)).not.toContain('my hidden thoughts')
    // Only the two planning requests were made.
    expect(chatRequests()).toBe(2)
    expect(
      (await timeline(running, extra)).find((event) => event.type === 'mission.plan_rejected')
        ?.payload
    ).toEqual({ issues: 1, codes: ['schema'] })
  })

  it('AT10: a cyclic plan or one that needs permissions cannot run', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan([
          step('a', { dependencies: ['c'] }),
          step('b', { dependencies: ['a'] }),
          step('c', { dependencies: ['b'] })
        ])
      ),
      planned(plan([step('a')], { requiredPermissions: ['files.write'] })),
      planned(plan([step('a'), step('b', { dependencies: ['ghost'] })]))
    )
    const cyclic = await settled(running, await modelMission(running, 'Cycle'), 'FAILED')
    const permission = await settled(running, await modelMission(running, 'Permission'), 'FAILED')
    const missing = await settled(running, await modelMission(running, 'Missing'), 'FAILED')
    expect(cyclic.planRejections[0]?.issues.map((issue) => issue.code)).toEqual(['cycle'])
    expect(permission.planRejections[0]?.issues.map((issue) => issue.code)).toEqual([
      'permission-unavailable'
    ])
    expect(missing.planRejections[0]?.issues.map((issue) => issue.code)).toEqual([
      'missing-dependency'
    ])
    for (const rejected of [cyclic, permission, missing]) {
      expect(rejected.executionHistory).toEqual([])
      expect(rejected.steps).toEqual([])
    }
    // Three planning requests, no step ever ran.
    expect(chatRequests()).toBe(3)
  })
})

describe('Workflow Engine', () => {
  it('AT3: runs steps in dependency order and passes each output to the steps that use it', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan([
          step('first'),
          step('second', { dependencies: ['first'], input: { prompt: 'Improve: {{first}}' } }),
          step('third', {
            skillId: 'text.compose',
            dependencies: ['second'],
            input: { template: 'Final: {{second}} (from {{first}})' }
          })
        ])
      ),
      { chunks: ['draft one'] },
      { chunks: ['better draft'] }
    )
    const missionId = await modelMission(running, 'Three steps')
    const done = await settled(running, missionId, 'COMPLETED')
    const bodies = posts().map((item) => item.body)
    expect(bodies).toHaveLength(3)
    expect(bodies[1]).toContain('Do first')
    expect(bodies[2]).toContain('Improve: draft one')
    expect(done.artifacts.map((item) => item.text)).toEqual([
      'draft one',
      'better draft',
      'Final: better draft (from draft one)'
    ])
    const events = await timeline(running, missionId)
    const order = events
      .filter(
        (event) => event.type === 'mission.step_started' || event.type === 'mission.step_finished'
      )
      .map(
        (event) => `${event.type.slice(13)}:${String((event.payload as { index: number }).index)}`
      )
    expect(order).toEqual([
      'started:0',
      'finished:0',
      'started:1',
      'finished:1',
      'started:2',
      'finished:2'
    ])
  })

  it('AT4: runs independent steps in parallel, and a step waiting on both only after both', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan([
          step('left'),
          step('right'),
          step('join', {
            skillId: 'text.compose',
            dependencies: ['left', 'right'],
            input: { template: '{{left}} + {{right}}' }
          })
        ])
      ),
      { chunks: ['L'], gated: true },
      { chunks: ['R'], gated: true }
    )
    const missionId = await modelMission(running, 'In parallel')
    // Both model steps are in flight at once, neither has an answer yet.
    await expect.poll(chatRequests).toBe(3)
    const during = await detail(running, missionId)
    expect(during.steps.map((item) => item.status)).toEqual(['RUNNING', 'RUNNING', 'PENDING'])
    server.advance()
    server.advance()
    const done = await settled(running, missionId, 'COMPLETED')
    // Which parallel request got which scripted reply depends on arrival order.
    expect(done.artifacts.at(-1)?.text).toMatch(/^(L \+ R|R \+ L)$/)
  })

  it('AT5: Cancel stops every running step and their provider requests; nothing else starts', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan([
          step('left'),
          step('right'),
          step('join', { dependencies: ['left', 'right'], input: { prompt: '{{left}} {{right}}' } })
        ])
      ),
      { chunks: ['never', 'done'], gated: true },
      { chunks: ['never', 'done'], gated: true }
    )
    const missionId = await modelMission(running, 'Cancel me')
    await expect.poll(chatRequests).toBe(3)
    const cancelled = await call(running, 'missions.cancel', { missionId })
    expect(cancelled.mission.status).toBe('CANCELLED')
    expect(cancelled.steps.map((item) => item.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'SKIPPED'
    ])
    expect(cancelled.stepAttempts.map((item) => item.outcome)).toEqual(['cancelled', 'cancelled'])
    expect(cancelled.executionHistory[0]?.status).toBe('CANCELLED')
    await expect
      .poll(() =>
        posts()
          .slice(1)
          .map((item) => item.abortedAt !== null)
      )
      .toEqual([true, true])
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(chatRequests()).toBe(3)
    expect(running.core.missions.activeCount).toBe(0)
  })

  it('AT6: a step that runs past its timeout is stopped and recorded as timed out', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(planned(plan([step('slow', { timeoutMs: 5_000 })])), {
      chunks: ['Starting…', 'never finishes'],
      stallAfter: 1
    })
    const missionId = await modelMission(running, 'Too slow')
    const failed = await settled(running, missionId, 'FAILED')
    const [slow] = failed.steps
    expect(slow).toMatchObject({ status: 'FAILED', timeoutMs: 5_000 })
    expect(slow?.error).toMatchObject({ code: 'STEP_TIMEOUT', category: 'timeout' })
    expect(failed.stepAttempts).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'timed-out', errorCode: 'STEP_TIMEOUT' })
    ])
    const attempt = failed.stepAttempts[0]
    const took = Date.parse(attempt?.endedAt ?? '') - Date.parse(attempt?.startedAt ?? '')
    expect(took).toBeGreaterThanOrEqual(4_900)
    expect(took).toBeLessThan(15_000)
    // The provider request was closed, and no partial output was kept.
    await expect.poll(() => posts()[1]?.abortedAt ?? null).not.toBeNull()
    expect(failed.artifacts).toEqual([])
  }, 30_000)

  it('AT7: retries with growing waits, and keeps exactly one output (no duplicate side effects)', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan([
          step('fetch', {
            retryPolicy: { maxAttempts: 4, backoffMs: 100, multiplier: 2 },
            verification: { check: 'contains', value: 'ready' }
          }),
          step('use', {
            skillId: 'text.compose',
            dependencies: ['fetch'],
            input: { template: 'Got: {{fetch}}' }
          })
        ])
      ),
      { status: 503, errorMessage: 'busy' },
      { status: 503, errorMessage: 'busy' },
      { chunks: ['not yet'] },
      { chunks: ['ready now'] }
    )
    const missionId = await modelMission(running, 'Retry until it works')
    const done = await settled(running, missionId, 'COMPLETED')
    expect(done.stepAttempts.map((item) => [item.attempt, item.outcome, item.errorCode])).toEqual([
      [1, 'failed', 'PROVIDER_SERVER_ERROR'],
      [2, 'failed', 'PROVIDER_SERVER_ERROR'],
      [3, 'failed', 'OUTPUT_CHECK_FAILED'],
      [4, 'completed', null],
      [1, 'completed', null]
    ])
    const retries = (await timeline(running, missionId))
      .filter((event) => event.type === 'mission.step_retry_scheduled')
      .map((event) => event.payload as { nextAttempt: number; delayMs: number })
    expect(retries.map((item) => [item.nextAttempt, item.delayMs])).toEqual([
      [2, 100],
      [3, 200],
      [4, 400]
    ])
    // One artifact per step, however many attempts it took.
    expect(done.artifacts.map((item) => item.text)).toEqual(['ready now', 'Got: ready now'])
    expect(done.steps[0]).toMatchObject({ attempts: 4, maxAttempts: 4, status: 'COMPLETED' })
    expect(chatRequests()).toBe(5)
  })

  it('AT8: a failed step can trigger a new plan revision; earlier plans and runs are kept', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(planned(plan([step('lookup', { title: 'Look it up' })])), {
      status: 503,
      errorMessage: 'unavailable'
    })
    const missionId = await modelMission(running, 'Find the answer')
    const failed = await settled(running, missionId, 'FAILED')
    expect(failed.actions).toEqual(['retry', 'replan', 'archive'])
    const firstPlan = failed.plan

    server.enqueue(
      planned(
        plan([step('answer', { title: 'Answer from what is known' })], {
          assumptions: ['No lookup is needed']
        })
      ),
      { chunks: ['Forty-two.'] }
    )
    await call(running, 'missions.replan', {
      missionId,
      feedback: 'You do not need to look anything up.'
    })
    const done = await settled(running, missionId, 'COMPLETED')
    // The planner was told what failed and what the person corrected.
    const replanning = posts()[2]?.body ?? ''
    expect(replanning).toContain('step \\"lookup\\" failed')
    expect(replanning).toContain('PROVIDER_SERVER_ERROR')
    expect(replanning).toContain('You do not need to look anything up.')

    expect(done.planRevisions.map((item) => [item.revision, item.previousPlanId])).toEqual([
      [1, null],
      [2, firstPlan?.planId]
    ])
    expect(done.plan).toMatchObject({ revision: 2, assumptions: ['No lookup is needed'] })
    expect(done.plan?.reason).toContain('You do not need to look anything up.')
    const [first, second] = done.executionHistory
    expect(first).toMatchObject({ planId: firstPlan?.planId, status: 'FAILED' })
    expect(first?.steps.map((item) => [item.key, item.status])).toEqual([['lookup', 'FAILED']])
    expect(second).toMatchObject({
      planId: done.plan?.planId,
      retryOf: first?.executionId,
      status: 'COMPLETED'
    })
    expect(done.transitions.map((item) => item.to).slice(-6)).toEqual([
      'FAILED',
      'PLANNING',
      'READY',
      'RUNNING',
      'VERIFYING',
      'COMPLETED'
    ])
    expect(done.mission.planRevision).toBe(2)
  })

  it('branches on a step’s outcome and waits at an approval checkpoint', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan(
          [
            step('try', { required: false }),
            step('fallback', {
              skillId: 'text.compose',
              dependencies: ['try'],
              condition: { step: 'try', outcome: 'failed' },
              input: { template: 'Plan B' }
            }),
            step('celebrate', {
              skillId: 'text.compose',
              dependencies: ['try'],
              condition: { step: 'try', outcome: 'completed' },
              input: { template: 'Plan A worked: {{try}}' },
              required: false
            }),
            step('confirm', {
              skillId: 'checkpoint.approval',
              dependencies: ['fallback'],
              input: { question: 'Send Plan B?' }
            }),
            step('send', {
              skillId: 'text.compose',
              dependencies: ['confirm', 'fallback'],
              input: { template: 'Sent: {{fallback}}' }
            })
          ],
          {
            verificationPlan: {
              checks: [{ step: 'send', check: 'contains', value: 'Plan B', description: 'Sent' }]
            }
          }
        )
      ),
      { status: 400, errorMessage: 'bad request' }
    )
    const missionId = await modelMission(running, 'Branch and ask')
    const waiting = await settled(running, missionId, 'WAITING_APPROVAL')
    expect(waiting.steps.map((item) => [item.key, item.status])).toEqual([
      ['try', 'FAILED'],
      ['fallback', 'COMPLETED'],
      ['celebrate', 'SKIPPED'],
      ['confirm', 'WAITING'],
      ['send', 'PENDING']
    ])
    expect(waiting.mission.waitingFor).toBe('approval')
    expect(waiting.actions).toEqual(['approve', 'reject', 'cancel'])
    expect(waiting.executionHistory[0]?.status).toBe('WAITING')
    const confirm = waiting.steps[3]
    expect(confirm?.detail).toBe('Send Plan B?')

    await call(running, 'missions.approve', { missionId, stepId: confirm?.stepId })
    const done = await settled(running, missionId, 'PARTIAL_SUCCESS')
    expect(done.steps.map((item) => item.status)).toEqual([
      'FAILED',
      'COMPLETED',
      'SKIPPED',
      'COMPLETED',
      'COMPLETED'
    ])
    // Only the optional step that failed keeps it from COMPLETED; the branch not taken does not.
    expect(done.transitions.at(-1)?.reason).toContain('“Step try” failed')
    expect(done.transitions.at(-1)?.reason).not.toContain('celebrate')
    expect(done.artifacts.at(-1)?.text).toBe('Sent: Plan B')
    // A decided checkpoint cannot be decided again.
    expect(
      (await failure(running, 'missions.reject', { missionId, stepId: confirm?.stepId })).code
    ).toBe('STEP_NOT_WAITING')
  })

  it('a rejected approval fails the Mission without running what depends on it', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue(
      planned(
        plan(
          [
            step('draft'),
            step('confirm', {
              skillId: 'checkpoint.approval',
              dependencies: ['draft'],
              input: { question: 'Publish it?' }
            }),
            step('publish', {
              skillId: 'text.compose',
              dependencies: ['confirm', 'draft'],
              input: { template: '{{draft}}' }
            })
          ],
          {
            verificationPlan: {
              checks: [{ step: 'publish', check: 'non-empty', description: 'Published' }]
            }
          }
        )
      ),
      { chunks: ['A draft'] }
    )
    const missionId = await modelMission(running, 'Ask before publishing')
    const waiting = await settled(running, missionId, 'WAITING_APPROVAL')
    await call(running, 'missions.reject', { missionId, stepId: waiting.steps[1]?.stepId })
    const failed = await settled(running, missionId, 'FAILED')
    expect(failed.steps.map((item) => item.status)).toEqual(['COMPLETED', 'FAILED', 'SKIPPED'])
    expect(failed.steps[1]?.error?.code).toBe('APPROVAL_REJECTED')
    expect(failed.artifacts.map((item) => item.text)).toEqual(['A draft'])
  })

  it('AT9: workflow state survives a restart: finished steps are not re-run, the rest continue', async () => {
    const first = await startCore(standard())
    await withModel(first)
    server.enqueue(
      planned(
        plan([
          step('quick'),
          // After "quick", so which request gets which scripted reply is certain.
          step('slow', { dependencies: ['quick'] }),
          step('join', {
            skillId: 'text.compose',
            dependencies: ['quick', 'slow'],
            input: { template: '{{quick}} / {{slow}}' }
          })
        ])
      ),
      { chunks: ['quick answer'] },
      { chunks: ['cut', 'off'], gated: true }
    )
    const missionId = await modelMission(first, 'Survive a restart')
    await expect
      .poll(async () => (await detail(first, missionId)).steps.map((item) => item.status))
      .toEqual(['COMPLETED', 'RUNNING', 'PENDING'])
    const before = await detail(first, missionId)
    await stopCore(first)

    server.enqueue({ chunks: ['slow answer'] })
    const second = await startCore(standard())
    const done = await settled(second, missionId, 'COMPLETED')
    expect(done.plan).toEqual(before.plan)
    expect(done.executionHistory).toHaveLength(1)
    expect(done.artifacts.map((item) => item.text)).toEqual([
      'quick answer',
      'slow answer',
      'quick answer / slow answer'
    ])
    expect(done.stepAttempts.map((item) => [item.stepId, item.attempt, item.outcome])).toEqual([
      [before.steps[0]?.stepId, 1, 'completed'],
      [before.steps[1]?.stepId, 1, 'interrupted'],
      [before.steps[1]?.stepId, 2, 'completed'],
      [before.steps[2]?.stepId, 1, 'completed']
    ])
    // Planner + quick + slow (cut off) before; only slow again after.
    expect(chatRequests()).toBe(4)
    expect(
      (await timeline(second, missionId)).find((event) => event.type === 'mission.recovered')
        ?.payload
    ).toEqual({ interruptedSteps: 1 })
  })

  it('AT9: a Mission waiting for approval keeps waiting across a restart', async () => {
    const first = await startCore(standard())
    await withModel(first)
    server.enqueue(
      planned(
        plan(
          [
            step('confirm', { skillId: 'checkpoint.approval', input: { question: 'Go?' } }),
            step('go', {
              skillId: 'text.compose',
              dependencies: ['confirm'],
              input: { template: 'Went.' }
            })
          ],
          {
            verificationPlan: { checks: [{ step: 'go', check: 'non-empty', description: 'Done' }] }
          }
        )
      )
    )
    const missionId = await modelMission(first, 'Wait for me')
    const waiting = await settled(first, missionId, 'WAITING_APPROVAL')
    await stopCore(first)

    const second = await startCore(standard())
    expect(await detail(second, missionId)).toEqual(waiting)
    await call(second, 'missions.approve', { missionId, stepId: waiting.steps[0]?.stepId })
    const done = await settled(second, missionId, 'COMPLETED')
    expect(done.artifacts.map((item) => item.text)).toEqual(['Went.'])
  })

  it('lists the step types this build can run, and marks the unavailable one', async () => {
    const running = await startCore(standard())
    const { stepTypes } = await call(running, 'missions.step-types', {})
    expect(stepTypes.map((item) => [item.skillId, item.available])).toEqual([
      ['model.generate', true],
      ['text.compose', true],
      ['checkpoint.approval', true],
      ['checkpoint.identity', false],
      // SET 6: registered Skills are step types too. The harness Core has no build
      // metadata, so get_app_version fails its health check and cannot be a step.
      ['echo_text', true],
      ['get_app_version', false],
      ['get_system_time', true],
      ['list_available_skills', true]
    ])
  })
})
