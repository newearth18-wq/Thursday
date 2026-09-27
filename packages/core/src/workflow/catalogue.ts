import type { SkillInfo, StepTypeInfo } from '@jupiter/contracts'

/**
 * The step types (skills) the Workflow Engine can run in this build (SET 5).
 *
 * A plan may use only these and the registered Skills (SET 6). What a
 * Skill step may do is decided by the Permission Engine (SET 7) when it
 * uses a resource. A Computer Agent step (SET 8) asks for its permissions
 * before it touches the computer.
 */

export interface StepTypeDefinition extends StepTypeInfo {
  /** The shortest per-attempt timeout that makes sense for this step type. */
  readonly minTimeoutMs: number
  /** A checkpoint waits for a person instead of running. */
  readonly checkpoint: 'approval' | 'identity' | null
  /**
   * `skill`: run through the Skill Registry (SET 6). `computer`: the Computer
   * Agent (SET 8). `browser`: the Browser Agent (SET 9). `files`: the File
   * Agent and the Artifact Manager (SET 10). `memory` and `notes`: the
   * Memory System and the Obsidian knowledge base (SET 11).
   */
  readonly runner: 'builtin' | 'skill' | 'computer' | 'browser' | 'files' | 'memory' | 'notes'
}

/** Finds a step type by id: the built-in ones and, since SET 6, registered Skills. */
export type StepTypeLookup = (skillId: string) => StepTypeDefinition | null

