import {
  capabilityInfo,
  originOf,
  type ActorType,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserEvidence,
  type BrowserMethod,
  type BrowserSession,
  type BrowserStatus,
  type BrowserTask,
  type BrowserTaskRequest,
  type DomainEventType,
  type ErrorEnvelope,
  type EventPayload,
  type Extraction,
  type Locator,
  type PageInfo,
  type PermissionSubject,
  type SuspiciousContent,
  type UntrustedContent
} from '@jupiter/contracts'
import { findSecrets, redactString } from '@jupiter/security'
import { JupiterError, createErrorEnvelope, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { PermissionEngine } from '../permissions/engine'
import type { DatabasePort } from '../ports'
import type { BrowserDriver } from './driver'
import { findSuspiciousInstructions } from './injection'

/**
 * The Browser Agent (SET 9).
 *
 * A task is a list of typed actions in one browser session, run one at a
 * time. The rules:
 *
 * - **Pages are data.** Nothing a page says changes what the agent does:
 *   its actions come only from the approved task. Text that tries to direct
 *   the agent is labelled (`suspicious`) and reported, never followed.
 * - **Permissions first.** Every action needs its capability for its exact
 *   origin. The missing ones are asked for together before anything runs
 *   (WAITING_APPROVAL, nothing done); each is checked again when it runs.
 *   A single-use answer is used up by the first action it allows and then
 *   covers only the rest of that task, for the same capability and exact
 *   target, and only when the capability is LOW or MEDIUM risk.
 *   Sending a form needs its own permission — a sign-in at least MEDIUM, a
 *   message or form HIGH, a purchase CRITICAL — including a click or an
 *   Enter that would send one, and a "search" whose form asks for a password.
 * - **Origins.** A task may be only on the origins it navigates to (and those
 *   it names). Reaching any other origin — a redirect, a link, a script —
 *   stops the task at once (SAFETY_STOP); nothing after it runs.
 * - **Evidence.** Every action returns the page's address, origin and title
 *   and what was really observed; downloads are kept in quarantine until the
 *   host has checked them. Nothing typed is ever stored, and text that looks
 *   like a credential is never typed into a page.
 */

export interface BrowserAgentOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly driver: BrowserDriver
  /** Whether the person turned on the persistent profile. */
  readonly persistentProfile: () => boolean
}

export interface BrowserRunContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly missionId?: string | null
  readonly missionTitle?: string | null
  readonly stepId?: string | null
  readonly stepTitle?: string | null
  readonly signal?: AbortSignal
}

export const BROWSER_AGENT: PermissionSubject = {
  kind: 'agent',
  id: 'browser',
  name: 'Browser Agent'
}

interface Requirement {
  readonly capability: string
  /** The origin it is for; the target is built from it when the action runs. */
  readonly origin: string
  readonly target: (origin: string) => string
}

interface Outcome {
  readonly target: string
  readonly method: BrowserMethod
  readonly page: PageInfo | null
  readonly observation: string
  readonly content?: UntrustedContent
  readonly extraction?: Extraction
  readonly suspicious?: SuspiciousContent[]
  readonly evidence?: BrowserEvidence
}

const NAVIGATION_TIMEOUT_MS = 30_000
const ELEMENT_TIMEOUT_MS = 5_000
const DOWNLOAD_TIMEOUT_MS = 30_000
/** An origin a page can have without being anywhere (about:blank, a new tab). */
const NO_ORIGIN = 'null'

/** What a permission already answered once in this task counts as (see `reusable`). */
const ALLOWED_THIS_TASK = { allowed: true, grantId: '', singleUse: true } as const

const SUBMIT_CAPABILITY = {
  search: 'browser.interact',
  login: 'browser.submit_login',
  message: 'browser.submit_form',
  form: 'browser.submit_form',
  purchase: 'payment.make'
} as const

export class BrowserAgent {
  private readonly running = new Map<string, { controller: AbortController; sessionId: string }>()

  constructor(private readonly options: BrowserAgentOptions) {}

  /** Tasks a Core stop cut off are recorded as failed; none is run again by itself. */
  start(): void {
    const database = this.options.database()
    for (const task of database.browser.running()) {
      const error = createErrorEnvelope({
        code: 'BROWSER_TASK_INTERRUPTED',
        category: 'internal',
        message:
          'Jupiter Core stopped while this task was running; the actions after the last recorded one did not run.',
        userAction: 'Check the website, then run the task again if needed.',
        retryable: true
      })
      database.browser.save({ ...task, status: 'FAILED', error, completedAt: this.now() })
    }
  }

  async status(): Promise<BrowserStatus> {
    const status = await this.options.driver.call('status', {})
    return { ...status, persistentProfile: this.options.persistentProfile() }
  }

  tasks(limit: number, missionId?: string): BrowserTask[] {
    const store = this.options.database().browser
    return missionId === undefined
      ? store.tasks(limit)
      : store.forMission(missionId).slice(0, limit)
  }

