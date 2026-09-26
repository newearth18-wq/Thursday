import type {
  ActorType,
  ComputerAction,
  ComputerActionResult,
  ComputerAppId,
  ComputerEvidence,
  ComputerStatus,
  ComputerTask,
  ComputerTaskRequest,
  DomainEventType,
  ElementQuery,
  ErrorEnvelope,
  EventPayload,
  InteractionMethod,
  PermissionSubject,
  WindowInfo
} from '@jupiter/contracts'
import { redactString } from '@jupiter/security'
import { JupiterError, createErrorEnvelope, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import type { PermissionEngine } from '../permissions/engine'
import type { DatabasePort } from '../ports'
import { ADAPTERS, waitFor, type AdapterContext } from './adapters'
import type { ComputerDriver } from './driver'

/**
 * The Windows Computer Agent (SET 8).
 *
 * A task is a list of typed actions, run one at a time. Before anything
 * runs, every permission the task needs is checked; the missing ones are
 * asked for together and the task waits (WAITING_APPROVAL) without touching
 * the computer. Each action is checked again by the Permission Engine when
 * it runs (a single-use answer is used up then).
 *
 * Every action returns what was really observed. Typing reads the text back,
 * saving reads the file back, window operations read the window's state
 * back: an action whose effect is not there is a failure, never a success.
 * Windows are found again for every action (a stale handle is re-resolved)
 * and controls are always found by what they are, not where they are.
 * Cancel stops the task before its next action; an action already under
 * way finishes its current step (the safest boundary) and nothing after it
 * runs.
 */

export interface ComputerAgentOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly driver: ComputerDriver
  readonly sleep?: (ms: number) => Promise<void>
}

export interface ComputerRunContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly missionId?: string | null
  readonly missionTitle?: string | null
  readonly stepId?: string | null
  readonly stepTitle?: string | null
  readonly signal?: AbortSignal
}

export const COMPUTER_AGENT: PermissionSubject = {
  kind: 'agent',
  id: 'computer',
  name: 'Windows Computer Agent'
}

interface Requirement {
  readonly capability: string
  readonly target: string
}

interface Outcome {
  readonly target: string
  readonly method: InteractionMethod
  readonly observation: string
  readonly evidence?: ComputerEvidence | null
}

interface Running {
  readonly controller: AbortController
}

const OPEN_TIMEOUT_MS = 15_000
const RESOLVE_ATTEMPTS = 4
const RESOLVE_PAUSE_MS = 400

export class ComputerAgent {
  private readonly running = new Map<string, Running>()

  constructor(private readonly options: ComputerAgentOptions) {}

  /** Tasks a Core stop cut off are recorded as failed; none is run again by itself. */
  start(): void {
    const database = this.options.database()
    for (const task of database.computer.running()) {
      const error = createErrorEnvelope({
        code: 'COMPUTER_TASK_INTERRUPTED',
        category: 'internal',
        message:
          'Jupiter Core stopped while this task was running; the actions after the last recorded one did not run.',
        userAction: 'Check the application, then run the task again if needed.',
        retryable: true
      })
      database.computer.save({ ...task, status: 'FAILED', error, completedAt: this.now() })
    }
  }

  async status(): Promise<ComputerStatus> {
    return this.options.driver.call('status', {})
  }

  tasks(limit: number): ComputerTask[] {
    return this.options.database().computer.tasks(limit)
  }

  cancel(taskId: string): boolean {
    const running = this.running.get(taskId)
    if (!running) return false
    running.controller.abort()
    return true
  }

