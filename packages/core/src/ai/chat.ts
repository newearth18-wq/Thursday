import {
  MAX_ANSWER_CHARS,
  parseModelRef,
  type Actor,
  type ChatExchange,
  type ChatMessage,
  type Conversation,
  type ConversationRouting,
  type ErrorEnvelope,
  type FinishReason,
  type MessagePart,
  type MessageStatus,
  type RouteDecision,
  type RoutingMode,
  type TokenUsage
} from '@jupiter/contracts'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort } from '../ports'
import {
  ProviderError,
  TRANSIENT_PROVIDER_ERRORS,
  type AdapterMessage,
  type AdapterToolCall
} from './adapter'
import type { OperationContext, ProviderService } from './providers'
import { decisionOf, type RouteCandidate } from './router'

/**
 * Conversations and answers.
 *
 * Sending a message stores it and an empty assistant message (`streaming`)
 * in one transaction, then the answer is generated in the background: its
 * text streams to the interface as transient `chat.message.delta` events,
 * and the finished message is stored once, with its real outcome —
 * `complete`, `cancelled` (Stop, or shutdown) or `failed` (with the
 * provider's sanitized error). Nothing is invented: when no model can
 * answer, `send` fails with a configuration error and stores nothing.
 *
 * Fallback happens only before the first piece of the answer arrived, only
 * for failures that say nothing about the request (unreachable, overloaded,
 * timed out), only to models the fallback policy allows, and it is recorded
 * (`ai.route.fallback`) and shown with the answer.
 */

export interface ChatServiceOptions {
  readonly database: () => DatabasePort
  readonly providers: ProviderService
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  /** No data from the provider for this long ends the answer. Default 120 s. */
  readonly idleTimeoutMs?: number
  /** Coalescing window for streamed text. Default 40 ms. */
  readonly flushMs?: number
}

interface Generation {
  readonly conversationId: string
  readonly messageId: string
  readonly controller: AbortController
  readonly correlationId: string
  stopReason: 'stopped' | 'shutdown' | null
  route: RouteDecision
  text: string
  flushed: number
  toolCalls: AdapterToolCall[]
  usage: TokenUsage | null
  finishReason: FinishReason | null
  truncated: boolean
  received: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  done: Promise<void>
}

const CORE_ACTOR: Actor = { type: 'core', id: 'core' }
const MAX_ACTIVE_GENERATIONS = 4
const MAX_HISTORY_MESSAGES = 60
const MAX_LISTED_MESSAGES = 500
const DELTA_CHUNK = 16_000

export class ChatService {
  private readonly active = new Map<string, Generation>()
  private readonly idleTimeoutMs: number
  private readonly flushMs: number

  constructor(private readonly options: ChatServiceOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000
    this.flushMs = options.flushMs ?? 40
  }

  get activeCount(): number {
    return this.active.size
  }

  listConversations(limit: number): Conversation[] {
    return this.options.database().chat.listConversations(limit)
  }

  messages(conversationId: string): { conversation: Conversation; messages: ChatMessage[] } {
    const database = this.options.database()
    const conversation = this.requireConversation(conversationId, database)
    const messages = database.chat
      .messages(conversationId, MAX_LISTED_MESSAGES)
      .map((message) => this.withLiveText(message))
    return { conversation, messages }
  }