  async sessions(): Promise<BrowserSession[]> {
    return (await this.options.driver.call('listSessions', {})).sessions
  }

  async openSession(input: {
    missionId: string | null
    profile: 'temporary' | 'persistent'
  }): Promise<BrowserSession> {
    if (input.profile === 'persistent' && !this.options.persistentProfile())
      throw new JupiterError(
        'PERSISTENT_PROFILE_OFF',
        'The persistent browser profile is turned off.',
        {
          category: 'validation',
          userAction: 'Turn it on in Settings › Privacy, or use a temporary session.'
        }
      )
    return this.options.driver.call('openSession', { sessionId: uuidv7(), ...input })
  }

  async closeSession(sessionId: string): Promise<boolean> {
    for (const running of this.running.values())
      if (running.sessionId === sessionId)
        throw new JupiterError('SESSION_BUSY', 'A task is running in this session.', {
          category: 'validation',
          userAction: 'Cancel the task first.'
        })
    return (await this.options.driver.call('closeSession', { sessionId })).closed
  }

  cancel(taskId: string): boolean {
    const running = this.running.get(taskId)
    if (!running) return false
    running.controller.abort()
    // Stop the operation under way in the browser at once (a page that is still loading stops).
    this.options.driver.call('stop', { sessionId: running.sessionId }).catch((error: unknown) => {
      this.options.logger.warn('browser.stop.failed', 'Could not stop the browser operation', {
        error: String(error)
      })
    })
    return true
  }