  async run(request: ComputerTaskRequest, context: ComputerRunContext): Promise<ComputerTask> {
    const database = this.options.database()
    if (database.computer.task(request.taskId) || this.running.has(request.taskId))
      throw new JupiterError('COMPUTER_TASK_EXISTS', 'A task with this id already exists.', {
        category: 'validation',
        userAction: 'Use a new task id.'
      })
    let task: ComputerTask = {
      taskId: request.taskId,
      missionId: context.missionId ?? null,
      title: request.title,
      status: 'RUNNING',
      actions: request.actions.map((action) => ({ type: action.type, app: appOf(action) })),
      results: [],
      error: null,
      permissionRequests: [],
      allowCoordinateFallback: request.allowCoordinateFallback,
      createdAt: this.now(),
      completedAt: null
    }
    const controller = new AbortController()
    const forward = () => {
      controller.abort()
    }
    context.signal?.addEventListener('abort', forward, { once: true })
    this.running.set(request.taskId, { controller })
    database.transactions.run(() => {
      database.computer.save(task)
      this.publish(
        task.taskId,
        'computer.task_started',
        { taskId: task.taskId, actions: request.actions.length },
        context
      )
    })
    try {
      task = await this.execute(task, request, context, controller.signal)
    } catch (error) {
      task = this.finish(
        task,
        'FAILED',
        toErrorEnvelope(error, {
          code: 'COMPUTER_TASK_FAILED',
          category: 'internal',
          userAction: null,
          retryable: false
        }),
        context
      )
    } finally {
      this.running.delete(request.taskId)
      context.signal?.removeEventListener('abort', forward)
    }
    return task
  }

  // ---- the task ---------------------------------------------------------------------------

  private async execute(
    initial: ComputerTask,
    request: ComputerTaskRequest,
    context: ComputerRunContext,
    signal: AbortSignal
  ): Promise<ComputerTask> {
    let task = initial
    // The coordinate fallback is refused unless the task allows it, before anything runs.
    if (
      !request.allowCoordinateFallback &&
      request.actions.some((action) => action.type === 'CLICK_POINT')
    )
      return this.finish(
        task,
        'FAILED',
        envelope(
          'COORDINATE_FALLBACK_DISABLED',
          'validation',
          'The task clicks a screen position (coordinate fallback), which it does not allow.',
          'Use a control query instead, or allow the coordinate fallback for this task.'
        ),
        context
      )
    const status = await this.options.driver.call('status', {}, signal)
    if (!status.available)
      return this.finish(
        task,
        'FAILED',
        envelope(
          'COMPUTER_UNAVAILABLE',
          'unsupported',
          status.reason ?? 'The Computer Agent is not available.',
          null
        ),
        context
      )

    // Every permission first: ask for all the missing ones at once; touch nothing until they are given.
    const requirements = await this.requirements(request.actions, signal)
    const missing: string[] = []
    for (const [index, requirement] of requirements.entries()) {
      const outcome = this.options.permissions.check({
        capability: requirement.capability,
        subject: COMPUTER_AGENT,
        actor: context.actor,
        target: requirement.target,
        reason: `${request.title}: ${describeAction(request.actions[index])}`,
        missionId: context.missionId ?? null,
        missionTitle: context.missionTitle ?? null,
        stepId: context.stepId ?? null,
        stepTitle: context.stepTitle ?? null,
        askIfNeeded: true,
        evaluateOnly: true
      })
      if (!outcome.allowed) {
        if (outcome.code === 'PERMISSION_UNKNOWN')
          return this.finish(
            task,
            'FAILED',
            envelope('PERMISSION_UNKNOWN', 'permission', outcome.message, null),
            context
          )
        if (outcome.requestId && !missing.includes(outcome.requestId))
          missing.push(outcome.requestId)
      }
    }
    if (missing.length > 0) {
      task = { ...task, permissionRequests: missing }
      return this.finish(
        task,
        'WAITING_APPROVAL',
        envelope(
          'PERMISSION_REQUIRED',
          'permission',
          `The task needs ${String(missing.length)} permission${missing.length === 1 ? '' : 's'} before it can start; nothing was done yet.`,
          'Answer the permission requests, then run the task again.',
          { requestId: missing[0] ?? '' }
        ),
        context
      )
    }

    const windows = new Map<ComputerAppId, number>()
    for (const [index, action] of request.actions.entries()) {
      if (signal.aborted)
        return this.finish(
          task,
          'CANCELLED',
          envelope(
            'CANCELLED',
            'cancellation',
            `Cancelled before action ${String(index + 1)} (${action.type}); it and the actions after it did not run.`,
            null
          ),
          context
        )
      const requirement = requirements[index]
      const startedAt = this.now()
      let result: ComputerActionResult
      const allowed = requirement
        ? this.options.permissions.check({
            capability: requirement.capability,
            subject: COMPUTER_AGENT,
            actor: context.actor,
            target: requirement.target,
            reason: `${request.title}: ${describeAction(action)}`,
            missionId: context.missionId ?? null,
            askIfNeeded: false
          })
        : null
      if (allowed && !allowed.allowed) {
        result = this.failed(
          index,
          action,
          startedAt,
          envelope(
            'PERMISSION_REQUIRED',
            'permission',
            allowed.message,
            'Give the permission again, then run the task again.'
          )
        )
      } else {
        try {
          const outcome = await this.perform(action, windows, signal)
          result = {
            index,
            action: action.type,
            target: redactString(outcome.target, 500),
            success: true,
            method: outcome.method,
            observation: redactString(outcome.observation, 2000),
            evidence: outcome.evidence ?? null,
            error: null,
            startedAt,
            completedAt: this.now()
          }
        } catch (error) {
          result = this.failed(
            index,
            action,
            startedAt,
            toErrorEnvelope(error, {
              code: 'COMPUTER_ACTION_FAILED',
              category: 'internal',
              userAction: null,
              retryable: false
            })
          )
        }
      }
      task = { ...task, results: [...task.results, result] }
      const database = this.options.database()
      const saved = task
      database.transactions.run(() => {
        database.computer.save(saved)
        this.publish(
          saved.taskId,
          'computer.action_completed',
          {
            taskId: saved.taskId,
            index,
            action: action.type,
            success: result.success,
            method: result.method,
            errorCode: result.error?.code.slice(0, 64) ?? null
          },
          context
        )
      })
      if (!result.success) {
        const cancelled = aborted(signal) && result.error?.category === 'cancellation'
        return this.finish(task, cancelled ? 'CANCELLED' : 'FAILED', result.error, context)
      }
    }
    return this.finish(task, 'SUCCEEDED', null, context)
  }

