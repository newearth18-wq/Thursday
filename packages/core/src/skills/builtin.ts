import { SKILL_RUNTIME, type SkillDefinition } from '@jupiter/contracts'
import type { SkillResource } from './registry'

/**
 * A Skill's code and its self-check (SET 6).
 *
 * `source` is a JavaScript function expression, `async (input, context) =>
 * output`, run in the sandbox. `context.use(resource, args)` is the only way
 * out, and every resource needs a permission.
 */
export interface SkillImplementation {
  readonly definition: SkillDefinition
  readonly source: string
  /** Input for the health check; the check passes when the output is valid (and equals `expect`, if given). */
  readonly healthInput: unknown
  readonly healthExpect?: unknown
  /** What a caller can check about a successful output. */
  readonly verificationHints: readonly string[]
}

const base = {
  version: '1.0.0',
  provider: 'internal',
  compatibleRuntime: SKILL_RUNTIME
} as const

/** The Skills built into this build of Jupiter. */
export const BUILTIN_SKILLS: readonly SkillImplementation[] = [
  {
    definition: {
      ...base,
      skillId: 'echo_text',
      name: 'Echo text',
      description: 'Returns exactly the text it is given. Useful for checking that Skills run.',
      category: 'text',
      permissions: [],
      timeoutMs: 5_000,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 10_000, description: 'The text to return.' }
        },
        required: ['text'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 10_000 } },
        required: ['text'],
        additionalProperties: false
      }
    },
    source: 'async (input) => ({ text: input.text })',
    healthInput: { text: 'health check' },
    healthExpect: { text: 'health check' },
    verificationHints: ['output.text is exactly input.text']
  },
  {
    definition: {
      ...base,
      skillId: 'get_app_version',
      name: 'Get app version',
      description: 'Returns the version, channel and commit of this build of Jupiter.',
      category: 'information',
      permissions: ['app.version.read'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          version: { type: 'string', maxLength: 64 },
          channel: { type: 'string', maxLength: 32 },
          commit: { type: 'string', maxLength: 64 }
        },
        required: ['version', 'channel', 'commit'],
        additionalProperties: false
      }
    },
    source: "async (input, context) => context.use('app.version')",
    healthInput: {},
    verificationHints: ['output.version is the version shown in Diagnostics']
  },
  {
    definition: {
      ...base,
      skillId: 'get_system_time',
      name: 'Get system time',
      description:
        'Returns the current time of this computer in UTC, with its time zone and offset.',
      category: 'system',
      permissions: ['system.time.read'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          utc: { type: 'string', maxLength: 40 },
          timeZone: { type: 'string', maxLength: 64 },
          utcOffsetMinutes: { type: 'integer', minimum: -1_440, maximum: 1_440 }
        },
        required: ['utc', 'timeZone', 'utcOffsetMinutes'],
        additionalProperties: false
      }
    },
    source: "async (input, context) => context.use('system.time')",
    healthInput: {},
    verificationHints: ['output.utc is an ISO-8601 UTC time close to the invocation time']
  },
  {
    definition: {
      ...base,
      skillId: 'list_available_skills',
      name: 'List available Skills',
      description: 'Lists the Skills registered in Jupiter, with their version, state and health.',
      category: 'information',
      permissions: ['skills.read'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          skills: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              properties: {
                skillId: { type: 'string', maxLength: 64 },
                name: { type: 'string', maxLength: 80 },
                version: { type: 'string', maxLength: 20 },
                enabled: { type: 'boolean' },
                health: { type: 'string', enum: ['HEALTHY', 'UNHEALTHY', 'UNKNOWN'] }
              },
              required: ['skillId', 'name', 'version', 'enabled', 'health'],
              additionalProperties: false
            }
          }
        },
        required: ['skills'],
        additionalProperties: false
      }
    },
    source: "async (input, context) => ({ skills: await context.use('skills.list') })",
    healthInput: {},
    verificationHints: ['output.skills lists every registered Skill']
  }
]

/**
 * Skills with known faults, registered only in the `test` environment when
 * `JUPITER_TEST_SKILL_FIXTURES=1`, or by tests. Their provider is
 * `test-fixture`, and the interface says so.
 */
export const TEST_FIXTURE_SKILLS: readonly SkillImplementation[] = [
  {
    definition: {
      version: '1.0.0',
      provider: 'test-fixture',
      compatibleRuntime: SKILL_RUNTIME,
      skillId: 'fixture_broken_health',
      name: 'Broken fixture',
      description: 'Test fixture: fails every run, so its health check reports it as unhealthy.',
      category: 'developer',
      permissions: [],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    source:
      "async () => { const error = new Error('This fixture always fails.'); error.code = 'FIXTURE_BROKEN'; throw error }",
    healthInput: {},
    verificationHints: []
  },
  {
    definition: {
      version: '1.0.0',
      provider: 'test-fixture',
      compatibleRuntime: SKILL_RUNTIME,
      skillId: 'fixture_slow',
      name: 'Slow fixture',
      description: 'Test fixture: never finishes on its own, to exercise timeout and cancel.',
      category: 'developer',
      permissions: [],
      timeoutMs: 60_000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    source: 'async () => { for (;;) {} }',
    healthInput: null,
    verificationHints: []
  },
  {
    definition: {
      version: '1.0.0',
      provider: 'test-fixture',
      compatibleRuntime: SKILL_RUNTIME,
      skillId: 'fixture_note_writer',
      name: 'Note writer fixture',
      description:
        'Test fixture: adds a note to a list kept in memory by the test environment. Needs memory.write.',
      category: 'developer',
      permissions: ['memory.write'],
      timeoutMs: 5_000,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['text'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 0 } },
        required: ['count'],
        additionalProperties: false
      }
    },
    source:
      'async (input, context) => ({ count: await context.use("fixture.notes.append", { text: input.text }) })',
    healthInput: { text: 'health check' },
    verificationHints: []
  },
  {
    definition: {
      version: '1.0.0',
      provider: 'test-fixture',
      compatibleRuntime: SKILL_RUNTIME,
      skillId: 'fixture_notes_clearer',
      name: 'Notes clearer fixture',
      description:
        'Test fixture: deletes every note in the test list at once. A critical action (files.delete_bulk).',
      category: 'developer',
      permissions: ['files.delete_bulk'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { cleared: { type: 'integer', minimum: 0 } },
        required: ['cleared'],
        additionalProperties: false
      }
    },
    source: 'async (input, context) => ({ cleared: await context.use("fixture.notes.clear") })',
    healthInput: {},
    verificationHints: []
  }
]

/**
 * The resources the fixture Skills use: a list of notes in memory, with a
 * real effect a test can observe. Created fresh for each Core, only in the
 * test environment, like the fixture Skills.
 */
export function createFixtureResources(): {
  readonly resources: Readonly<Record<string, SkillResource>>
  readonly notes: readonly string[]
} {
  const notes: string[] = []
  return {
    notes,
    resources: {
      'fixture.notes.append': {
        permission: 'memory.write',
        target: 'fixture:notes',
        handler: (args) => {
          const text = (args as { text?: unknown } | null)?.text
          notes.push(typeof text === 'string' ? text.slice(0, 200) : '')
          return notes.length
        }
      },
      'fixture.notes.clear': {
        permission: 'files.delete_bulk',
        target: 'fixture:notes/*',
        handler: () => notes.splice(0).length
      }
    }
  }
}
