import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SKILL_RUNTIME, type SkillDefinition } from '@jupiter/contracts'
import {
  TEST_FIXTURE_SKILLS,
  createFixtureResources,
  uuidv7,
  type SkillImplementation
} from '@jupiter/core'
import { describe, expect, it } from 'vitest'
import {
  call,
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
 * SET 6, the Skill Registry in Jupiter Core (in-process, see core-harness.ts):
 * the real kernel, SQLite and the worker-thread sandbox. Skills are invoked
 * through the same capabilities the interface uses.
 */

useCoreHarness('jupiter-skills-core')

const definition = (overrides: Partial<SkillDefinition> = {}): SkillDefinition => ({
  skillId: 'reverse_text',
  name: 'Reverse text',
  description: 'Reverses the text it is given.',
  version: '1.0.0',
  category: 'text',
  provider: 'test-fixture',
  compatibleRuntime: SKILL_RUNTIME,
  permissions: [],
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 100 } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  ...overrides
})

const skill = (
  overrides: Partial<SkillDefinition>,
  source: string,
  healthInput: unknown = null
): SkillImplementation => ({
  definition: definition(overrides),
  source,
  healthInput,
  verificationHints: []
})

async function invoke(running: Running, skillId: string, input: unknown, extra: object = {}) {
  return call(running, 'skills.invoke', { executionId: uuidv7(), skillId, input, ...extra })
}