  /** What each action needs from the Permission Engine, with its exact target. */
  private async requirements(
    actions: readonly ComputerAction[],
    signal: AbortSignal
  ): Promise<Requirement[]> {
    const result: Requirement[] = []
    for (const action of actions) {
      const app = (window: { app: ComputerAppId } | null) =>
        window ? `app:${window.app}` : 'screen:all'
      switch (action.type) {
        case 'OPEN_APP':
          result.push({ capability: 'computer.open_app', target: `app:${action.app}` })
          break
        case 'CLOSE_APP':
        case 'FOCUS_WINDOW':
        case 'MANAGE_WINDOW':
        case 'WAIT_FOR_WINDOW':
          result.push({ capability: 'computer.manage_window', target: app(action.window) })
          break
        case 'LIST_WINDOWS':
          result.push({ capability: 'computer.read_screen', target: 'desktop:window-list' })
          break
        case 'READ_UI_TREE':
          result.push({ capability: 'computer.read_screen', target: app(action.window) })
          break
        case 'SCREENSHOT':
          result.push({ capability: 'computer.read_screen', target: app(action.window) })
          break
        case 'CLICK_ELEMENT':
        case 'SCROLL':
        case 'SELECT_ELEMENT':
          result.push({ capability: 'computer.click', target: app(action.window) })
          break
        case 'TYPE_TEXT':
        case 'PRESS_KEYS':
          result.push({ capability: 'computer.type', target: app(action.window) })
          break
        case 'SAVE_FILE': {
          // The exact file: the host decides the folder, the permission names the full path.
          const { path } = await this.options.driver.call(
            'resolveSavePath',
            { fileName: action.fileName },
            signal
          )
          result.push({ capability: 'files.write', target: path })
          break
        }
        case 'CLICK_POINT':
          result.push({ capability: 'computer.click_point', target: app(action.window) })
          break
      }
    }
    return result
  }

  // ---- actions ----------------------------------------------------------------------------

