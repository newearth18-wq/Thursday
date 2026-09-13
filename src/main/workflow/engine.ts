import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  WorkflowNode,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunStatus
} from '@shared/schemas.js'
import { all, fromJson, get, run as dbRun, toJson } from '../core/db.js'
import { emit } from '../core/events.js'
import { describeError, log } from '../core/logger.js'
import { invokeSkill } from '../skills/registry.js'
import { resolveProvider } from '../ai/router.js'

/**
 * Workflow Engine.
 *
 * A workflow is an ordered list of nodes executed one at a time. Branching is
 * explicit (`next`, `onTrue`, `onFalse`) rather than a general graph, and
 * there is no visual canvas in Alpha — the execution model comes first.
 */

const MAX_NODE_VISITS = 100

export interface WorkflowHooks {
  /** Provided by the browser core so a workflow can open a page. */
  openTab(url: string): { id: string; url: string }
  /** Root for the `file` node type. Everything is confined inside it. */
  fileRoot: string
}

let hooks: WorkflowHooks = {
  openTab: () => {
    throw new Error('The browser core is not ready yet')
  },
  fileRoot: ''
}

export function setWorkflowHooks(next: WorkflowHooks): void {
  hooks = next
}

interface RunControl {
  cancelled: boolean
  approval: { resolve(approved: boolean): void } | null
}

const active = new Map<string, RunControl>()

/* ---------------------------- definitions ---------------------------- */

export function listWorkflows(): WorkflowDefinition[] {
  return all('SELECT * FROM workflows ORDER BY created_at DESC').map((row) => ({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    nodes: fromJson<WorkflowDefinition['nodes']>(row.nodes, []),
    createdAt: Number(row.created_at)
  }))
}

export function getWorkflow(id: string): WorkflowDefinition | null {
  return listWorkflows().find((workflow) => workflow.id === id) ?? null
}

