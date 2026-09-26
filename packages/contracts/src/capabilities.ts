import { z } from 'zod'
import { ActorType, RiskLevel } from './actor'
import {
  AdapterId,
  AdapterInfo,
  ApiKeyInput,
  ModelCapability,
  ModelId,
  ProviderBaseUrl,
  ProviderId,
  ProviderInfo,
  RouteDecision,
  SecureStorageStatus
} from './ai'
import {
  ChatMessage,
  Conversation,
  ConversationId,
  ConversationRouting,
  MessageId,
  UserMessageText
} from './chat'
import { AuditEvent } from './audit'
import {
  MissionDetail,
  MissionId,
  MissionPriority,
  MissionRequestText,
  MissionSummary
} from './missions'
import { BackupInfo, DatabaseInfo } from './database'
import { ErrorEnvelope } from './errors'
import { DomainEvent, EventFilter } from './events'
import { UtcTimestamp, Uuidv7 } from './primitives'
import { CapabilityId, RequestKind } from './request'
import { ServiceHealth } from './service-health'
import { SettingDefinitions, SettingRecord } from './settings'

/**
 * The capability catalogue: every command and query Jupiter Core accepts,
 * with its input and output schema. Core validates inputs against these
 * before a handler runs and outputs before a reply leaves; the renderer
 * validates replies again. Who may call each capability is Core policy and
 * lives with the handlers, not here.
 */

const Empty = z.object({}).strict()

export const RendererErrorReport = z
  .object({
    source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']),
    message: z.string().min(1).max(2000),
    stack: z.string().max(8000).nullable(),
    componentStack: z.string().max(8000).nullable()
  })
  .strict()
export type RendererErrorReport = z.infer<typeof RendererErrorReport>

export const RecordedError = z
  .object({
    globalSequence: z.number().int().positive(),
    occurredAt: UtcTimestamp,
    source: z.string().max(64),
    error: ErrorEnvelope
  })
  .strict()
export type RecordedError = z.infer<typeof RecordedError>

export const CapabilitySummary = z
  .object({
    id: CapabilityId,
    kind: RequestKind,
    allowedActors: z.array(ActorType).max(8),
    risk: RiskLevel,
    provider: z.enum(['core', 'host'])
  })
  .strict()
export type CapabilitySummary = z.infer<typeof CapabilitySummary>

export const DiagnosticsSnapshot = z
  .object({
    core: z
      .object({
        version: z.string().max(64),
        pid: z.number().int().nonnegative(),
        startedAt: UtcTimestamp,
        uptimeMs: z.number().int().nonnegative(),
        restarts: z.number().int().nonnegative(),
        sessionId: Uuidv7,
        versions: z
          .object({
            node: z.string().max(32),
            electron: z.string().max(32),
            chrome: z.string().max(32),
            v8: z.string().max(48)
          })
          .strict()
      })
      .strict(),
    services: z.array(ServiceHealth).max(32),
    database: DatabaseInfo.nullable(),
    databaseError: ErrorEnvelope.nullable(),
    events: z
      .object({
        latestSequence: z.number().int().nonnegative(),
        activeSubscriptions: z.number().int().nonnegative()
      })
      .strict(),
    recentErrors: z.array(RecordedError).max(50),
    dispatcher: z
      .object({
        inFlight: z.number().int().nonnegative(),
        capabilities: z.array(CapabilitySummary).max(64)
      })
      .strict()
  })
  .strict()
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshot>

/**
 * The Windows-notification bridge: what the interface may ask the host to
 * show. Plain text in both fields (no markup, no links, no actions); the
 * host shows it with the operating system's notification service.
 */
export const DesktopNotification = z
  .object({
    tone: z.enum(['info', 'success', 'warning', 'error']),
    title: z.string().trim().min(1).max(120),
    body: z.string().max(400)
  })
  .strict()
export type DesktopNotification = z.infer<typeof DesktopNotification>

function settingUpdate<K extends keyof typeof SettingDefinitions>(key: K) {
  return z.object({ key: z.literal(key), value: SettingDefinitions[key] }).strict()
}

/** One variant per known setting; a unit test keeps this list in step with `SettingDefinitions`. */
export const SettingUpdate = z.discriminatedUnion('key', [
  settingUpdate('logging.level'),
  settingUpdate('ui.language'),
  settingUpdate('ui.theme'),
  settingUpdate('ui.textScale'),
  settingUpdate('ui.compact'),
  settingUpdate('ui.reduceMotion'),
  settingUpdate('ui.avatar'),
  settingUpdate('notifications.desktop'),
  settingUpdate('ai.routingMode'),
  settingUpdate('ai.fallbackPolicy'),
  settingUpdate('ai.costLatency'),
  settingUpdate('ai.preferredProvider'),
  settingUpdate('ai.preferredChatModel'),
  settingUpdate('ai.preferredReasoningModel'),
  settingUpdate('ai.preferredVisionModel'),
  settingUpdate('ai.preferredEmbeddingModel')
])
export type SettingUpdate = z.infer<typeof SettingUpdate>