  private async perform(
    action: ComputerAction,
    windows: Map<ComputerAppId, number>,
    signal: AbortSignal
  ): Promise<Outcome> {
    const { driver } = this.options
    const adapterContext: AdapterContext = { driver, signal, sleep: this.sleep }
    switch (action.type) {
      case 'OPEN_APP': {
        const adapter = ADAPTERS[action.app]
        const before = new Set(
          (await driver.call('listWindows', {}, signal)).windows.map((item) => item.handle)
        )
        const launched = await driver.call('launch', { app: action.app }, signal)
        const window = await waitFor(adapterContext, OPEN_TIMEOUT_MS, async () => {
          const { windows: now } = await driver.call('listWindows', {}, signal)
          return now.find((item) => adapter.owns(item) && !before.has(item.handle)) ?? null
        })
        if (!window)
          throw cancelledOr(
            signal,
            new JupiterError(
              'WINDOW_NOT_FOUND',
              `${adapter.name} was started (process ${String(launched.processId)}) but no new window appeared within ${String(OPEN_TIMEOUT_MS / 1000)} s.`,
              {
                category: 'dependency',
                userAction: `Check whether ${adapter.name} opened, then try again.`
              }
            )
          )
        windows.set(action.app, window.handle)
        return {
          target: adapter.name,
          method: 'system',
          observation: `Opened ${adapter.name}: a new window "${window.title}" appeared (handle ${String(window.handle)}, process ${String(window.processId)}).`
        }
      }
      case 'CLOSE_APP': {
        const window = await this.resolve(action.window, windows, signal)
        await driver.call('windowOp', { handle: window.handle, operation: 'close' }, signal)
        const { windows: now } = await driver.call('listWindows', {}, signal)
        if (now.some((item) => item.handle === window.handle))
          throw new JupiterError('WINDOW_STILL_OPEN', `"${window.title}" is still open.`, {
            category: 'dependency',
            userAction: null
          })
        windows.delete(action.window.app)
        return {
          target: label(window),
          method: 'semantic',
          observation: `Closed "${window.title}"; the window is gone.`
        }
      }
      case 'FOCUS_WINDOW': {
        const window = await this.resolve(action.window, windows, signal)
        const result = await driver.call(
          'windowOp',
          { handle: window.handle, operation: 'focus' },
          signal
        )
        if (!result.window?.active)
          throw new JupiterError(
            'FOCUS_FAILED',
            `"${window.title}" did not become the active window.`,
            { category: 'dependency', userAction: null }
          )
        return {
          target: label(window),
          method: 'semantic',
          observation: `"${window.title}" is now the active window.`
        }
      }
      case 'MANAGE_WINDOW': {
        const window = await this.resolve(action.window, windows, signal)
        const result = await driver.call(
          'windowOp',
          {
            handle: window.handle,
            operation: action.operation,
            ...(action.x === undefined ? {} : { x: action.x }),
            ...(action.y === undefined ? {} : { y: action.y }),
            ...(action.width === undefined ? {} : { width: action.width }),
            ...(action.height === undefined ? {} : { height: action.height })
          },
          signal
        )
        const after = result.window
        const applied =
          after !== null &&
          (action.operation === 'minimize'
            ? after.minimized
            : action.operation === 'restore' || action.operation === 'maximize'
              ? !after.minimized
              : action.operation === 'move'
                ? near(after.bounds.x, action.x) && near(after.bounds.y, action.y)
                : near(after.bounds.width, action.width) &&
                  near(after.bounds.height, action.height))
        if (after === null || !applied)
          throw new JupiterError(
            'WINDOW_STATE_NOT_APPLIED',
            `The window did not ${action.operation}; its state afterwards does not match.`,
            { category: 'dependency', userAction: null }
          )
        return {
          target: label(window),
          method: 'semantic',
          observation: `${action.operation}: the window is now at ${String(after.bounds.x)},${String(after.bounds.y)} size ${String(after.bounds.width)}×${String(after.bounds.height)}${after.minimized ? ', minimized' : ''}.`
        }
      }
      case 'LIST_WINDOWS': {
        const { windows: listed } = await driver.call('listWindows', {}, signal)
        const active = listed.find((item) => item.active)
        return {
          target: 'desktop',
          method: 'semantic',
          observation: `${String(listed.length)} windows; active: ${active ? `"${active.title}" (${active.processName})` : 'none'}. ${listed
            .slice(0, 20)
            .map((item) => `${item.processName}: "${item.title}"`)
            .join('; ')}`
        }
      }
      case 'WAIT_FOR_WINDOW': {
        const adapter = ADAPTERS[action.window.app]
        const found = await waitFor(adapterContext, action.timeoutMs, async () => {
          try {
            return await this.resolve(action.window, windows, signal)
          } catch (error) {
            if (error instanceof JupiterError && error.code === 'WINDOW_NOT_FOUND') return null
            throw error
          }
        })
        if (!found)
          throw cancelledOr(
            signal,
            new JupiterError(
              'WINDOW_NOT_FOUND',
              `No ${adapter.name} window${action.window.titleContains ? ` with "${action.window.titleContains}" in its title` : ''} appeared within ${String(action.timeoutMs)} ms.`,
              { category: 'timeout', userAction: null }
            )
          )
        return { target: label(found), method: 'semantic', observation: `Found "${found.title}".` }
      }
      case 'READ_UI_TREE': {
        const window = await this.resolve(action.window, windows, signal)
        const tree = await driver.call(
          'readTree',
          { handle: window.handle, depth: action.depth, maxNodes: action.maxNodes },
          signal
        )
        const lines = tree.nodes.map(
          (node) =>
            `${'  '.repeat(node.depth)}${node.controlType}${node.name ? ` "${node.name}"` : ''}${node.automationId ? ` #${node.automationId}` : ''}`
        )
        return {
          target: label(window),
          method: 'semantic',
          observation: `${String(tree.nodes.length)} controls${tree.truncated ? ' (truncated)' : ''}:\n${lines.join('\n')}`
        }
      }
      case 'CLICK_ELEMENT': {
        const window = await this.resolve(action.window, windows, signal)
        const query = await this.concrete(action.window.app, window, action.element, signal)
        const { element } = await driver.call('invoke', { handle: window.handle, query }, signal)
        return {
          target: `${label(window)} › ${describeElement(element)}`,
          method: 'semantic',
          observation: `Invoked ${describeElement(element)} through UI Automation.`
        }
      }
      case 'TYPE_TEXT':
        return this.typeText(action, windows, signal)
      case 'PRESS_KEYS': {
        const window = await this.resolve(action.window, windows, signal)
        const result = await driver.call(
          'sendKeys',
          { handle: window.handle, keys: action.keys },
          signal
        )
        return {
          target: label(window),
          method: 'keyboard',
          observation: `Pressed ${action.keys.join(', ')} in "${window.title}"; afterwards "${result.window.title}" is ${result.window.active ? 'active' : 'not active'}.`
        }
      }
      case 'SCROLL': {
        const window = await this.resolve(action.window, windows, signal)
        const query = await this.concrete(action.window.app, window, action.element, signal)
        const { element } = await driver.call(
          'scroll',
          {
            handle: window.handle,
            query,
            direction: action.direction,
            amount: action.amount
          },
          signal
        )
        return {
          target: `${label(window)} › ${describeElement(element)}`,
          method: 'semantic',
          observation: `Scrolled ${action.direction} ${String(action.amount)} step(s).`
        }
      }
      case 'SELECT_ELEMENT': {
        const window = await this.resolve(action.window, windows, signal)
        const query = await this.concrete(action.window.app, window, action.element, signal)
        const { element } = await driver.call('select', { handle: window.handle, query }, signal)
        return {
          target: `${label(window)} › ${describeElement(element)}`,
          method: 'semantic',
          observation: `${describeElement(element)} is selected.`
        }
      }
      case 'SCREENSHOT': {
        const window = action.window ? await this.resolve(action.window, windows, signal) : null
        const shot = await driver.call('screenshot', { handle: window?.handle ?? null }, signal)
        return {
          target: window ? label(window) : 'the whole screen',
          method: 'system',
          observation: `Captured ${String(shot.width)}×${String(shot.height)} pixels (${String(shot.bytes)} bytes).`,
          evidence: {
            kind: 'screenshot',
            file: shot.file,
            width: shot.width,
            height: shot.height,
            bytes: shot.bytes
          }
        }
      }
      case 'SAVE_FILE':
        return this.saveFile(action, windows, adapterContext, signal)
      case 'CLICK_POINT': {
        const window = await this.resolve(action.window, windows, signal)
        if (action.x >= window.bounds.width || action.y >= window.bounds.height)
          throw new JupiterError(
            'POINT_OUTSIDE_WINDOW',
            `The point (${String(action.x)}, ${String(action.y)}) is outside "${window.title}" (${String(window.bounds.width)}×${String(window.bounds.height)}); a coordinate click must stay inside its window.`,
            { category: 'validation', userAction: null }
          )
        const click = await driver.call(
          'clickPoint',
          { handle: window.handle, x: action.x, y: action.y },
          signal
        )
        return {
          target: `${label(window)} @ (${String(action.x)}, ${String(action.y)})`,
          method: 'coordinate',
          observation: `Coordinate fallback: clicked (${String(action.x)}, ${String(action.y)}) inside "${window.title}" (screen ${String(click.screenX)}, ${String(click.screenY)}). Reason: ${action.reason}. Which control was hit, and what it did, is not verified.`
        }
      }
    }
  }