  async run(request: BrowserTaskRequest, context: BrowserRunContext): Promise<BrowserTask> {
    const database = this.options.database()
    if (database.browser.task(request.taskId) || this.running.has(request.taskId))
      throw new JupiterError('BROWSER_TASK_EXISTS', 'A task with this id already exists.', {
        category: 'validation',
        userAction: 'Use a new task id.'
      })
    const ownSession = request.sessionId === null
    const sessionId = request.sessionId ?? uuidv7()
    const allowed = new Set<string>(request.extraOrigins)
    for (const action of request.actions) {
      const target = navigationOf(action)
      const origin = target === null ? null : originOf(target)
      if (origin !== null) allowed.add(origin)
    }
    let task: BrowserTask = {
      taskId: request.taskId,
      missionId: context.missionId ?? null,
      sessionId,
      title: request.title,
      status: 'RUNNING',
      actions: request.actions.map((action) => {
        const target = navigationOf(action)
        return { type: action.type, origin: target === null ? null : originOf(target) }
      }),
      allowedOrigins: [...allowed].slice(0, 20),
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
    this.running.set(request.taskId, { controller, sessionId })
    database.transactions.run(() => {
      database.browser.save(task)
      this.publish(
        task.taskId,
        'browser.task_started',
        { taskId: task.taskId, sessionId, actions: request.actions.length },
        context
      )
    })
    const opened = { value: false }
    try {
      task = await this.execute(task, request, context, controller.signal, ownSession, opened)
    } catch (error) {
      task = this.finish(
        task,
        'FAILED',
        toErrorEnvelope(error, {
          code: 'BROWSER_TASK_FAILED',
          category: 'internal',
          userAction: null,
          retryable: false
        }),
        context
      )
    } finally {
      this.running.delete(request.taskId)
      context.signal?.removeEventListener('abort', forward)
      // A session the task opened for itself is temporary: it closes with the task.
      if (opened.value)
        await this.options.driver.call('closeSession', { sessionId }).catch(() => undefined)
    }
    return task
  }

  // ---- the task ---------------------------------------------------------------------------

  private async execute(
    initial: BrowserTask,
    request: BrowserTaskRequest,
    context: BrowserRunContext,
    signal: AbortSignal,
    ownSession: boolean,
    opened: { value: boolean }
  ): Promise<BrowserTask> {
    let task = initial
    const fail = (
      code: string,
      category: ErrorEnvelope['category'],
      message: string,
      action: string | null
    ) => this.finish(task, 'FAILED', envelope(code, category, message, action), context)

    if (
      !request.allowCoordinateFallback &&
      request.actions.some((action) => action.type === 'CLICK_POINT')
    )
      return fail(
        'COORDINATE_FALLBACK_DISABLED',
        'validation',
        'The task clicks a point on the page (coordinate fallback), which it does not allow.',
        'Find the control by its role, label or text, or allow the coordinate fallback for this task.'
      )
    // A credential typed into a page would be readable by the page's scripts.
    for (const action of request.actions)
      for (const text of typedTexts(action))
        if (findSecrets(text).length > 0)
          return fail(
            'SECRET_IN_INPUT',
            'validation',
            'The task would type something that looks like a key, token or password into a web page, where the page’s scripts could read it. Jupiter does not do that.',
            'Remove the credential from the task.'
          )

    const status = await this.options.driver.call('status', {}, signal)
    if (!status.available)
      return fail(
        'BROWSER_UNAVAILABLE',
        'unsupported',
        status.reason ?? 'The Browser Agent is not available.',
        null
      )

    // Where the task starts: an existing session's page, or nowhere (a new session).
    let current = NO_ORIGIN
    if (!ownSession) {
      const sessions = (await this.options.driver.call('listSessions', {}, signal)).sessions
      if (!sessions.some((session) => session.sessionId === task.sessionId))
        return fail(
          'SESSION_NOT_FOUND',
          'validation',
          'This browser session is not open.',
          'Open a session first, or run the task in a new one.'
        )
      current = (await this.options.driver.call('page', { sessionId: task.sessionId }, signal)).page
        .origin
      if (current !== NO_ORIGIN && !task.allowedOrigins.includes(current))
        task = { ...task, allowedOrigins: [...task.allowedOrigins, current].slice(0, 20) }
    }
    const allowed = new Set(task.allowedOrigins)

    // Every permission first: ask for all the missing ones at once; do nothing until they are given.
    const planned = await this.requirements(request.actions, current, signal)
    if (!planned.ok && planned.code === 'NAVIGATE_FIRST')
      return fail(
        'NAVIGATE_FIRST',
        'validation',
        'A new session has no page yet: the task must open one (NAVIGATE) before it reads or acts on it.',
        'Start the task with NAVIGATE.'
      )
    if (!planned.ok)
      return fail(
        'UPLOAD_FILE_NOT_FOUND',
        'validation',
        `"${planned.fileName}" is not in the upload folder.`,
        'Put the file in the upload folder, then run the task again.'
      )
    const requirements = planned.needs
    const missing: string[] = []
    const seen = new Set<string>()
    for (const [index, needs] of requirements.entries()) {
      for (const requirement of needs) {
        const key = `${requirement.capability} ${requirement.target(requirement.origin)}`
        if (seen.has(key)) continue
        seen.add(key)
        const outcome = this.check(requirement, requirement.origin, request, index, context, true)
        if (!outcome.allowed) {
          if (outcome.code === 'PERMISSION_UNKNOWN')
            return fail('PERMISSION_UNKNOWN', 'permission', outcome.message, null)
          if (outcome.requestId && !missing.includes(outcome.requestId))
            missing.push(outcome.requestId)
        }
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

    if (ownSession) {
      await this.options.driver.call(
        'openSession',
        { sessionId: task.sessionId, missionId: context.missionId ?? null, profile: 'temporary' },
        signal
      )
      opened.value = true
    }

    const answeredOnce = new Set<string>()
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
      const startedAt = this.now()
      let result: BrowserActionResult
      // Each permission again, for the origin the page is really on now. A single-use answer is
      // used up by the first action it allows and then covers this task, for that exact
      // capability and target only, and never for a HIGH or CRITICAL action.
      const denied = (requirements[index] ?? [])
        .map((requirement) => {
          const origin = navigationOf(action) === null ? current : requirement.origin
          const key = `${requirement.capability} ${requirement.target(origin)}`
          const outcome = this.check(requirement, origin, request, index, context, false)
          if (outcome.allowed) {
            if (outcome.singleUse && reusable(requirement.capability)) answeredOnce.add(key)
            return outcome
          }
          return answeredOnce.has(key) ? ALLOWED_THIS_TASK : outcome
        })
        .find((outcome) => !outcome.allowed)
      if (denied?.allowed === false) {
        result = this.failed(
          index,
          action,
          startedAt,
          current,
          envelope(
            'PERMISSION_REQUIRED',
            'permission',
            denied.message,
            'Give the permission, then run the task again.'
          )
        )
      } else {
        try {
          const outcome = await this.perform(
            action,
            task.sessionId,
            request,
            index,
            context,
            signal
          )
          result = {
            index,
            action: action.type,
            target: redactString(outcome.target, 500),
            success: true,
            method: outcome.method,
            url: outcome.page?.url ?? null,
            origin: outcome.page?.origin ?? null,
            title: outcome.page ? redactString(outcome.page.title, 500) : null,
            observation: redactString(withPopups(outcome.observation, outcome.page), 2000),
            content: outcome.content ?? null,
            extraction: outcome.extraction ?? null,
            suspicious: outcome.suspicious ?? [],
            evidence: outcome.evidence ?? null,
            error: null,
            startedAt,
            completedAt: this.now()
          }
          if (outcome.page) current = outcome.page.origin
        } catch (error) {
          result = this.failed(
            index,
            action,
            startedAt,
            current,
            toErrorEnvelope(error, {
              code: 'BROWSER_ACTION_FAILED',
              category: 'internal',
              userAction: null,
              retryable: false
            })
          )
        }
      }
      task = { ...task, results: [...task.results, result] }
      this.record(task, result, context)
      if (!result.success) {
        const cancelled = aborted(signal) && result.error?.category === 'cancellation'
        return this.finish(task, cancelled ? 'CANCELLED' : 'FAILED', result.error, context)
      }
      // The safety response: an origin the task was not approved for stops it here.
      if (current !== NO_ORIGIN && !allowed.has(current)) {
        const reached = current
        await this.options.driver.call('stop', { sessionId: task.sessionId }).catch(() => undefined)
        const database = this.options.database()
        database.transactions.run(() => {
          this.publish(
            task.taskId,
            'browser.safety_stop',
            { taskId: task.taskId, index, reached, allowed: [...allowed].slice(0, 20) },
            context
          )
        })
        return this.finish(
          task,
          'SAFETY_STOP',
          envelope(
            'UNEXPECTED_ORIGIN',
            'permission',
            `After "${action.type}" the page was on ${reached}, which this task was not approved for (${[...allowed].join(', ')}). The task stopped there; nothing after it ran.`,
            'Check where the page went. To continue on that site, run a task that names it.'
          ),
          context
        )
      }
    }
    return this.finish(task, 'SUCCEEDED', null, context)
  }

  private check(
    requirement: Requirement,
    origin: string,
    request: BrowserTaskRequest,
    index: number,
    context: BrowserRunContext,
    preflight: boolean
  ) {
    return this.options.permissions.check({
      capability: requirement.capability,
      subject: BROWSER_AGENT,
      actor: context.actor,
      target: requirement.target(origin),
      reason: `${request.title}: ${describeAction(request.actions[index])}`,
      missionId: context.missionId ?? null,
      missionTitle: context.missionTitle ?? null,
      stepId: context.stepId ?? null,
      stepTitle: context.stepTitle ?? null,
      askIfNeeded: preflight,
      evaluateOnly: preflight
    })
  }

  /**
   * What each action needs, with the origin it will be on. Returns
   * `NAVIGATE_FIRST` when a new session would be acted on before it has a
   * page, or the name of an upload file that is not in the upload folder.
   */
  private async requirements(
    actions: readonly BrowserAction[],
    start: string,
    signal: AbortSignal
  ): Promise<
    | { readonly ok: true; readonly needs: Requirement[][] }
    | { readonly ok: false; readonly code: 'NAVIGATE_FIRST' }
    | { readonly ok: false; readonly code: 'UPLOAD_FILE_NOT_FOUND'; readonly fileName: string }
  > {
    const result: Requirement[][] = []
    let origin = start
    const at = (capability: string): Requirement => ({ capability, origin, target: (o) => o })
    for (const action of actions) {
      const target = navigationOf(action)
      if (target !== null) origin = originOf(target) ?? origin
      const needsPage = !['NAVIGATE', 'NEW_TAB', 'SWITCH_TAB', 'CLOSE_TAB'].includes(action.type)
      if (needsPage && origin === NO_ORIGIN) return { ok: false, code: 'NAVIGATE_FIRST' }
      switch (action.type) {
        case 'NAVIGATE':
          result.push([at('browser.navigate')])
          break
        case 'NEW_TAB':
          result.push(action.url === null ? [] : [at('browser.navigate')])
          break
        case 'SWITCH_TAB':
        case 'CLOSE_TAB':
        case 'WAIT_FOR':
          result.push([])
          break
        case 'READ_PAGE':
        case 'EXTRACT':
        case 'SCREENSHOT':
        case 'SNAPSHOT_HTML':
          result.push([at('browser.read')])
          break
        case 'CLICK':
        case 'TYPE':
        case 'FILL_FORM':
        case 'SELECT_OPTION':
        case 'PRESS_KEYS':
          result.push([at('browser.interact')])
          break
        case 'SUBMIT':
          result.push(
            action.kind === 'search'
              ? [at('browser.interact')]
              : [at('browser.interact'), at(SUBMIT_CAPABILITY[action.kind])]
          )
          break
        case 'DOWNLOAD':
          result.push([at('browser.download')])
          break
        case 'UPLOAD': {
          // The exact file: the host decides the folder, the permission names the file and the site.
          const upload = await this.options.driver.call(
            'resolveUpload',
            { fileName: action.fileName },
            signal
          )
          if (!upload.exists)
            return { ok: false, code: 'UPLOAD_FILE_NOT_FOUND', fileName: action.fileName }
          result.push([
            { capability: 'browser.upload', origin, target: (o) => `${upload.path} → ${o}` }
          ])
          break
        }
        case 'CLICK_POINT':
          result.push([at('browser.click_point')])
          break
      }
    }
    return { ok: true, needs: result }
  }

  // ---- actions ----------------------------------------------------------------------------

  private async perform(
    action: BrowserAction,
    sessionId: string,
    request: BrowserTaskRequest,
    index: number,
    context: BrowserRunContext,
    signal: AbortSignal
  ): Promise<Outcome> {
    const { driver } = this.options
    switch (action.type) {
      case 'NAVIGATE': {
        const { page, status } = await driver.call(
          'navigate',
          { sessionId, url: action.url, timeoutMs: action.timeoutMs ?? NAVIGATION_TIMEOUT_MS },
          signal
        )
        if (status !== null && status >= 400)
          throw new JupiterError(
            'NAVIGATION_FAILED',
            `${page.url} answered HTTP ${String(status)}.`,
            {
              category: 'dependency',
              userAction: null
            }
          )
        return {
          target: action.url,
          method: 'page',
          page,
          observation: `Opened ${page.url}${status === null ? '' : ` (HTTP ${String(status)})`}: "${page.title}".`
        }
      }
      case 'NEW_TAB': {
        const { page } = await driver.call(
          'newTab',
          { sessionId, url: action.url, timeoutMs: NAVIGATION_TIMEOUT_MS },
          signal
        )
        return {
          target: action.url ?? 'a new tab',
          method: 'page',
          page,
          observation: `Opened tab ${String(page.tab + 1)} of ${String(page.tabs)}: ${page.url}.`
        }
      }
      case 'SWITCH_TAB': {
        const { page } = await driver.call('switchTab', { sessionId, index: action.index }, signal)
        return {
          target: `tab ${String(action.index + 1)}`,
          method: 'page',
          page,
          observation: `Now on tab ${String(page.tab + 1)} of ${String(page.tabs)}: ${page.url} "${page.title}".`
        }
      }
      case 'CLOSE_TAB': {
        const { page } = await driver.call('closeTab', { sessionId, index: action.index }, signal)
        return {
          target: action.index === null ? 'this tab' : `tab ${String(action.index + 1)}`,
          method: 'page',
          page,
          observation: `Closed the tab; now on tab ${String(page.tab + 1)} of ${String(page.tabs)}: ${page.url}.`
        }
      }
      case 'CLICK': {
        const control = await driver.call(
          'describe',
          { sessionId, target: action.target, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        if (control.kind === 'file')
          throw new JupiterError(
            'USE_UPLOAD',
            'That control chooses a file; use UPLOAD with a file from the upload folder.',
            { category: 'validation', userAction: null }
          )
        // A click that sends a form is a submission, whatever the task calls it.
        if (control.kind === 'submit')
          this.requireSubmit(
            control.formHasPassword ? 'login' : 'form',
            control.page.origin,
            request,
            index,
            context
          )
        const done = await driver.call(
          'click',
          { sessionId, target: action.target, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        return {
          target: done.found,
          method: done.method,
          page: done.page,
          observation: `Clicked ${done.found}; now on ${done.page.url} "${done.page.title}".`
        }
      }
      case 'TYPE': {
        const done = await driver.call(
          'fill',
          { sessionId, target: action.target, text: action.text, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        if (!done.matches)
          throw new JupiterError(
            'ACTION_NOT_VERIFIED',
            `After typing, ${done.found} does not hold exactly the text.`,
            { category: 'dependency', userAction: null }
          )
        return {
          target: done.found,
          method: done.method,
          page: done.page,
          observation: `Typed ${String(action.text.length)} characters into ${done.found}${done.sensitive ? ' (a password field)' : ''}; reading it back confirms the field holds exactly the text.`
        }
      }
      case 'FILL_FORM': {
        let last: { page: PageInfo; method: 'semantic' | 'selector' } | null = null
        const filled: string[] = []
        for (const field of action.fields) {
          const done = await driver.call(
            'fill',
            { sessionId, target: field.target, text: field.value, timeoutMs: ELEMENT_TIMEOUT_MS },
            signal
          )
          if (!done.matches)
            throw new JupiterError(
              'ACTION_NOT_VERIFIED',
              `After filling, ${done.found} does not hold exactly its value.`,
              { category: 'dependency', userAction: null }
            )
          filled.push(done.found)
          last = { page: done.page, method: done.method }
        }
        return {
          target: `${String(filled.length)} fields`,
          method: last?.method ?? 'semantic',
          page: last?.page ?? null,
          observation: `Filled ${filled.join(', ')}; each field reads back exactly its value. The form was not sent.`
        }
      }
      case 'SELECT_OPTION': {
        const done = await driver.call(
          'select',
          { sessionId, target: action.target, value: action.value, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        if (done.selected.length === 0)
          throw new JupiterError(
            'ACTION_NOT_VERIFIED',
            `${done.found} has no option "${action.value}".`,
            { category: 'dependency', userAction: null }
          )
        return {
          target: done.found,
          method: done.method,
          page: done.page,
          observation: `Selected ${done.selected.map((value) => `"${value}"`).join(', ')} in ${done.found}.`
        }
      }
      case 'PRESS_KEYS': {
        if (action.target !== null && action.keys.includes('Enter')) {
          // Enter in a form's field sends the form: a submission, whatever the task calls it.
          const control = await driver.call(
            'describe',
            { sessionId, target: action.target, timeoutMs: ELEMENT_TIMEOUT_MS },
            signal
          )
          if (control.formAction !== null)
            this.requireSubmit(
              control.formHasPassword ? 'login' : 'form',
              control.page.origin,
              request,
              index,
              context
            )
        }
        const { page } = await driver.call(
          'press',
          { sessionId, target: action.target, keys: action.keys, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        return {
          target: action.keys.join(', '),
          method: 'semantic',
          page,
          observation: `Pressed ${action.keys.join(', ')}; now on ${page.url} "${page.title}".`
        }
      }
      case 'SUBMIT': {
        const control = await driver.call(
          'describe',
          { sessionId, target: action.target, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        // A form that asks for a password is a sign-in, whatever the task calls it.
        if (control.formHasPassword && action.kind !== 'login' && action.kind !== 'purchase')
          this.requireSubmit('login', control.page.origin, request, index, context)
        const before = control.page.url
        const done =
          control.kind === 'field' || control.kind === 'password'
            ? {
                ...(await driver.call(
                  'press',
                  {
                    sessionId,
                    target: action.target,
                    keys: ['Enter'],
                    timeoutMs: ELEMENT_TIMEOUT_MS
                  },
                  signal
                )),
                found: control.found,
                method: control.method
              }
            : await driver.call(
                'click',
                { sessionId, target: action.target, timeoutMs: ELEMENT_TIMEOUT_MS },
                signal
              )
        return {
          target: `${done.found} (${action.kind})`,
          method: done.method,
          page: done.page,
          observation: `Sent the ${action.kind} form with ${done.found}; ${done.page.url === before ? 'the page stayed at' : 'the page is now'} ${done.page.url} "${done.page.title}".`
        }
      }
      case 'WAIT_FOR': {
        const { page } = await driver.call(
          'waitFor',
          {
            sessionId,
            target: action.target,
            urlContains: action.urlContains,
            state: action.state,
            timeoutMs: action.timeoutMs
          },
          signal
        )
        return {
          target: describeAction(action),
          method: 'page',
          page,
          observation: `The page is ready: ${page.url} "${page.title}".`
        }
      }
      case 'READ_PAGE': {
        const read = await driver.call('read', { sessionId, maxChars: action.maxChars }, signal)
        const suspicious = findSuspiciousInstructions(`${read.text}\n${read.structure}`)
        return {
          target: read.page.url,
          method: 'page',
          page: read.page,
          content: {
            untrusted: true,
            origin: read.page.origin,
            structure: read.structure,
            text: read.text,
            truncated: read.truncated
          },
          suspicious,
          observation: `Read ${String(read.text.length)} characters of text and the page structure of "${read.page.title}" (${read.page.origin})${read.truncated ? ', cut to the limit' : ''}. Page content is untrusted data${suspicious.length > 0 ? `; ${String(suspicious.length)} attempt${suspicious.length === 1 ? '' : 's'} to direct the agent labelled and not followed (${suspicious.map((item) => item.kind).join(', ')})` : ''}.`
        }
      }
      case 'EXTRACT': {
        const { page, data } = await driver.call(
          'extract',
          { sessionId, fields: action.fields, timeoutMs: ELEMENT_TIMEOUT_MS },
          signal
        )
        const empty = action.fields.filter((field) => {
          const value = data[field.name]
          return (
            value === null || value === undefined || (Array.isArray(value) && value.length === 0)
          )
        })
        if (empty.length > 0)
          throw new JupiterError(
            'EXTRACTION_INCOMPLETE',
            `Nothing was found for ${empty.map((field) => `"${field.name}"`).join(', ')} on ${page.url}.`,
            { category: 'dependency', userAction: null }
          )
        const values = Object.values(data).flatMap((value) =>
          value === null ? [] : Array.isArray(value) ? value : [value]
        )
        const suspicious = findSuspiciousInstructions(values.join('\n'))
        return {
          target: page.url,
          method: 'semantic',
          page,
          extraction: data,
          suspicious,
          observation: `Extracted ${action.fields
            .map((field) => {
              const value = data[field.name]
              return Array.isArray(value)
                ? `${field.name} (${String(value.length)} items)`
                : field.name
            })
            .join(
              ', '
            )} from "${page.title}" (${page.origin}); untrusted data${suspicious.length > 0 ? `, with ${String(suspicious.length)} attempt(s) to direct the agent labelled` : ''}.`
        }
      }
      case 'SCREENSHOT': {
        const shot = await driver.call(
          'screenshot',
          { sessionId, fullPage: action.fullPage },
          signal
        )
        return {
          target: shot.page.url,
          method: 'page',
          page: shot.page,
          evidence: { kind: 'screenshot', file: shot.file, bytes: shot.bytes },
          observation: `Captured ${action.fullPage ? 'the whole page' : 'the visible page'} (${String(shot.bytes)} bytes, ${shot.file}).`
        }
      }
      case 'SNAPSHOT_HTML': {
        const snap = await driver.call('snapshotHtml', { sessionId }, signal)
        return {
          target: snap.page.url,
          method: 'page',
          page: snap.page,
          evidence: { kind: 'html', file: snap.file, bytes: snap.bytes },
          observation: `Saved the page's HTML (${String(snap.bytes)} bytes, ${snap.file}); it is kept as untrusted evidence.`
        }
      }
      case 'DOWNLOAD': {
        const got = await driver.call(
          'download',
          {
            sessionId,
            target: action.target,
            types: action.expect.types,
            maxBytes: action.expect.maxBytes,
            timeoutMs: action.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
          },
          signal
        )
        if (!got.verified || !got.evidence)
          throw new JupiterError(
            'DOWNLOAD_REJECTED',
            `The download "${got.fileName}" was rejected and removed from quarantine: ${got.rejected ?? 'it failed a check'}`,
            { category: 'validation', userAction: null }
          )
        const evidence = got.evidence
        return {
          target: got.fileName,
          method: 'semantic',
          page: got.page,
          evidence,
          observation: `Downloaded "${got.fileName}" from ${got.sourceOrigin}: ${evidence.kind === 'download' ? `${String(evidence.bytes)} bytes, a ${evidence.type.toUpperCase()} file by its content, SHA-256 ${evidence.sha256.slice(0, 12)}…` : ''}; checked in quarantine, then kept in the downloads folder.`
        }
      }
      case 'UPLOAD': {
        const done = await driver.call(
          'upload',
          {
            sessionId,
            target: action.target,
            fileName: action.fileName,
            timeoutMs: ELEMENT_TIMEOUT_MS
          },
          signal
        )
        if (!done.attached.includes(action.fileName))
          throw new JupiterError(
            'ACTION_NOT_VERIFIED',
            `After choosing "${action.fileName}", the file input holds ${done.attached.length === 0 ? 'no file' : done.attached.join(', ')}.`,
            { category: 'dependency', userAction: null }
          )
        return {
          target: action.fileName,
          method: 'semantic',
          page: done.page,
          evidence: done.evidence,
          observation: `Attached "${action.fileName}" (${String(done.evidence.bytes)} bytes) to the file input on ${done.page.origin}; the input holds exactly that file. It is sent only when the form is submitted.`
        }
      }
      case 'CLICK_POINT': {
        const done = await driver.call(
          'clickPoint',
          { sessionId, x: action.x, y: action.y },
          signal
        )
        return {
          target: `point ${String(action.x)},${String(action.y)}`,
          method: 'coordinate',
          page: done.page,
          observation: `Coordinate fallback: clicked the point ${String(action.x)},${String(action.y)} of the page (${String(done.viewport.width)}×${String(done.viewport.height)}) because ${action.reason}. The effect of a point click is not verified; now on ${done.page.url}.`
        }
      }
    }
  }

  /** A submission found while acting: its permission must already be there (it is asked for otherwise). */
  private requireSubmit(
    kind: 'login' | 'form',
    origin: string,
    request: BrowserTaskRequest,
    index: number,
    context: BrowserRunContext
  ): void {
    const capability = SUBMIT_CAPABILITY[kind]
    const outcome = this.options.permissions.check({
      capability,
      subject: BROWSER_AGENT,
      actor: context.actor,
      target: origin,
      reason: `${request.title}: ${describeAction(request.actions[index])} sends a ${kind === 'login' ? 'sign-in' : ''} form`,
      missionId: context.missionId ?? null,
      missionTitle: context.missionTitle ?? null,
      stepId: context.stepId ?? null,
      stepTitle: context.stepTitle ?? null,
      askIfNeeded: true
    })
    if (!outcome.allowed)
      throw new JupiterError(
        'PERMISSION_REQUIRED',
        `This ${kind === 'login' ? 'sends a sign-in form' : 'sends a form'} on ${origin}, which needs "${capability}"; nothing was sent. ${outcome.message}`,
        {
          category: 'permission',
          userAction: 'Answer the permission request, then run the task again.'
        }
      )
  }

  // ---- bookkeeping ------------------------------------------------------------------------

  private record(task: BrowserTask, result: BrowserActionResult, context: BrowserRunContext): void {
    const database = this.options.database()
    database.transactions.run(() => {
      database.browser.save(task)
      this.publish(
        task.taskId,
        'browser.action_completed',
        {
          taskId: task.taskId,
          index: result.index,
          action: result.action,
          success: result.success,
          method: result.method,
          origin: result.origin,
          errorCode: result.error?.code.slice(0, 64) ?? null
        },
        context
      )
      const kinds = [...new Set(result.suspicious.map((item) => item.kind))]
      if (kinds.length > 0 && result.origin !== null)
        this.publish(
          task.taskId,
          'browser.suspicious_content',
          { taskId: task.taskId, index: result.index, origin: result.origin, kinds },
          context
        )
    })
  }

  private failed(
    index: number,
    action: BrowserAction,
    startedAt: string,
    origin: string,
    error: ErrorEnvelope
  ): BrowserActionResult {
    return {
      index,
      action: action.type,
      target: redactString(describeAction(action), 500),
      success: false,
      method: action.type === 'CLICK_POINT' ? 'coordinate' : 'none',
      url: null,
      origin: origin === NO_ORIGIN ? null : origin,
      title: null,
      observation: redactString(`Not done: ${error.message}`, 2000),
      content: null,
      extraction: null,
      suspicious: [],
      evidence: null,
      error,
      startedAt,
      completedAt: this.now()
    }
  }

  private finish(
    task: BrowserTask,
    status: BrowserTask['status'],
    error: ErrorEnvelope | null,
    context: BrowserRunContext
  ): BrowserTask {
    const finished: BrowserTask = { ...task, status, error, completedAt: this.now() }
    const database = this.options.database()
    database.transactions.run(() => {
      database.browser.save(finished)
      this.publish(
        finished.taskId,
        'browser.task_finished',
        { taskId: finished.taskId, status, errorCode: error?.code.slice(0, 64) ?? null },
        context
      )
    })
    this.options.logger.info('browser.task.finished', `Browser task finished: ${status}`, {
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
    context: BrowserRunContext
  ): void {
    this.options.bus.publish({
      type,
      stream: { kind: 'browser', id: taskId },
      payload,
      persistent: true,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor },
      missionId: context.missionId ?? null,
      executionId: null
    })
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}

/** The address an action opens, if it opens one. */
/** A single-use answer may cover the rest of its task only for a LOW or MEDIUM capability. */
function reusable(capability: string): boolean {
  const risk = capabilityInfo(capability)?.risk
  return risk === 'LOW' || risk === 'MEDIUM'
}

function navigationOf(action: BrowserAction): string | null {
  if (action.type === 'NAVIGATE') return action.url
  if (action.type === 'NEW_TAB') return action.url
  return null
}

function typedTexts(action: BrowserAction): string[] {
  if (action.type === 'TYPE') return [action.text]
  if (action.type === 'FILL_FORM') return action.fields.map((field) => field.value)
  return []
}

function describeLocator(locator: Locator): string {
  if (locator.role !== undefined)
    return locator.name === undefined ? locator.role : `${locator.role} "${locator.name}"`
  if (locator.label !== undefined) return `field "${locator.label}"`
  if (locator.placeholder !== undefined) return `field "${locator.placeholder}"`
  if (locator.text !== undefined) return `"${locator.text}"`
  if (locator.testId !== undefined) return `#${locator.testId}`
  return locator.css ?? 'a control'
}

export function describeAction(action: BrowserAction | undefined): string {
  if (!action) return 'an action'
  switch (action.type) {
    case 'NAVIGATE':
      return `open ${action.url}`
    case 'NEW_TAB':
      return action.url === null ? 'open a new tab' : `open ${action.url} in a new tab`
    case 'SWITCH_TAB':
      return `switch to tab ${String(action.index + 1)}`
    case 'CLOSE_TAB':
      return 'close a tab'
    case 'CLICK':
      return `click ${describeLocator(action.target)}`
    case 'TYPE':
      return `type ${String(action.text.length)} characters into ${describeLocator(action.target)}`
    case 'FILL_FORM':
      return `fill ${String(action.fields.length)} fields`
    case 'SELECT_OPTION':
      return `choose an option in ${describeLocator(action.target)}`
    case 'PRESS_KEYS':
      return `press ${action.keys.join(', ')}`
    case 'SUBMIT':
      return `send the ${action.kind} form with ${describeLocator(action.target)}`
    case 'WAIT_FOR':
      return 'wait for the page'
    case 'READ_PAGE':
      return 'read the page'
    case 'EXTRACT':
      return `extract ${action.fields.map((field) => field.name).join(', ')}`
    case 'SCREENSHOT':
      return 'capture the page'
    case 'SNAPSHOT_HTML':
      return "save the page's HTML"
    case 'DOWNLOAD':
      return `download a file with ${describeLocator(action.target)}`
    case 'UPLOAD':
      return `attach ${action.fileName} to ${describeLocator(action.target)}`
    case 'CLICK_POINT':
      return `click a point of the page (coordinate fallback)`
  }
}

/** Adds what the runtime did about tabs the page tried to open by itself. */
function withPopups(observation: string, page: PageInfo | null): string {
  if (!page || page.popupsClosed === 0) return observation
  const count = page.popupsClosed
  const note = `The page tried to open ${String(count)} tab${count === 1 ? '' : 's'} by itself; ${count === 1 ? 'it was' : 'they were'} blocked and closed.`
  return `${observation} ${note}`
}

/** Read through a function: a signal can be aborted between two checks. */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted
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