describe('Skill Registry', () => {
  it('lists the four internal Skills with their real health after start', async () => {
    const running = await startCore(standard())
    const { skills } = await call(running, 'skills.list', { filter: {} })
    expect(skills.map((item) => [item.definition.skillId, item.health.status])).toEqual([
      ['echo_text', 'HEALTHY'],
      // The in-process Core has no build metadata: the Skill says so instead of inventing one.
      ['get_app_version', 'UNHEALTHY'],
      ['get_system_time', 'HEALTHY'],
      ['list_available_skills', 'HEALTHY']
    ])
    expect(skills[1]?.health.detail).toContain('APP_VERSION_UNAVAILABLE')
    expect(skills.every((item) => item.health.checkedAt !== null)).toBe(true)
    expect(skills[0]).toMatchObject({ enabled: true, runtime: 'sandbox@1', testable: true })
  })

  it('AT1 + AT2: registers a valid Skill and rejects invalid ones with reasons', async () => {
    const running = await startCore(standard())
    const registered = running.core.skills.register(
      skill({}, 'async (input) => ({ text: [...input.text].reverse().join("") })', { text: 'ab' })
    )
    expect(registered.definition.skillId).toBe('reverse_text')
    const reversed = await invoke(running, 'reverse_text', { text: 'Jupiter' })
    expect(reversed).toMatchObject({ status: 'SUCCESS', output: { text: 'retipuJ' } })

    const invalid: [Partial<SkillDefinition>, string, RegExp][] = [
      [{ version: 'one' }, 'async () => ({})', /version/],
      [{ skillId: 'Bad Id' }, 'async () => ({})', /skillId/],
      [{ permissions: ['disk.format'] }, 'async () => ({})', /not a permission Jupiter knows/],
      [
        {
          inputSchema: { type: 'object', properties: {}, required: ['text'] }
        },
        'async () => ({})',
        /required field "text" is not in "properties"/
      ],
      [{ timeoutMs: 10 }, 'async () => ({})', /timeoutMs/],
      [{ skillId: 'no_code' }, '   ', /no code/]
    ]
    for (const [overrides, source, reason] of invalid) {
      expect(() => running.core.skills.register(skill(overrides, source))).toThrow(reason)
    }
    // An unknown field in the metadata is refused, not dropped.
    expect(() =>
      running.core.skills.register({
        ...skill({}, 'async () => ({})'),
        definition: { ...definition({ skillId: 'extra_field' }), secretKey: 'x' } as never
      })
    ).toThrow(/Unrecognized key/)
    const { skills } = await call(running, 'skills.list', { filter: {} })
    expect(skills.map((item) => item.definition.skillId)).toEqual([
      'echo_text',
      'get_app_version',
      'get_system_time',
      'list_available_skills',
      'reverse_text'
    ])
  })

  it('AT3: echo_text returns exactly its input, and history keeps only shape and size', async () => {
    const running = await startCore(standard())
    const text = 'Exact text, ภาษาไทย, emoji 🪐 and   spaces  '
    const result = await invoke(running, 'echo_text', { text })
    expect(result).toMatchObject({
      skillId: 'echo_text',
      version: '1.0.0',
      status: 'SUCCESS',
      output: { text },
      error: null,
      verificationHints: ['output.text is exactly input.text']
    })
    const { executions } = await call(running, 'skills.executions', {
      skillId: 'echo_text',
      limit: 10
    })
    expect(executions[0]).toMatchObject({
      executionId: result.executionId,
      status: 'SUCCESS',
      actor: 'user-interface',
      inputSummary: { type: 'object', size: 1, fields: ['text'] },
      outputSummary: { type: 'object', size: 1, fields: ['text'] }
    })
    // The text itself is nowhere in the database.
    const db = new DatabaseSync(join(running.dir, 'jupiter.db'), { readOnly: true })
    try {
      const rows = JSON.stringify(db.prepare('SELECT * FROM skill_executions').all())
      expect(rows).not.toContain('Exact text')
    } finally {
      db.close()
    }
    // Input that does not match the schema is refused before anything runs.
    const wrong = await invoke(running, 'echo_text', { text: 'x', extra: true })
    expect(wrong).toMatchObject({ status: 'FAILED', error: { code: 'SKILL_INPUT_INVALID' } })
  })

  it('AT4: a Skill past its timeout is stopped, even in a busy loop, and Core carries on', async () => {
    const running = await startCore(standard(), new Map(), TEST_FIXTURE_SKILLS)
    const started = Date.now()
    const result = await invoke(running, 'fixture_slow', {}, { timeoutMs: 500 })
    expect(result).toMatchObject({
      status: 'TIMEOUT',
      output: null,
      error: { code: 'SKILL_TIMEOUT' }
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(running.core.skills.activeCount).toBe(0)
    expect(await invoke(running, 'echo_text', { text: 'still here' })).toMatchObject({
      status: 'SUCCESS'
    })
  })

  it('AT5: Cancel ends a running Skill', async () => {
    const running = await startCore(standard(), new Map(), TEST_FIXTURE_SKILLS)
    const executionId = uuidv7()
    const pending = call(running, 'skills.invoke', {
      executionId,
      skillId: 'fixture_slow',
      input: {}
    })
    await expect.poll(() => running.core.skills.activeCount).toBe(1)
    expect(await call(running, 'skills.cancel', { executionId })).toEqual({ cancelled: true })
    const result = await pending
    expect(result).toMatchObject({ status: 'CANCELLED', error: { code: 'CANCELLED' } })
    expect(running.core.skills.activeCount).toBe(0)
    expect(await call(running, 'skills.cancel', { executionId })).toEqual({ cancelled: false })
    const { executions } = await call(running, 'skills.executions', { limit: 5 })
    expect(executions[0]).toMatchObject({ executionId, status: 'CANCELLED' })
  })

  it('AT6: a disabled Skill cannot run, and the setting survives a restart', async () => {
    const first = await startCore(standard())
    const disabled = await call(first, 'skills.disable', { skillId: 'echo_text' })
    expect(disabled).toMatchObject({ enabled: false, blockedReason: 'Disabled.' })
    const refused = await invoke(first, 'echo_text', { text: 'hi' })
    expect(refused).toMatchObject({ status: 'FAILED', error: { code: 'SKILL_DISABLED' } })
    await stopCore(first)

    const second = await startCore(standard())
    expect((await call(second, 'skills.get', { skillId: 'echo_text' })).enabled).toBe(false)
    await call(second, 'skills.enable', { skillId: 'echo_text' })
    expect(await invoke(second, 'echo_text', { text: 'hi' })).toMatchObject({ status: 'SUCCESS' })
  })

  it('AT7: a resource the Skill did not declare is denied; a declared one is checked when used', async () => {
    const running = await startCore(standard())
    running.core.skills.register(
      skill(
        { skillId: 'sneaky_clock', outputSchema: { type: 'object', additionalProperties: true } },
        'async (input, context) => { try { return { time: await context.use("system.time") } } catch (e) { return { denied: e.code } } }'
      )
    )
    const sneaky = await invoke(running, 'sneaky_clock', { text: 'x' })
    expect(sneaky).toMatchObject({
      status: 'FAILED',
      output: null,
      error: { code: 'PERMISSION_DENIED', category: 'permission' }
    })
    expect(sneaky.error?.message).toContain('system.time.read')

    // A declared permission is asked for when it is used (SET 7), not refused up front.
    running.core.skills.register(
      skill({ skillId: 'file_writer', permissions: ['files.write'] }, 'async () => ({ text: "" })')
    )
    const writer = await invoke(running, 'file_writer', { text: 'x' })
    expect(writer).toMatchObject({ status: 'SUCCESS' })
    const info = await call(running, 'skills.get', { skillId: 'file_writer' })
    expect(info).toMatchObject({
      testable: false,
      permissions: [{ name: 'files.write', risk: 'HIGH', granted: false }]
    })

    // Declared and granted: allowed.
    const time = await invoke(running, 'get_system_time', {})
    expect(time.status).toBe('SUCCESS')
    expect(Math.abs(Date.parse((time.output as { utc: string }).utc) - Date.now())).toBeLessThan(
      60_000
    )
  })

  it('AT8: broken Skills fail with a structured error and Core keeps working', async () => {
    const running = await startCore(standard(), new Map(), TEST_FIXTURE_SKILLS)
    // Unhealthy: refused before it runs.
    expect(
      (await call(running, 'skills.get', { skillId: 'fixture_broken_health' })).health.status
    ).toBe('UNHEALTHY')
    expect(await invoke(running, 'fixture_broken_health', {})).toMatchObject({
      status: 'FAILED',
      error: { code: 'SKILL_UNHEALTHY' }
    })
    const broken: [string, string, string][] = [
      ['throws', 'async () => { throw new Error("kaboom") }', 'SKILL_FAILED'],
      ['not_a_function', '42', 'SKILL_NOT_A_FUNCTION'],
      ['syntax_error', 'async () => { this is not javascript', 'SKILL_FAILED'],
      [
        'circular',
        'async () => { const a = {}; a.a = a; return a }',
        'SKILL_OUTPUT_NOT_SERIALIZABLE'
      ]
    ]
    for (const [id, source, code] of broken) {
      running.core.skills.register(skill({ skillId: id }, source))
      const result = await invoke(running, id, { text: 'x' })
      expect(result, id).toMatchObject({ status: 'FAILED', output: null, error: { code } })
    }
    // Core is still healthy and answering.
    const snapshot = await call(running, 'diagnostics.snapshot', {})
    expect(snapshot.services.find((item) => item.serviceId === 'skill-registry')?.status).toBe(
      'HEALTHY'
    )
    expect(await invoke(running, 'echo_text', { text: 'ok' })).toMatchObject({ status: 'SUCCESS' })
  })

  it('AT9: output that does not match the output schema makes the execution fail', async () => {
    const running = await startCore(standard())
    running.core.skills.register(
      skill({ skillId: 'wrong_output' }, 'async () => ({ text: 42, extra: "not declared" })')
    )
    const result = await invoke(running, 'wrong_output', { text: 'x' })
    expect(result).toMatchObject({
      status: 'FAILED',
      output: null,
      error: { code: 'SKILL_OUTPUT_INVALID' }
    })
    expect(result.error?.message).toContain('output.text expected a string')
    expect(result.error?.message).toContain('output.extra is not a declared field')
  })

  it('refuses to run the same idempotency key twice, and lists versions newest first', async () => {
    const running = await startCore(standard())
    await invoke(running, 'echo_text', { text: 'once' }, { idempotencyKey: 'k-1' })
    const again = await failure(running, 'skills.invoke', {
      executionId: uuidv7(),
      skillId: 'echo_text',
      input: { text: 'once' },
      idempotencyKey: 'k-1'
    })
    expect(again.code).toBe('SKILL_DUPLICATE_INVOCATION')

    running.core.skills.register(skill({ version: '1.2.0' }, 'async (i) => ({ text: i.text })'))
    running.core.skills.register(
      skill({ version: '1.10.0' }, 'async (i) => ({ text: i.text + "!" })')
    )
    const { versions } = await call(running, 'skills.versions', { skillId: 'reverse_text' })
    expect(versions.map((item) => item.definition.version)).toEqual(['1.10.0', '1.2.0'])
    expect(await invoke(running, 'reverse_text', { text: 'a' })).toMatchObject({
      version: '1.10.0',
      output: { text: 'a!' }
    })
    expect(
      await invoke(running, 'reverse_text', { text: 'a' }, { version: '1.2.0' })
    ).toMatchObject({ version: '1.2.0', output: { text: 'a' } })
  })

  it('searches and filters by text, category, provider and health', async () => {
    const running = await startCore(
      standard(),
      new Map(),
      TEST_FIXTURE_SKILLS,
      createFixtureResources().resources
    )
    const ids = async (filter: object) =>
      (await call(running, 'skills.list', { filter })).skills.map((item) => item.definition.skillId)
    expect(await ids({ query: 'system time' })).toEqual(['get_system_time'])
    // Search covers descriptions too: the slow fixture mentions timeouts.
    expect(await ids({ query: 'time' })).toEqual(['get_system_time', 'fixture_slow'])
    expect(await ids({ category: 'information' })).toEqual([
      'get_app_version',
      'list_available_skills'
    ])
    expect(await ids({ provider: 'test-fixture' })).toEqual([
      'fixture_broken_health',
      'fixture_note_writer',
      'fixture_notes_clearer',
      'fixture_slow'
    ])
    // Their health cannot be known without a permission nobody has given yet.
    expect(await ids({ health: 'UNKNOWN' })).toEqual([
      'fixture_note_writer',
      'fixture_notes_clearer'
    ])
    expect(await ids({ health: 'UNHEALTHY' })).toEqual(['fixture_broken_health', 'get_app_version'])
  })

  it('runs a registered Skill as a workflow step', async () => {
    const running = await startCore(standard())
    await withModel(running)
    const plan = {
      goal: 'Echo it',
      assumptions: [],
      rationale: 'One Skill step.',
      steps: [
        {
          id: 'echo',
          title: 'Echo the words',
          description: '',
          skillId: 'echo_text',
          dependencies: [],
          input: { text: 'Hello from a plan' },
          condition: null,
          timeoutMs: 5_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        },
        {
          id: 'time',
          title: 'Read the clock',
          description: '',
          skillId: 'get_system_time',
          dependencies: [],
          input: {},
          condition: null,
          timeoutMs: 5_000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
          verification: null,
          required: true
        }
      ],
      requiredSkills: ['echo_text', 'get_system_time'],
      requiredPermissions: ['system.time.read'],
      expectedArtifacts: [],
      verificationPlan: {
        checks: [
          { step: 'echo', check: 'contains', value: 'Hello from a plan', description: 'Echoed' }
        ]
      }
    }
    server.enqueue({ chunks: [JSON.stringify(plan)] })
    const { mission } = await call(running, 'missions.create', {
      request: 'Echo a line',
      planner: 'model'
    })
    const done = await settled(running, mission.missionId, 'COMPLETED')
    // The two steps are independent, so they run in parallel and may finish in either order.
    expect(done.artifacts.map((item) => item.title).sort()).toEqual([
      'Echo the words',
      'Read the clock'
    ])
    expect(done.artifacts.find((item) => item.title === 'Echo the words')?.text).toBe(
      'Hello from a plan'
    )
    const { executions } = await call(running, 'skills.executions', { limit: 10 })
    expect(executions.map((item) => [item.skillId, item.missionId, item.status]).sort()).toEqual(
      [
        ['echo_text', mission.missionId, 'SUCCESS'],
        ['get_system_time', mission.missionId, 'SUCCESS']
      ].sort()
    )
  })
})