  updateConversation(
    input: {
      conversationId: string
      title?: string | undefined
      routing?: ConversationRouting | undefined
    },
    context: OperationContext
  ): Conversation {
    const database = this.options.database()
    this.requireConversation(input.conversationId, database)
    if (input.routing?.model) {
      const ref = parseModelRef(input.routing.model)
      if (!ref || !database.providers.model(ref.providerId, ref.modelId))
        throw new JupiterError('MODEL_NOT_FOUND', 'That model is not set up.', {
          category: 'validation',
          userAction: 'Choose a model from AI models.'
        })
    }
    database.transactions.run(() => {
      database.chat.updateConversation(input.conversationId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.routing === undefined ? {} : { routing: input.routing }),
        updatedAt: this.now()
      })
      this.publishConversation(input.conversationId, 'updated', context)
    })
    return this.requireConversation(input.conversationId, database)
  }

  async deleteConversation(conversationId: string, context: OperationContext): Promise<void> {
    const database = this.options.database()
    this.requireConversation(conversationId, database)
    for (const generation of this.active.values()) {
      if (generation.conversationId !== conversationId) continue
      generation.stopReason = 'stopped'
      generation.controller.abort()
      await generation.done
    }
    database.transactions.run(() => {
      database.chat.deleteConversation(conversationId)
      this.publishConversation(conversationId, 'deleted', context)
    })
  }

  send(
    input: { conversationId: string | null; text: string },
    context: OperationContext
  ): ChatExchange {
    const database = this.options.database()
    const existing = input.conversationId
      ? this.requireConversation(input.conversationId, database)
      : null
    if (existing) this.assertIdle(existing.conversationId)
    this.assertCapacity()
    const { primary, fallbacks, mode } = this.routeFor(existing)

    const now = this.now()
    const conversationId = existing?.conversationId ?? uuidv7()
    const { user, assistant } = database.transactions.run(() => {
      if (!existing) {
        database.chat.insertConversation({
          conversationId,
          title: titleFrom(input.text),
          routing: { mode: null, model: null },
          createdAt: now
        })
        this.publishConversation(conversationId, 'created', context)
      }
      const seq = database.chat.nextSeq(conversationId)
      const question = this.insert(
        database,
        conversationId,
        seq,
        'user',
        textParts(input.text),
        'complete',
        null,
        null,
        context
      )
      const answer = this.insert(
        database,
        conversationId,
        seq + 1,
        'assistant',
        [],
        'streaming',
        decisionOf(primary, 'chat', mode),
        null,
        context
      )
      database.chat.updateConversation(conversationId, { updatedAt: now })
      return { user: question, assistant: answer }
    })
    this.start(assistant, [primary, ...fallbacks], mode, context.correlationId)
    return {
      conversation: this.requireConversation(conversationId, database),
      userMessage: user,
      assistantMessage: assistant
    }
  }

  /** Stop an answer that is being written. What arrived is kept; the message ends as `cancelled`. */
  stop(messageId: string): boolean {
    const generation = this.active.get(messageId)
    if (!generation) return false
    generation.stopReason = 'stopped'
    generation.controller.abort()
    return true
  }

  retry(messageId: string, context: OperationContext): ChatExchange {
    const database = this.options.database()
    const previous = this.requireMessage(messageId, database)
    if (previous.role !== 'assistant') throw invalidTarget('Only an answer can be asked for again.')
    if (previous.supersededBy !== null) throw invalidTarget('This answer was already replaced.')
    this.assertIdle(previous.conversationId)
    this.assertCapacity()
    const current = this.currentMessages(previous.conversationId, database)
    if (current.at(-1)?.messageId !== previous.messageId)
      throw invalidTarget('Only the latest answer can be asked for again.')
    const question = [...current].reverse().find((message) => message.role === 'user')
    if (!question) throw invalidTarget('There is no message to answer.')
    const conversation = this.requireConversation(previous.conversationId, database)
    const { primary, fallbacks, mode } = this.routeFor(conversation)

    const assistant = database.transactions.run(() => {
      const seq = database.chat.nextSeq(conversation.conversationId)
      const answer = this.insert(
        database,
        conversation.conversationId,
        seq,
        'assistant',
        [],
        'streaming',
        decisionOf(primary, 'chat', mode),
        null,
        context
      )
      database.chat.supersede([previous.messageId], answer.messageId)
      this.publishMessage(previous, 'superseded', context)
      database.chat.updateConversation(conversation.conversationId, { updatedAt: this.now() })
      return answer
    })
    this.start(assistant, [primary, ...fallbacks], mode, context.correlationId)
    return {
      conversation: this.requireConversation(conversation.conversationId, database),
      userMessage: question,
      assistantMessage: assistant
    }
  }

  edit(messageId: string, text: string, context: OperationContext): ChatExchange {
    const database = this.options.database()
    const original = this.requireMessage(messageId, database)
    if (original.role !== 'user') throw invalidTarget('Only your own messages can be edited.')
    if (original.supersededBy !== null) throw invalidTarget('This message was already replaced.')
    this.assertIdle(original.conversationId)
    this.assertCapacity()
    const conversation = this.requireConversation(original.conversationId, database)
    const { primary, fallbacks, mode } = this.routeFor(conversation)
    const replaced = this.currentMessages(original.conversationId, database).filter(
      (message) => message.seq >= original.seq
    )

    const { user, assistant } = database.transactions.run(() => {
      const seq = database.chat.nextSeq(conversation.conversationId)
      const question = this.insert(
        database,
        conversation.conversationId,
        seq,
        'user',
        textParts(text),
        'complete',
        null,
        original.messageId,
        context
      )
      database.chat.supersede(
        replaced.map((message) => message.messageId),
        question.messageId
      )
      for (const message of replaced) this.publishMessage(message, 'superseded', context)
      const answer = this.insert(
        database,
        conversation.conversationId,
        seq + 1,
        'assistant',
        [],
        'streaming',
        decisionOf(primary, 'chat', mode),
        null,
        context
      )
      database.chat.updateConversation(conversation.conversationId, { updatedAt: this.now() })
      return { user: question, assistant: answer }
    })
    this.start(assistant, [primary, ...fallbacks], mode, context.correlationId)
    return {
      conversation: this.requireConversation(conversation.conversationId, database),
      userMessage: user,
      assistantMessage: assistant
    }
  }

  /** After a crash: answers that were being written are marked failed, truthfully. */
  recoverInterrupted(): number {
    const database = this.options.database()
    const stale = database.chat.streaming().filter((message) => !this.active.has(message.messageId))
    if (stale.length === 0) return 0
    const context = { correlationId: uuidv7(), actor: CORE_ACTOR }
    database.transactions.run(() => {
      for (const message of stale) {
        database.chat.updateMessage(message.messageId, {
          status: 'failed',
          finishReason: 'error',
          error: createErrorEnvelope({
            code: 'GENERATION_INTERRUPTED',
            category: 'internal',
            message:
              'Jupiter Core stopped while this answer was being written, so it was not finished.',
            userAction: 'Ask again.',
            retryable: true
          }),
          completedAt: this.now()
        })
        this.publishMessage({ ...message, status: 'failed' }, 'completed', context)
      }
    })
    return stale.length
  }

  /** Stop every answer (shutdown). Waits briefly so each is stored as cancelled. */
  async stopAll(): Promise<void> {
    const pending = [...this.active.values()]
    for (const generation of pending) {
      generation.stopReason = 'shutdown'
      generation.controller.abort()
    }
    await Promise.race([
      Promise.all(pending.map((generation) => generation.done)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
  }

  // ---- generation -------------------------------------------------------------------------

  private start(
    message: ChatMessage,
    candidates: readonly RouteCandidate[],
    mode: RoutingMode,
    correlationId: string
  ): void {
    const route = message.route
    if (!route) throw new Error('an answer needs a route')
    const generation: Generation = {
      conversationId: message.conversationId,
      messageId: message.messageId,
      controller: new AbortController(),
      correlationId,
      stopReason: null,
      route,
      text: '',
      flushed: 0,
      toolCalls: [],
      usage: null,
      finishReason: null,
      truncated: false,
      received: false,
      flushTimer: null,
      done: Promise.resolve()
    }
    this.active.set(message.messageId, generation)
    const history = this.history(message.conversationId, message.seq)
    generation.done = this.run(generation, candidates, mode, history).catch((error: unknown) => {
      this.options.logger
        .child({ correlationId })
        .error('chat.generation.crashed', `Generating an answer failed: ${describeError(error)}`)
      this.finish(generation, 'failed', toErrorEnvelope(error, internalEnvelope))
    })
  }

  private async run(
    generation: Generation,
    candidates: readonly RouteCandidate[],
    mode: RoutingMode,
    history: readonly AdapterMessage[]
  ): Promise<void> {
    const log = this.options.logger.child({ correlationId: generation.correlationId })
    let failure: ErrorEnvelope | null = null
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0 && failure)
        this.recordFallback(generation, candidates[index - 1], candidate, failure, mode)
      try {
        await this.attempt(generation, candidate, mode, history)
        this.finish(generation, generation.stopReason ? 'cancelled' : 'complete', null)
        return
      } catch (error) {
        if (generation.stopReason) {
          this.finish(
            generation,
            'cancelled',
            generation.stopReason === 'shutdown' ? shutdownEnvelope() : null
          )
          return
        }
        const envelope = toErrorEnvelope(error, internalEnvelope)
        log.warn(
          'chat.generation.failed',
          `${candidate.provider.displayName} failed: ${envelope.message}`,
          {
            providerId: candidate.provider.providerId,
            modelId: candidate.model.modelId,
            code: envelope.code
          }
        )
        const canFallBack =
          !generation.received &&
          TRANSIENT_PROVIDER_ERRORS.has(envelope.code) &&
          index < candidates.length - 1
        if (!canFallBack) {
          this.finish(generation, 'failed', envelope)
          return
        }
        failure = envelope
      }
    }
  }

  private async attempt(
    generation: Generation,
    candidate: RouteCandidate,
    mode: RoutingMode,
    history: readonly AdapterMessage[]
  ): Promise<void> {
    const providers = this.options.providers
    const stored = this.options.database().providers.get(candidate.provider.providerId)
    if (!stored) throw invalidTarget(`${candidate.provider.displayName} was removed.`)
    const adapter = providers.adapterFor(stored.adapterId)
    if (!adapter)
      throw new JupiterError(
        'ADAPTER_NOT_INSTALLED',
        `The adapter for ${stored.displayName} is not installed.`,
        {
          category: 'configuration',
          userAction: 'Remove this provider in AI models.'
        }
      )

    const controller = new AbortController()
    const forwardStop = () => {
      controller.abort()
    }
    generation.controller.signal.addEventListener('abort', forwardStop, { once: true })
    if (generation.controller.signal.aborted) controller.abort()
    let idle: ReturnType<typeof setTimeout> | undefined
    const watchdog = { timedOut: false }
    const arm = () => {
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => {
        watchdog.timedOut = true
        controller.abort()
      }, this.idleTimeoutMs)
    }
    const started = performance.now()
    try {
      arm()
      const apiKey = await providers.keyFor(
        stored.providerId,
        generation.correlationId,
        controller.signal
      )
      if (adapter.info.keyRequirement === 'required' && !apiKey)
        throw new JupiterError('PROVIDER_KEY_MISSING', `${stored.displayName} needs an API key.`, {
          category: 'configuration',
          userAction: 'Save an API key for it in AI models.'
        })
      const context = providers.adapterContext(stored, apiKey, mode, 'chat', controller.signal, {
        correlationId: generation.correlationId,
        actor: CORE_ACTOR
      })
      for await (const chunk of adapter.streamChat(context, {
        model: candidate.model.modelId,
        messages: history
      })) {
        arm()
        if (chunk.type === 'text') {
          if (!generation.received) {
            generation.received = true
            providers.recordLatency(
              stored.providerId,
              candidate.model.modelId,
              performance.now() - started
            )
          }
          this.append(generation, chunk.text)
          if (generation.truncated) break
        } else if (chunk.type === 'tool-call') {
          generation.received = true
          generation.toolCalls.push({
            callId: chunk.callId,
            name: chunk.name,
            arguments: chunk.arguments
          })
        } else if (chunk.type === 'usage') {
          generation.usage = chunk.usage
        } else {
          generation.finishReason = chunk.reason
        }
      }
    } catch (error) {
      if (watchdog.timedOut && !generation.stopReason)
        throw new ProviderError(
          'PROVIDER_TIMEOUT',
          `${stored.displayName} stopped sending the answer (nothing for ${String(Math.round(this.idleTimeoutMs / 1000))} seconds).`,
          { cause: error }
        )
      throw error
    } finally {
      if (idle !== undefined) clearTimeout(idle)
      generation.controller.signal.removeEventListener('abort', forwardStop)
    }
  }

  private append(generation: Generation, text: string): void {
    const room = MAX_ANSWER_CHARS - generation.text.length
    if (room <= 0) return
    generation.text += text.slice(0, room)
    if (generation.text.length >= MAX_ANSWER_CHARS) {
      generation.truncated = true
      generation.finishReason = 'length'
    }
    generation.flushTimer ??= setTimeout(() => {
      generation.flushTimer = null
      this.flush(generation)
    }, this.flushMs)
  }

  /** Publish streamed text that the interface has not received yet. */
  private flush(generation: Generation): void {
    while (generation.flushed < generation.text.length) {
      const text = generation.text.slice(generation.flushed, generation.flushed + DELTA_CHUNK)
      try {
        this.options.bus.publish({
          type: 'chat.message.delta',
          stream: { kind: 'conversation', id: generation.conversationId },
          payload: {
            conversationId: generation.conversationId,
            messageId: generation.messageId,
            offset: generation.flushed,
            text
          },
          persistent: false,
          correlationId: generation.correlationId,
          actor: CORE_ACTOR
        })
      } catch (error) {
        this.options.logger.warn('chat.delta.failed', describeError(error))
      }
      generation.flushed += text.length
    }
  }

  private finish(generation: Generation, status: MessageStatus, error: ErrorEnvelope | null): void {
    if (!this.active.has(generation.messageId)) return
    if (generation.flushTimer) clearTimeout(generation.flushTimer)
    generation.flushTimer = null
    this.flush(generation)
    this.active.delete(generation.messageId)
    const finishReason: FinishReason =
      status === 'cancelled'
        ? 'cancelled'
        : status === 'failed'
          ? 'error'
          : generation.truncated
            ? 'length'
            : (generation.finishReason ?? 'unknown')
    const parts = partsOf(generation)
    try {
      const database = this.options.database()
      database.transactions.run(() => {
        database.chat.updateMessage(generation.messageId, {
          parts,
          status,
          route: generation.route,
          usage: generation.usage,
          finishReason,
          error,
          completedAt: this.now()
        })
        database.chat.updateConversation(generation.conversationId, { updatedAt: this.now() })
        this.options.bus.publish({
          type: 'chat.message.changed',
          stream: { kind: 'conversation', id: generation.conversationId },
          payload: {
            conversationId: generation.conversationId,
            messageId: generation.messageId,
            role: 'assistant',
            status,
            change: 'completed'
          },
          persistent: true,
          correlationId: generation.correlationId,
          actor: CORE_ACTOR
        })
      })
    } catch (failure) {
      this.options.logger
        .child({ correlationId: generation.correlationId })
        .error(
          'chat.answer.not-stored',
          `The answer could not be stored: ${describeError(failure)}`,
          { messageId: generation.messageId }
        )
    }
  }

  private recordFallback(
    generation: Generation,
    from: RouteCandidate | undefined,
    to: RouteCandidate,
    failure: ErrorEnvelope,
    mode: RoutingMode
  ): void {
    if (!from) return
    generation.route = decisionOf(to, 'chat', mode, {
      providerId: from.provider.providerId,
      providerName: from.provider.displayName,
      modelId: from.model.modelId,
      errorCode: failure.code
    })
    try {
      this.options.bus.publish({
        type: 'ai.route.fallback',
        stream: { kind: 'ai', id: 'routing' },
        payload: {
          conversationId: generation.conversationId,
          messageId: generation.messageId,
          from: {
            providerId: from.provider.providerId,
            modelId: from.model.modelId,
            errorCode: failure.code
          },
          to: { providerId: to.provider.providerId, modelId: to.model.modelId },
          policy: this.options.providers.fallbackPolicy()
        },
        persistent: true,
        correlationId: generation.correlationId,
        actor: CORE_ACTOR
      })
    } catch (error) {
      this.options.logger.warn('ai.fallback.not-recorded', describeError(error))
    }
  }

  // ---- helpers ------------------------------------------------------------------------------

  private routeFor(conversation: Conversation | null): {
    primary: RouteCandidate
    fallbacks: RouteCandidate[]
    mode: RoutingMode
  } {
    const { result, mode } = this.options.providers.route('chat', conversation)
    if (!result.ok) {
      throw new JupiterError(result.error.code, result.error.message, {
        category: result.error.category,
        userAction: result.error.userAction,
        retryable: result.error.retryable
      })
    }
    return { primary: result.primary, fallbacks: result.fallbacks, mode }
  }

  private history(conversationId: string, beforeSeq: number): AdapterMessage[] {
    const messages = this.currentMessages(conversationId, this.options.database()).filter(
      (message) => message.seq < beforeSeq
    )
    const history: AdapterMessage[] = []
    for (const message of messages) {
      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
      if (message.role === 'user') {
        history.push({ role: 'user', content: [{ type: 'text', text }] })
      } else if (message.role === 'assistant') {
        // Failed answers and ones still being written are not part of the context.
        if (message.status !== 'complete' && message.status !== 'cancelled') continue
        const toolCalls = message.parts.flatMap((part) =>
          part.type === 'tool-call'
            ? [{ callId: part.callId, name: part.name, arguments: part.arguments }]
            : []
        )
        if (!text && toolCalls.length === 0) continue
        history.push({ role: 'assistant', text, toolCalls })
      } else if (message.role === 'system') {
        history.push({ role: 'system', text })
      } else {
        for (const part of message.parts)
          if (part.type === 'tool-result')
            history.push({ role: 'tool', callId: part.callId, content: part.content })
      }
    }
    return history.slice(-MAX_HISTORY_MESSAGES)
  }

  private currentMessages(conversationId: string, database: DatabasePort): ChatMessage[] {
    return database.chat
      .messages(conversationId, MAX_LISTED_MESSAGES)
      .filter((message) => message.supersededBy === null)
  }

  private withLiveText(message: ChatMessage): ChatMessage {
    const generation = this.active.get(message.messageId)
    if (!generation || message.status !== 'streaming') return message
    return { ...message, parts: partsOf(generation), route: generation.route }
  }

  private insert(
    database: DatabasePort,
    conversationId: string,
    seq: number,
    role: 'user' | 'assistant',
    parts: MessagePart[],
    status: MessageStatus,
    route: RouteDecision | null,
    editedFrom: string | null,
    context: OperationContext
  ): ChatMessage {
    const message: ChatMessage = {
      messageId: uuidv7(),
      conversationId,
      seq,
      role,
      parts,
      status,
      route,
      usage: null,
      finishReason: null,
      error: null,
      supersededBy: null,
      editedFrom,
      createdAt: this.now(),
      completedAt: status === 'complete' ? this.now() : null
    }
    database.chat.insertMessage(message)
    this.publishMessage(message, 'created', context)
    return message
  }

  private publishMessage(
    message: Pick<ChatMessage, 'conversationId' | 'messageId' | 'role' | 'status'>,
    change: 'created' | 'completed' | 'superseded',
    context: Pick<OperationContext, 'correlationId' | 'actor'>
  ): void {
    this.options.bus.publish({
      type: 'chat.message.changed',
      stream: { kind: 'conversation', id: message.conversationId },
      payload: {
        conversationId: message.conversationId,
        messageId: message.messageId,
        role: message.role,
        status: message.status,
        change
      },
      persistent: true,
      correlationId: context.correlationId,
      actor: context.actor
    })
  }

  private publishConversation(
    conversationId: string,
    change: 'created' | 'updated' | 'deleted',
    context: OperationContext
  ): void {
    this.options.bus.publish({
      type: 'chat.conversation.changed',
      stream: { kind: 'conversation', id: conversationId },
      payload: { conversationId, change },
      persistent: true,
      correlationId: context.correlationId,
      actor: context.actor
    })
  }

  private assertIdle(conversationId: string): void {
    for (const generation of this.active.values()) {
      if (generation.conversationId === conversationId)
        throw new JupiterError(
          'GENERATION_IN_PROGRESS',
          'An answer is still being written in this conversation.',
          { category: 'validation', userAction: 'Wait for it, or press Stop.' }
        )
    }
  }

  private assertCapacity(): void {
    if (this.active.size >= MAX_ACTIVE_GENERATIONS)
      throw new JupiterError(
        'TOO_MANY_GENERATIONS',
        `Jupiter writes at most ${String(MAX_ACTIVE_GENERATIONS)} answers at a time.`,
        {
          category: 'dependency',
          userAction: 'Wait for one to finish, or stop one.',
          retryable: true
        }
      )
  }

  private requireConversation(conversationId: string, database: DatabasePort): Conversation {
    const conversation = database.chat.conversation(conversationId)
    if (!conversation)
      throw new JupiterError('CONVERSATION_NOT_FOUND', 'That conversation does not exist.', {
        category: 'validation',
        userAction: 'Reload the chat.'
      })
    return conversation
  }

  private requireMessage(messageId: string, database: DatabasePort): ChatMessage {
    const message = database.chat.message(messageId)
    if (!message)
      throw new JupiterError('MESSAGE_NOT_FOUND', 'That message does not exist.', {
        category: 'validation',
        userAction: 'Reload the chat.'
      })
    return message
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}

