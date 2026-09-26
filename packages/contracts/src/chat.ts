import { z } from 'zod'
import { ModelRef, RouteDecision, RoutingMode } from './ai'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Conversations and messages (SET 3).
 *
 * Messages keep their full history: editing a message or asking for a new
 * answer never deletes the earlier ones, it marks them `supersededBy` the
 * message that replaced them. Hidden model reasoning is never part of a
 * message; tool calls are stored as structured parts.
 */

export const ConversationId = Uuidv7
export const MessageId = Uuidv7

export const MessageRole = z.enum(['system', 'user', 'assistant', 'tool'])
export type MessageRole = z.infer<typeof MessageRole>

/**
 * - `streaming`: the answer is being written now;
 * - `complete`: finished normally;
 * - `cancelled`: stopped by the person, or interrupted; what arrived is kept;
 * - `failed`: nothing usable arrived; `error` says why.
 */
export const MessageStatus = z.enum(['streaming', 'complete', 'cancelled', 'failed'])
export type MessageStatus = z.infer<typeof MessageStatus>

export const FinishReason = z.enum([
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  'cancelled',
  'error',
  'unknown'
])
export type FinishReason = z.infer<typeof FinishReason>

/** Longest text a person can send in one message. */
export const MAX_USER_MESSAGE_CHARS = 32_000
/** Longest answer text kept for one message. */
export const MAX_ANSWER_CHARS = 200_000

export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(MAX_ANSWER_CHARS) }).strict(),
  z
    .object({
      type: z.literal('tool-call'),
      callId: z.string().min(1).max(128),
      name: z.string().min(1).max(128),
      /** The arguments exactly as the model produced them (JSON text). */
      arguments: z.string().max(20_000)
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-result'),
      callId: z.string().min(1).max(128),
      content: z.string().max(20_000),
      isError: z.boolean()
    })
    .strict(),
  /**
   * A file attached through the Artifact Manager. The Artifact Manager
   * arrives in SET 10; until then no message carries this part.
   */
  z
    .object({
      type: z.literal('attachment'),
      artifactId: Uuidv7,
      name: z.string().min(1).max(260),
      mediaType: z.string().min(3).max(120),
      bytes: z.number().int().nonnegative()
    })
    .strict()
])
export type MessagePart = z.infer<typeof MessagePart>

export const TokenUsage = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    /** Tokens the model spent reasoning. The reasoning itself is never stored or shown. */
    reasoningTokens: z.number().int().nonnegative().nullable()
  })
  .strict()
export type TokenUsage = z.infer<typeof TokenUsage>

export const ChatMessage = z
  .object({
    messageId: MessageId,
    conversationId: ConversationId,
    seq: z.number().int().positive(),
    role: MessageRole,
    parts: z.array(MessagePart).max(64),
    status: MessageStatus,
    route: RouteDecision.nullable(),
    usage: TokenUsage.nullable(),
    finishReason: FinishReason.nullable(),
    error: ErrorEnvelope.nullable(),
    /** The message that replaced this one (an edit or a new answer). Null while it is current. */
    supersededBy: MessageId.nullable(),
    /** For an edited message, the message it replaces. */
    editedFrom: MessageId.nullable(),
    createdAt: UtcTimestamp,
    completedAt: UtcTimestamp.nullable()
  })
  .strict()
export type ChatMessage = z.infer<typeof ChatMessage>

/** Routing for one conversation. Null fields follow the global AI settings. */
export const ConversationRouting = z
  .object({
    mode: RoutingMode.nullable(),
    model: ModelRef.nullable()
  })
  .strict()
export type ConversationRouting = z.infer<typeof ConversationRouting>

export const Conversation = z
  .object({
    conversationId: ConversationId,
    title: z.string().min(1).max(120),
    routing: ConversationRouting,
    messageCount: z.number().int().nonnegative(),
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp
  })
  .strict()
export type Conversation = z.infer<typeof Conversation>

export const UserMessageText = z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARS)