export const STEP_TYPES: readonly StepTypeDefinition[] = [
  {
    skillId: 'model.generate',
    name: 'Ask the chat model',
    description:
      'Sends the prompt to the configured chat model (same routing, privacy and key rules as Chat) and keeps its answer as this step’s output.',
    inputs: [
      {
        name: 'prompt',
        required: true,
        description: 'What to ask. May include the output of earlier steps as {{step-id}}.'
      }
    ],
    producesOutput: true,
    permissions: [],
    available: true,
    minTimeoutMs: 5_000,
    checkpoint: null,
    runner: 'builtin'
  },
  {
    skillId: 'text.compose',
    name: 'Compose text',
    description:
      'Fills a text template with the output of earlier steps ({{step-id}}). Runs locally; nothing is sent anywhere.',
    inputs: [
      {
        name: 'template',
        required: true,
        description: 'The text to produce, with {{step-id}} where an earlier step’s output goes.'
      }
    ],
    producesOutput: true,
    permissions: [],
    available: true,
    minTimeoutMs: 1_000,
    checkpoint: null,
    runner: 'builtin'
  },
  {
    skillId: 'checkpoint.approval',
    name: 'Ask for approval',
    description:
      'Stops the workflow until you approve or reject. Steps that depend on it run only after approval.',
    inputs: [
      {
        name: 'question',
        required: true,
        description: 'What you are asked to approve.'
      }
    ],
    producesOutput: false,
    permissions: [],
    available: true,
    minTimeoutMs: 1_000,
    checkpoint: 'approval',
    runner: 'builtin'
  },
  {
    skillId: 'computer.notepad_write',
    name: 'Write a text file with Notepad',
    description:
      'Opens the real Notepad, types the text into its editor, saves it on the Desktop under the given name through Notepad’s Save As dialog, reads the saved file back to check it, and closes Notepad. Needs Windows.',
    inputs: [
      { name: 'text', required: true, description: 'The exact text to type and save.' },
      {
        name: 'fileName',
        required: true,
        description:
          'A plain .txt file name, e.g. hello.txt. An existing file is never overwritten.'
      }
    ],
    producesOutput: true,
    permissions: ['computer.open_app', 'computer.manage_window', 'computer.type', 'files.write'],
    available: true,
    minTimeoutMs: 30_000,
    checkpoint: null,
    runner: 'computer'
  },
  {
    skillId: 'browser.read_page',
    name: 'Read a web page',
    description:
      'Opens the address in a temporary, isolated browser session, reads the page’s text and structure and captures it. The page’s text is the output, labelled as untrusted data: nothing it says is followed. The task stops if the page leads to another site.',
    inputs: [
      {
        name: 'url',
        required: true,
        description: 'The http(s) address to read, e.g. https://example.com/page.'
      }
    ],
    producesOutput: true,
    permissions: ['browser.navigate', 'browser.read'],
    available: true,
    minTimeoutMs: 30_000,
    checkpoint: null,
    runner: 'browser'
  },
  {
    skillId: 'document.read_newest',
    name: 'Read the newest document in a folder',
    description:
      'Finds the most recently modified file of a format in an approved folder (Downloads, Documents, Desktop or the Mission’s workspace) by its real modified time, reports which file it is, and reads it in the document runtime. The text is the output, labelled as untrusted data with its source.',
    inputs: [
      { name: 'root', required: true, description: 'downloads, documents, desktop or workspace.' },
      {
        name: 'format',
        required: true,
        description: 'The file format: txt, md, csv, json, pdf, docx, pptx or xlsx.'
      },
      {
        name: 'nameContains',
        required: false,
        description: 'Only files whose name contains this text.'
      }
    ],
    producesOutput: true,
    permissions: ['files.list', 'files.read'],
    available: true,
    minTimeoutMs: 30_000,
    checkpoint: null,
    runner: 'files'
  },
  {
    skillId: 'document.read',
    name: 'Read a document',
    description:
      'Reads one file (TXT, Markdown, CSV, JSON, PDF, DOCX, PPTX or XLSX) in an approved folder, in the document runtime. The text is the output, labelled as untrusted data with its source.',
    inputs: [
      { name: 'root', required: true, description: 'downloads, documents, desktop or workspace.' },
      {
        name: 'path',
        required: true,
        description: 'The file’s path inside that folder, e.g. reports/q3.pdf.'
      }
    ],
    producesOutput: true,
    permissions: ['files.read'],
    available: true,
    minTimeoutMs: 30_000,
    checkpoint: null,
    runner: 'files'
  },
  {
    skillId: 'document.create',
    name: 'Create a document',
    description:
      'Creates a new file in the Mission’s workspace from text: DOCX or PDF (# headings, - bullets, paragraphs), PPTX (a title slide, then a slide per ## section), XLSX or CSV (CSV text; never formulas), JSON, TXT or Markdown. It is checked before it is kept and appears among the Mission’s files with its verification.',
    inputs: [
      {
        name: 'format',
        required: true,
        description: 'docx, pptx, xlsx, pdf, csv, json, txt or md.'
      },
      {
        name: 'name',
        required: true,
        description: 'The file name, ending in the format, e.g. summary.docx.'
      },
      {
        name: 'content',
        required: true,
        description:
          'The text to put in it. May include the output of earlier steps as {{step-id}}.'
      }
    ],
    producesOutput: true,
    permissions: ['artifacts.create'],
    available: true,
    minTimeoutMs: 30_000,
    checkpoint: null,
    runner: 'files'
  },
  {
    skillId: 'memory.recall',
    name: 'Recall from memory',
    description:
      'Looks up what Jupiter remembers that matches the query (working memory): active, non-sensitive memories with their type, source and confidence. The output is fenced as data. Sensitive memories are never recalled.',
    inputs: [
      { name: 'query', required: true, description: 'What to look for, e.g. "tea preferences".' },
      {
        name: 'limit',
        required: false,
        description: 'At most this many memories (1–20; 10 if empty).'
      }
    ],
    producesOutput: true,
    permissions: ['memory.read'],
    available: true,
    minTimeoutMs: 10_000,
    checkpoint: null,
    runner: 'memory'
  },
  {
    skillId: 'notes.search',
    name: 'Search notes',
    description:
      'Searches the notes in the connected Obsidian vault for the words given and returns the matching notes with a short excerpt, labelled as untrusted data.',
    inputs: [{ name: 'query', required: true, description: 'The words to look for.' }],
    producesOutput: true,
    permissions: ['notes.read'],
    available: true,
    minTimeoutMs: 20_000,
    checkpoint: null,
    runner: 'notes'
  },
  {
    skillId: 'notes.read',
    name: 'Read a note',
    description:
      'Reads one Markdown note in the connected Obsidian vault. Its text is the output, labelled as untrusted data with its path.',
    inputs: [
      {
        name: 'path',
        required: true,
        description: 'The note’s path inside the vault, e.g. Projects/Jupiter.md.'
      }
    ],
    producesOutput: true,
    permissions: ['notes.read'],
    available: true,
    minTimeoutMs: 10_000,
    checkpoint: null,
    runner: 'notes'
  },
  {
    skillId: 'notes.create',
    name: 'Create a note',
    description:
      'Creates a new Markdown note in the connected Obsidian vault (never replacing one), with frontmatter, the text, links to existing notes and a backlink in each of them.',
    inputs: [
      { name: 'title', required: true, description: 'The note’s title (also its file name).' },
      {
        name: 'content',
        required: true,
        description: 'The note’s text (Markdown). May include earlier outputs as {{step-id}}.'
      },
      {
        name: 'folder',
        required: false,
        description:
          'A folder inside the vault, e.g. Projects (Jupiter Brain or the vault top if empty).'
      },
      { name: 'tags', required: false, description: 'Comma-separated tags.' },
      {
        name: 'links',
        required: false,
        description: 'Comma-separated titles of existing notes to link to.'
      }
    ],
    producesOutput: true,
    permissions: ['notes.write'],
    available: true,
    minTimeoutMs: 20_000,
    checkpoint: null,
    runner: 'notes'
  },
  {
    skillId: 'checkpoint.identity',
    name: 'Confirm identity',
    description:
      'Coming later: identity verification arrives with the Identity and Authorization Engine (SET 14). A plan that needs it cannot run yet.',
    inputs: [
      {
        name: 'reason',
        required: true,
        description: 'Why identity must be confirmed.'
      }
    ],
    producesOutput: false,
    permissions: [],
    available: false,
    minTimeoutMs: 1_000,
    checkpoint: 'identity',
    runner: 'builtin'
  }
]