const internalEnvelope = {
  code: 'GENERATION_FAILED',
  category: 'internal' as const,
  userAction: 'Try again.',
  retryable: true
}

function shutdownEnvelope(): ErrorEnvelope {
  return createErrorEnvelope({
    code: 'GENERATION_INTERRUPTED',
    category: 'cancellation',
    message: 'Jupiter was closing, so the answer was stopped. What arrived before is kept.',
    userAction: 'Ask again.',
    retryable: true
  })
}

function invalidTarget(message: string): JupiterError {
  return new JupiterError('INVALID_CHAT_TARGET', message, {
    category: 'validation',
    userAction: null
  })
}

function textParts(text: string): MessagePart[] {
  return [{ type: 'text', text }]
}

function partsOf(generation: Generation): MessagePart[] {
  const parts: MessagePart[] = []
  if (generation.text) parts.push({ type: 'text', text: generation.text })
  for (const call of generation.toolCalls.slice(0, 32))
    parts.push({
      type: 'tool-call',
      callId: call.callId.slice(0, 128),
      name: call.name.slice(0, 128),
      arguments: call.arguments.slice(0, 20_000)
    })
  return parts
}

/** A short title from the first line of the first message. */
export function titleFrom(text: string): string {
  const line = (text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? text)
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || 'Conversation'
}