export const EventsListInput = z
  .object({
    afterSequence: z.number().int().nonnegative().nullable(),
    limit: z.number().int().min(1).max(200),
    filter: EventFilter
  })
  .strict()
export type EventsListInput = z.infer<typeof EventsListInput>

const ProviderName = z.string().trim().min(1).max(80)
const ProviderRef = z.object({ providerId: ProviderId }).strict()
const MissionRef = z.object({ missionId: MissionId }).strict()
const CapabilityList = z.array(ModelCapability).min(1).max(6)

export const ChatExchange = z
  .object({
    conversation: Conversation,
    userMessage: ChatMessage,
    assistantMessage: ChatMessage
  })
  .strict()
export type ChatExchange = z.infer<typeof ChatExchange>

export const RoutePreview = z
  .object({ route: RouteDecision.nullable(), problem: ErrorEnvelope.nullable() })
  .strict()
export type RoutePreview = z.infer<typeof RoutePreview>

export const Capabilities = {
  'diagnostics.snapshot': { kind: 'query', input: Empty, output: DiagnosticsSnapshot },
  'diagnostics.report-renderer-error': {
    kind: 'command',
    input: RendererErrorReport,
    output: z.object({ recorded: z.literal(true) }).strict()
  },
  'settings.list': {
    kind: 'query',
    input: Empty,
    output: z.object({ settings: z.array(SettingRecord) }).strict()
  },
  'settings.update': { kind: 'command', input: SettingUpdate, output: SettingRecord },
  'events.list': {
    kind: 'query',
    input: EventsListInput,
    output: z
      .object({
        events: z.array(DomainEvent).max(200),
        latestSequence: z.number().int().nonnegative()
      })
      .strict()
  },
  'audit.list': {
    kind: 'query',
    input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
    output: z
      .object({ entries: z.array(AuditEvent).max(100), total: z.number().int().nonnegative() })
      .strict()
  },
  'database.backup': { kind: 'command', input: Empty, output: BackupInfo },
  'host.logs.reveal': {
    kind: 'command',
    input: Empty,
    output: z.object({ opened: z.literal(true), path: z.string().max(4096) }).strict()
  },
  /** Whether this system can show desktop (Windows) notifications. */
  'host.notifications.status': {
    kind: 'query',
    input: Empty,
    output: z.object({ supported: z.boolean() }).strict()
  },
  /** Show a desktop notification. Plain text only; the host limits size and rate. */
  'host.notifications.show': {
    kind: 'command',
    input: DesktopNotification,
    output: z.object({ shown: z.literal(true) }).strict()
  },
  'runtime.report-host-status': {
    kind: 'command',
    input: z.object({ services: z.array(ServiceHealth).min(1).max(32) }).strict(),
    output: z.object({ recorded: z.number().int().nonnegative() }).strict()
  },

  // ---- AI providers, models and routing (SET 3) ----
  /** The provider adapters installed in this build. */
  'ai.adapters.list': {
    kind: 'query',
    input: Empty,
    output: z.object({ adapters: z.array(AdapterInfo).max(32) }).strict()
  },
  'ai.providers.list': {
    kind: 'query',
    input: Empty,
    output: z.object({ providers: z.array(ProviderInfo).max(50) }).strict()
  },
  'ai.providers.add': {
    kind: 'command',
    input: z
      .object({ adapterId: AdapterId, displayName: ProviderName, baseUrl: ProviderBaseUrl })
      .strict(),
    output: ProviderInfo
  },
  'ai.providers.update': {
    kind: 'command',
    input: z
      .object({
        providerId: ProviderId,
        displayName: ProviderName.optional(),
        baseUrl: ProviderBaseUrl.optional(),
        enabled: z.boolean().optional()
      })
      .strict()
      .refine(
        (input) =>
          input.displayName !== undefined ||
          input.baseUrl !== undefined ||
          input.enabled !== undefined,
        { message: 'Nothing to change' }
      ),
    output: ProviderInfo
  },
  'ai.providers.remove': {
    kind: 'command',
    input: ProviderRef,
    output: z.object({ removed: z.literal(true), providerId: ProviderId }).strict()
  },
  /** Contact the provider now: health, key and model list. */
  'ai.providers.check': { kind: 'command', input: ProviderRef, output: ProviderInfo },
  /** Save an API key in the operating system's secure storage. The key is never returned. */
  'ai.credentials.set': {
    kind: 'command',
    input: z.object({ providerId: ProviderId, apiKey: ApiKeyInput }).strict(),
    output: ProviderInfo
  },
  'ai.credentials.remove': { kind: 'command', input: ProviderRef, output: ProviderInfo },
  /** Add a model by hand (for providers that do not list their models). */
  'ai.models.add': {
    kind: 'command',
    input: z
      .object({ providerId: ProviderId, modelId: ModelId, capabilities: CapabilityList })
      .strict(),
    output: ProviderInfo
  },
  'ai.models.update': {
    kind: 'command',
    input: z
      .object({
        providerId: ProviderId,
        modelId: ModelId,
        enabled: z.boolean().optional(),
        capabilities: CapabilityList.optional()
      })
      .strict()
      .refine((input) => input.enabled !== undefined || input.capabilities !== undefined, {
        message: 'Nothing to change'
      }),
    output: ProviderInfo
  },
  /** Which model a request would use now, or why none can. */
  'ai.route.preview': {
    kind: 'query',
    input: z
      .object({ capability: ModelCapability, conversationId: ConversationId.nullable() })
      .strict(),
    output: RoutePreview
  },
  /** Whether this computer offers OS-backed secure storage for API keys. */
  'host.credentials.status': { kind: 'query', input: Empty, output: SecureStorageStatus },

  // ---- Chat (SET 3) ----
  'chat.conversations.list': {
    kind: 'query',
    input: z.object({ limit: z.number().int().min(1).max(200) }).strict(),
    output: z.object({ conversations: z.array(Conversation).max(200) }).strict()
  },
  'chat.conversations.update': {
    kind: 'command',
    input: z
      .object({
        conversationId: ConversationId,
        title: z.string().trim().min(1).max(120).optional(),
        routing: ConversationRouting.optional()
      })
      .strict()
      .refine((input) => input.title !== undefined || input.routing !== undefined, {
        message: 'Nothing to change'
      }),
    output: Conversation
  },
  'chat.conversations.delete': {
    kind: 'command',
    input: z.object({ conversationId: ConversationId }).strict(),
    output: z.object({ deleted: z.literal(true), conversationId: ConversationId }).strict()
  },
  'chat.messages.list': {
    kind: 'query',
    input: z.object({ conversationId: ConversationId }).strict(),
    output: z
      .object({ conversation: Conversation, messages: z.array(ChatMessage).max(500) })
      .strict()
  },
  /** Send a message. The answer streams as `chat.message.delta` events on the conversation's stream. */
  'chat.send': {
    kind: 'command',
    input: z.object({ conversationId: ConversationId.nullable(), text: UserMessageText }).strict(),
    output: ChatExchange
  },
  /** Stop an answer that is being written. What arrived so far is kept. */
  'chat.stop': {
    kind: 'command',
    input: z.object({ messageId: MessageId }).strict(),
    output: z.object({ stopped: z.boolean() }).strict()
  },
  /** Ask again for the last answer; the earlier answer is kept as superseded. */
  'chat.retry': {
    kind: 'command',
    input: z.object({ messageId: MessageId }).strict(),
    output: ChatExchange
  },
  /** Replace a message you sent and get a new answer; the earlier messages are kept as superseded. */
  'chat.edit': {
    kind: 'command',
    input: z.object({ messageId: MessageId, text: UserMessageText }).strict(),
    output: ChatExchange
  },

  // ---- Missions (SET 4) ----
  /** Create a Mission from a request and start it. */
  'missions.create': {
    kind: 'command',
    input: z
      .object({
        request: MissionRequestText,
        title: z.string().trim().min(1).max(120).optional(),
        priority: MissionPriority.optional()
      })
      .strict(),
    output: MissionDetail
  },
  'missions.list': {
    kind: 'query',
    input: z
      .object({ includeArchived: z.boolean(), limit: z.number().int().min(1).max(200) })
      .strict(),
    output: z.object({ missions: z.array(MissionSummary).max(200) }).strict()
  },
  'missions.get': { kind: 'query', input: MissionRef, output: MissionDetail },
  /** The Mission's stored events, oldest first: its timeline, rebuilt from the event log. */
  'missions.timeline': {
    kind: 'query',
    input: MissionRef,
    output: z.object({ events: z.array(DomainEvent).max(1000) }).strict()
  },
  /** Pause at the next safe boundary (when the current step ends). */
  'missions.pause': { kind: 'command', input: MissionRef, output: MissionDetail },
  'missions.resume': { kind: 'command', input: MissionRef, output: MissionDetail },
  /** Cancel: stops the active step (and its provider request) at once. */
  'missions.cancel': { kind: 'command', input: MissionRef, output: MissionDetail },
  /** Run again as a new execution linked to the previous one; nothing is erased. */
  'missions.retry': { kind: 'command', input: MissionRef, output: MissionDetail },
  'missions.archive': { kind: 'command', input: MissionRef, output: MissionDetail }
} as const satisfies Record<string, { kind: RequestKind; input: z.ZodType; output: z.ZodType }>

export type CapabilityName = keyof typeof Capabilities
export type CapabilityInput<C extends CapabilityName> = z.infer<(typeof Capabilities)[C]['input']>
export type CapabilityOutput<C extends CapabilityName> = z.infer<(typeof Capabilities)[C]['output']>

export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === 'string' && Object.hasOwn(Capabilities, value)
}

export { BackupInfo }