const BY_ID = new Map(STEP_TYPES.map((type) => [type.skillId, type]))

export function stepType(skillId: string): StepTypeDefinition | null {
  return BY_ID.get(skillId) ?? null
}

/**
 * A registered Skill as a workflow step type. Plan inputs are text, so a
 * Skill whose input fields are not all text cannot be a step (yet).
 */
export function skillStepType(info: SkillInfo): StepTypeDefinition {
  const { definition } = info
  const fields = Object.entries(definition.inputSchema.properties ?? {})
  const textInputs = fields.every(([, schema]) => schema.type === 'string')
  const available =
    info.enabled && info.runtimeCompatible && info.health.status !== 'UNHEALTHY' && textInputs
  const why = !textInputs
    ? ' Not usable as a workflow step: its inputs are not all text.'
    : info.blockedReason
      ? ` Cannot run now: ${info.blockedReason}`
      : ''
  return {
    skillId: definition.skillId,
    name: definition.name,
    description: `${definition.description}${why}`.slice(0, 400),
    inputs: fields.slice(0, 10).map(([name, schema]) => ({
      name,
      required: definition.inputSchema.required?.includes(name) ?? false,
      description: (schema.description ?? '').slice(0, 200)
    })),
    producesOutput: true,
    permissions: [...definition.permissions],
    available,
    minTimeoutMs: 1_000,
    checkpoint: null,
    runner: 'skill'
  }
}

/** Built-in step types plus the given Skills, without duplicates (built-in ids win). */
export function catalogueWith(skills: readonly StepTypeDefinition[]): {
  readonly types: readonly StepTypeDefinition[]
  readonly lookup: StepTypeLookup
} {
  const types = [...STEP_TYPES, ...skills.filter((skill) => !BY_ID.has(skill.skillId))]
  const byId = new Map(types.map((type) => [type.skillId, type]))
  return { types, lookup: (skillId) => byId.get(skillId) ?? null }
}

/** What the `missions.step-types` query returns. */
export function stepTypeInfo(types: readonly StepTypeDefinition[] = STEP_TYPES): StepTypeInfo[] {
  return types.map((type) => ({
    skillId: type.skillId,
    name: type.name,
    description: type.description,
    inputs: type.inputs.map((input) => ({ ...input })),
    producesOutput: type.producesOutput,
    permissions: [...type.permissions],
    available: type.available
  }))
}