  private async typeText(
    action: Extract<ComputerAction, { type: 'TYPE_TEXT' }>,
    windows: Map<ComputerAppId, number>,
    signal: AbortSignal
  ): Promise<Outcome> {
    const { driver } = this.options
    const window = await this.resolve(action.window, windows, signal)
    const query = await this.concrete(action.window.app, window, action.element, signal)
    const { element } = await driver.call('findElement', { handle: window.handle, query }, signal)
    const before = (await driver.call('readText', { handle: window.handle, query }, signal)).text
    let method: InteractionMethod
    // Semantic first: set the control's value (what it had, then the new text). Keyboard otherwise.
    if (element.patterns.includes('Value')) {
      // A read-only control fails here with ELEMENT_READ_ONLY: nothing was typed.
      await driver.call(
        'setValue',
        { handle: window.handle, query, text: before + action.text },
        signal
      )
      method = 'semantic'
    } else {
      await driver.call('typeText', { handle: window.handle, query, text: action.text }, signal)
      method = 'keyboard'
    }
    const after = (await driver.call('readText', { handle: window.handle, query }, signal)).text
    const expected = normalize(before + action.text)
    const ok =
      method === 'semantic'
        ? normalize(after) === expected
        : normalize(after).includes(normalize(action.text))
    if (!ok)
      throw new JupiterError(
        'ACTION_NOT_VERIFIED',
        `After typing, ${describeElement(element)} does not hold the text that was typed (${String(action.text.length)} characters expected, it holds ${String(after.length)}).`,
        {
          category: 'dependency',
          userAction: 'Look at the application; it may have changed or blocked the input.'
        }
      )
    return {
      target: `${label(window)} › ${describeElement(element)}`,
      method,
      observation: `Typed ${String(action.text.length)} characters ${method === 'semantic' ? 'through the Value pattern' : 'with the keyboard'}; reading ${describeElement(element)} back confirms the text is there.`
    }
  }