export function saveWorkflow(input: {
  id?: string
  name: string
  description?: string
  nodes: unknown[]
}): WorkflowDefinition {
  const nodes = input.nodes.map((node, index) => {
    const parsed = WorkflowNode.safeParse(node)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new Error(`Node ${index + 1} is invalid — ${detail}`)
    }
    return parsed.data
  })
  if (nodes.length === 0) throw new Error('A workflow needs at least one node')

  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Two nodes share the id "${node.id}"`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const [field, target] of [
      ['next', node.next],
      ['onTrue', node.onTrue],
      ['onFalse', node.onFalse]
    ] as const) {
      if (target && !ids.has(target)) {
        throw new Error(`Node "${node.id}" points ${field} at "${target}", which does not exist`)
      }
    }
  }

  const id = input.id ?? randomUUID()
  const existing = get('SELECT id FROM workflows WHERE id = ?', id)
  if (existing) {
    dbRun(
      'UPDATE workflows SET name = ?, description = ?, nodes = ? WHERE id = ?',
      input.name,
      input.description ?? '',
      toJson(nodes),
      id
    )
  } else {
    dbRun(
      'INSERT INTO workflows(id, name, description, nodes, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      input.name,
      input.description ?? '',
      toJson(nodes),
      Date.now()
    )
  }
  log.info('WORKFLOW', `Workflow ${existing ? 'updated' : 'created'}: ${input.name}`, {
    workflowId: id,
    nodes: nodes.length
  })
  const saved = getWorkflow(id)
  if (!saved) throw new Error(`Workflow ${id} could not be read back after saving`)
  return saved
}

export function deleteWorkflow(id: string): void {
  if (!getWorkflow(id)) throw new Error(`No workflow with id ${id}`)
  dbRun('DELETE FROM workflow_runs WHERE workflow_id = ?', id)
  dbRun('DELETE FROM workflows WHERE id = ?', id)
  log.info('WORKFLOW', 'Workflow deleted', { workflowId: id })
}

/* -------------------------------- runs -------------------------------- */

export function listRuns(workflowId?: string): WorkflowRun[] {
  const rows = workflowId
    ? all('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 100', workflowId)
    : all('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT 100')
  return rows.map(rowToRun)
}

export function getRun(id: string): WorkflowRun | null {
  const row = get('SELECT * FROM workflow_runs WHERE id = ?', id)
  return row ? rowToRun(row) : null
}

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    status: String(row.status) as WorkflowRunStatus,
    currentNodeId: row.current_node_id === null ? null : String(row.current_node_id),
    context: fromJson<Record<string, unknown>>(row.context, {}),
    log: fromJson<WorkflowRun['log']>(row.log, []),
    error: row.error === null ? null : String(row.error),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at)
  }
}

function persist(run: WorkflowRun): WorkflowRun {
  dbRun(
    'UPDATE workflow_runs SET status = ?, current_node_id = ?, context = ?, log = ?, error = ?, started_at = ?, completed_at = ? WHERE id = ?',
    run.status,
    run.currentNodeId,
    toJson(run.context),
    toJson(run.log),
    run.error,
    run.startedAt,
    run.completedAt,
    run.id
  )
  emit('workflow:update', run)
  return run
}

export function startRun(workflowId: string, input: Record<string, unknown> = {}): WorkflowRun {
  const workflow = getWorkflow(workflowId)
  if (!workflow) throw new Error(`No workflow with id ${workflowId}`)

  const now = Date.now()
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowId,
    status: 'running',
    currentNodeId: workflow.nodes[0]?.id ?? null,
    context: { ...input },
    log: [],
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now
  }
  dbRun(
    'INSERT INTO workflow_runs(id, workflow_id, status, current_node_id, context, log, error, started_at, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    run.id,
    run.workflowId,
    run.status,
    run.currentNodeId,
    toJson(run.context),
    toJson(run.log),
    null,
    run.startedAt,
    null,
    run.createdAt
  )

  const control: RunControl = { cancelled: false, approval: null }
  active.set(run.id, control)
  log.info('WORKFLOW', `Run started for "${workflow.name}"`, { runId: run.id, workflowId })

  void executeRun(run.id, workflow, control).catch((err: unknown) => {
    const current = getRun(run.id)
    if (!current) return
    current.status = 'failed'
    current.error = describeError(err)
    current.completedAt = Date.now()
    persist(current)
    active.delete(run.id)
  })

  emit('workflow:update', run)
  return run
}

export function approveRun(runId: string, approved: boolean): WorkflowRun {
  const control = active.get(runId)
  const run = getRun(runId)
  if (!run) throw new Error(`No workflow run with id ${runId}`)
  if (run.status !== 'waiting_approval') {
    throw new Error(`Run ${runId} is ${run.status}, not waiting for approval`)
  }
  if (!control?.approval) {
    throw new Error('This run is no longer waiting for approval. Start it again to continue.')
  }
  control.approval.resolve(approved)
  control.approval = null
  return getRun(runId) ?? run
}

export function cancelRun(runId: string): WorkflowRun {
  const control = active.get(runId)
  const run = getRun(runId)
  if (!run) throw new Error(`No workflow run with id ${runId}`)
  if (control) {
    control.cancelled = true
    control.approval?.resolve(false)
    control.approval = null
  }
  run.status = 'cancelled'
  run.completedAt = Date.now()
  run.currentNodeId = null
  log.info('WORKFLOW', 'Run cancelled', { runId })
  return persist(run)
}

/* ------------------------------ execution ----------------------------- */

async function executeRun(
  runId: string,
  workflow: WorkflowDefinition,
  control: RunControl
): Promise<void> {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  let run = getRun(runId)
  if (!run) return

  let cursor: string | null = workflow.nodes[0]?.id ?? null
  let visits = 0

  try {
    while (cursor) {
      if (control.cancelled) return
      if (++visits > MAX_NODE_VISITS) {
        throw new Error(
          `Workflow stopped after visiting ${MAX_NODE_VISITS} nodes — the node graph probably loops`
        )
      }

      const node = byId.get(cursor)
      if (!node) throw new Error(`Node "${cursor}" does not exist in this workflow`)

      run = getRun(runId)
      if (!run) return
      run.currentNodeId = node.id
      run.status = 'running'
      persist(run)

      const outcome = await executeNode(node, run, control, runId)
      if (control.cancelled) return

      run = getRun(runId)
      if (!run) return
      run.context = outcome.context
      run.log = [
        ...run.log,
        { ts: Date.now(), nodeId: node.id, message: outcome.message, ok: outcome.ok }
      ]
      persist(run)

      if (!outcome.ok) {
        run.status = 'failed'
        run.error = outcome.message
        run.completedAt = Date.now()
        run.currentNodeId = null
        persist(run)
        log.error('WORKFLOW', `Run failed at node "${node.label}": ${outcome.message}`, { runId })
        return
      }

      const orderIndex = workflow.nodes.findIndex((candidate) => candidate.id === node.id)
      const fallthrough = workflow.nodes[orderIndex + 1]?.id ?? null
      cursor = outcome.next !== undefined ? outcome.next : (node.next ?? fallthrough)
    }

    run = getRun(runId)
    if (!run) return
    run.status = 'completed'
    run.completedAt = Date.now()
    run.currentNodeId = null
    persist(run)
    log.info('WORKFLOW', `Run completed for "${workflow.name}"`, { runId, nodes: visits })
  } finally {
    active.delete(runId)
  }
}

interface NodeOutcome {
  ok: boolean
  message: string
  context: Record<string, unknown>
  /** Explicit branch target; undefined means "use the node's own next". */
  next?: string | null
}

async function executeNode(
  node: WorkflowNode,
  run: WorkflowRun,
  control: RunControl,
  runId: string
): Promise<NodeOutcome> {
  const context = { ...run.context }
  const config = node.config as Record<string, unknown>
  const text = (key: string): string => interpolate(String(config[key] ?? ''), context)
  const outKey = typeof config.outputKey === 'string' ? config.outputKey : node.id

  try {
    switch (node.type) {
      case 'ai': {
        const providerId = String(config.providerId ?? '')
        const model = String(config.model ?? '')
        if (!providerId || !model) {
          return fail('This AI node has no provider or model configured', context)
        }
        const provider = resolveProvider(providerId)
        let answer = ''
        for await (const chunk of provider.chat(
          {
            providerId,
            model,
            messages: [{ role: 'user', content: text('prompt') }]
          },
          [],
          AbortSignal.timeout(120_000)
        )) {
          if (chunk.type === 'text') answer += chunk.text
          if (chunk.type === 'error') return fail(chunk.message, context)
        }
        context[outKey] = answer
        return { ok: true, message: `Model replied with ${answer.length} characters`, context }
      }

      case 'skill': {
        const skillId = String(config.skillId ?? '')
        if (!skillId) return fail('This skill node has no skillId configured', context)
        const rawInput =
          config.input && typeof config.input === 'object' && !Array.isArray(config.input)
            ? (config.input as Record<string, unknown>)
            : {}
        const result = await invokeSkill(skillId, interpolateDeep(rawInput, context))
        if (!result.ok) return fail(`${skillId}: ${result.error}`, context)
        context[outKey] = result.output
        return { ok: true, message: `${skillId} completed`, context }
      }

      case 'condition': {
        const left = interpolate(String(config.left ?? ''), context)
        const right = interpolate(String(config.right ?? ''), context)
        const operator = String(config.operator ?? 'equals')
        const passed = compare(left, right, operator)
        return {
          ok: true,
          message: `"${left}" ${operator} "${right}" → ${passed}`,
          context,
          next: passed ? node.onTrue : node.onFalse
        }
      }

      case 'wait': {
        const ms = Math.min(Math.max(Number(config.ms ?? 1000), 0), 60_000)
        await new Promise((r) => setTimeout(r, ms))
        return { ok: true, message: `Waited ${ms}ms`, context }
      }

      case 'human_approval': {
        const current = getRun(runId)
        if (current) {
          current.status = 'waiting_approval'
          persist(current)
        }
        log.info('WORKFLOW', `Waiting for approval: ${node.label}`, { runId })
        const approved = await new Promise<boolean>((resolveApproval) => {
          control.approval = { resolve: resolveApproval }
        })
        if (control.cancelled) return { ok: false, message: 'Cancelled', context }
        if (!approved) return fail('Rejected by the user', context)
        return { ok: true, message: 'Approved by the user', context }
      }

      case 'file': {
        const action = String(config.action ?? 'write')
        const target = confineToRoot(text('path'))
        if (action === 'write') {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, text('content'), 'utf8')
          context[outKey] = target
          return { ok: true, message: `Wrote ${target}`, context }
        }
        if (action === 'read') {
          context[outKey] = await readFile(target, 'utf8')
          return { ok: true, message: `Read ${target}`, context }
        }
        return fail(`Unknown file action "${action}" — use "read" or "write"`, context)
      }

      case 'browser': {
        const action = String(config.action ?? 'open')
        if (action !== 'open') {
          return fail(`Unknown browser action "${action}" — only "open" is available in Alpha`, context)
        }
        const url = text('url')
        if (!url) return fail('This browser node has no url configured', context)
        const tab = hooks.openTab(url)
        context[outKey] = tab.url
        return { ok: true, message: `Opened ${tab.url}`, context }
      }

      case 'output': {
        const value = config.value !== undefined ? interpolate(String(config.value), context) : context
        context.__output = value
        return { ok: true, message: 'Output recorded', context }
      }

      default: {
        const exhaustive: never = node.type
        return fail(`Unsupported node type "${String(exhaustive)}"`, context)
      }
    }
  } catch (err) {
    return fail(describeError(err), context)
  }
}

const fail = (message: string, context: Record<string, unknown>): NodeOutcome => ({
  ok: false,
  message,
  context
})

function compare(left: string, right: string, operator: string): boolean {
  switch (operator) {
    case 'equals':
      return left === right
    case 'not_equals':
      return left !== right
    case 'contains':
      return left.includes(right)
    case 'greater_than':
      return Number(left) > Number(right)
    case 'less_than':
      return Number(left) < Number(right)
    case 'is_empty':
      return left.trim().length === 0
    default:
      throw new Error(
        `Unknown condition operator "${operator}". Use equals, not_equals, contains, greater_than, less_than or is_empty.`
      )
  }
}

/** Replace {{key}} with the context value. No expression evaluation. */
function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = context[key]
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

function interpolateDeep(value: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = interpolate(entry, context)
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out[key] = interpolateDeep(entry as Record<string, unknown>, context)
    } else out[key] = entry
  }
  return out
}

/** `file` nodes may only touch paths inside the workflow file root. */
function confineToRoot(path: string): string {
  if (!path) throw new Error('This file node has no path configured')
  if (!hooks.fileRoot) throw new Error('The workflow file root is not configured')
  if (isAbsolute(path)) {
    throw new Error('Absolute paths are not allowed; use a path relative to the workflow files directory')
  }
  const root = resolve(hooks.fileRoot)
  const target = resolve(join(root, path))
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('Path escapes the workflow files directory')
  }
  return target
}