  private async saveFile(
    action: Extract<ComputerAction, { type: 'SAVE_FILE' }>,
    windows: Map<ComputerAppId, number>,
    context: AdapterContext,
    signal: AbortSignal
  ): Promise<Outcome> {
    const { driver } = this.options
    const adapter = ADAPTERS[action.window.app]
    if (!adapter.save || adapter.editor.length === 0)
      throw new JupiterError('SAVE_UNSUPPORTED', `${adapter.name} has no document to save.`, {
        category: 'unsupported',
        userAction: null
      })
    const window = await this.resolve(action.window, windows, signal)
    const target = await driver.call('resolveSavePath', { fileName: action.fileName }, signal)
    // Never overwrite a file silently.
    if (target.exists)
      throw new JupiterError(
        'FILE_EXISTS',
        `${target.path} already exists; Jupiter does not overwrite files.`,
        {
          category: 'validation',
          userAction: 'Choose another file name.'
        }
      )
    const expected =
      action.expectedText ??
      (
        await driver.call(
          'readText',
          {
            handle: window.handle,
            query: await this.concrete(action.window.app, window, { role: 'editor' }, signal)
          },
          signal
        )
      ).text
    const saved = await adapter.save(context, window, target.path)
    const check = await driver.call('verifyFile', { fileName: action.fileName, expected }, signal)
    if (!check.exists)
      throw new JupiterError('SAVE_NOT_VERIFIED', `After saving, ${check.path} does not exist.`, {
        category: 'dependency',
        userAction: null
      })
    if (!check.matches || check.sha256 === null)
      throw new JupiterError(
        'SAVE_NOT_VERIFIED',
        `${check.path} was written, but its content does not equal the expected text (${String(check.bytes)} bytes on disk).`,
        { category: 'dependency', userAction: 'Open the file to see what was saved.' }
      )
    return {
      target: check.path,
      method: 'semantic',
      observation: `${saved.observation} Verified: ${check.path} exists (${String(check.bytes)} bytes) and its content equals the expected text.`,
      evidence: { kind: 'file', path: check.path, bytes: check.bytes, sha256: check.sha256 }
    }
  }

  /**
   * A query as the runtime understands it. A role (`editor`) is resolved
   * through the application's adapter: its candidate queries are tried in
   * order, and the first control that exists is the one acted on.
   */
  private async concrete(
    app: ComputerAppId,
    window: WindowInfo,
    query: ElementQuery,
    signal: AbortSignal
  ): Promise<ElementQuery> {
    if (query.role === undefined) return query
    const adapter = ADAPTERS[app]
    for (const candidate of adapter.editor) {
      try {
        await this.options.driver.call(
          'findElement',
          { handle: window.handle, query: candidate },
          signal
        )
        return candidate
      } catch (error) {
        if (!(error instanceof JupiterError) || error.code !== 'ELEMENT_NOT_FOUND') throw error
      }
    }
    throw new JupiterError(
      'ELEMENT_NOT_FOUND',
      `${adapter.name} has no ${query.role} control in "${window.title}"${adapter.editor.length ? ` (looked for ${adapter.editor.map(describeQuery).join('; ')})` : ''}.`,
      { category: 'dependency', userAction: null }
    )
  }

  /**
   * The window an action refers to, found again now. The task's own window
   * for that app comes first; if its handle is stale, the app's windows are
   * searched again (re-resolution).
   */
  private async resolve(
    ref: { app: ComputerAppId; titleContains?: string | undefined },
    windows: Map<ComputerAppId, number>,
    signal: AbortSignal
  ): Promise<WindowInfo> {
    const adapter = ADAPTERS[ref.app]
    let listed: WindowInfo[] = []
    let candidates: WindowInfo[] = []
    // UI Automation can miss a window for a moment (just moved, resized, or the display changed): look again briefly.
    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(RESOLVE_PAUSE_MS)
      listed = (await this.options.driver.call('listWindows', {}, signal)).windows
      candidates = listed.filter(
        (item) =>
          adapter.owns(item) &&
          (ref.titleContains === undefined || item.title.includes(ref.titleContains))
      )
      if (candidates.length > 0) break
    }
    const known = windows.get(ref.app)
    const same = candidates.find((item) => item.handle === known)
    const chosen = same ?? candidates.find((item) => item.active) ?? candidates[0]
    if (!chosen)
      throw new JupiterError(
        'WINDOW_NOT_FOUND',
        `No ${adapter.name} window${ref.titleContains ? ` with "${ref.titleContains}" in its title` : ''} is open (${String(listed.length)} other windows are).`,
        { category: 'dependency', userAction: `Open ${adapter.name} first.` }
      )
    if (known !== undefined && chosen.handle !== known)
      this.options.logger.info(
        'computer.window.re-resolved',
        `The ${adapter.name} window was found again under a new handle`,
        {
          app: ref.app
        }
      )
    windows.set(ref.app, chosen.handle)
    return chosen
  }

  // ---- bookkeeping ------------------------------------------------------------------------

  private failed(
    index: number,
    action: ComputerAction,
    startedAt: string,
    error: ErrorEnvelope
  ): ComputerActionResult {
    return {
      index,
      action: action.type,
      target: describeAction(action).slice(0, 500),
      success: false,
      method: action.type === 'CLICK_POINT' ? 'coordinate' : 'none',
      observation: redactString(`Not done: ${error.message}`, 2000),
      evidence: null,
      error,
      startedAt,
      completedAt: this.now()
    }
  }

  private finish(
    task: ComputerTask,
    status: ComputerTask['status'],
    error: ErrorEnvelope | null,
    context: ComputerRunContext
  ): ComputerTask {
    const finished: ComputerTask = { ...task, status, error, completedAt: this.now() }
    const database = this.options.database()
    database.transactions.run(() => {
      database.computer.save(finished)
      this.publish(
        finished.taskId,
        'computer.task_finished',
        { taskId: finished.taskId, status, errorCode: error?.code.slice(0, 64) ?? null },
        context
      )
    })
    this.options.logger.info('computer.task.finished', `Computer task finished: ${status}`, {
      taskId: finished.taskId,
      status,
      code: error?.code ?? null
    })
    return finished
  }

  private publish<T extends DomainEventType>(
    taskId: string,
    type: T,
    payload: EventPayload<T>,
    context: ComputerRunContext
  ): void {
    this.options.bus.publish({
      type,
      stream: { kind: 'computer', id: taskId },
      payload,
      persistent: true,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor },
      missionId: context.missionId ?? null,
      executionId: null
    })
  }

  private readonly sleep = (ms: number): Promise<void> =>
    this.options.sleep
      ? this.options.sleep(ms)
      : new Promise((resolve) => {
          setTimeout(resolve, ms)
        })

  private now(): string {
    return this.options.now().toISOString()
  }
}

function appOf(action: ComputerAction): ComputerAppId | null {
  if (action.type === 'OPEN_APP') return action.app
  if (action.type === 'LIST_WINDOWS') return null
  return action.window?.app ?? null
}

function describeAction(action: ComputerAction | undefined): string {
  if (!action) return 'an action'
  switch (action.type) {
    case 'OPEN_APP':
      return `open ${ADAPTERS[action.app].name}`
    case 'TYPE_TEXT':
      return `type ${String(action.text.length)} characters in ${ADAPTERS[action.window.app].name}`
    case 'SAVE_FILE':
      return `save ${action.fileName} from ${ADAPTERS[action.window.app].name}`
    case 'PRESS_KEYS':
      return `press ${action.keys.join(', ')} in ${ADAPTERS[action.window.app].name}`
    case 'LIST_WINDOWS':
      return 'list the open windows'
    case 'SCREENSHOT':
      return action.window ? `capture ${ADAPTERS[action.window.app].name}` : 'capture the screen'
    case 'CLICK_POINT':
      return `click a point in ${ADAPTERS[action.window.app].name} (coordinate fallback)`
    default:
      return `${action.type.toLowerCase().replace(/_/g, ' ')} in ${ADAPTERS[action.window.app].name}`
  }
}

function describeQuery(query: ElementQuery): string {
  return Object.entries(query)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')
}

function describeElement(element: {
  controlType: string
  name: string
  automationId: string
}): string {
  const name = element.name ? ` "${element.name.slice(0, 80)}"` : ''
  const id = element.automationId ? ` #${element.automationId}` : ''
  return `${element.controlType}${name}${id}`
}

function label(window: WindowInfo): string {
  return `${window.processName} "${window.title.slice(0, 120)}"`
}

function near(actual: number, wanted: number | undefined): boolean {
  return wanted === undefined || Math.abs(actual - wanted) <= 2
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Read through a function: a signal can be aborted between two checks. */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function cancelledOr(signal: AbortSignal, error: JupiterError): JupiterError {
  return signal.aborted
    ? new JupiterError('CANCELLED', 'The task was cancelled while waiting.', {
        category: 'cancellation',
        userAction: null
      })
    : error
}

function envelope(
  code: string,
  category: ErrorEnvelope['category'],
  message: string,
  userAction: string | null,
  details?: Record<string, string>
): ErrorEnvelope {
  return createErrorEnvelope({
    code,
    category,
    message,
    userAction,
    retryable: false,
    ...(details ? { details } : {})
  })
}
