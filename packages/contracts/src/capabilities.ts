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
  BrowserProfile,
  BrowserSession,
  BrowserStatus,
  BrowserTask,
  BrowserTaskRequest,
  SuspiciousContent
} from './browser'
import { ComputerStatus, ComputerTask, ComputerTaskRequest } from './computer'
import {
  Artifact,
  DocumentContent,
  DocumentSpec,
  FileEntry,
  FileLocation,
  FileListing,
  FileName,
  FileQuery,
  FilesStatus,
  UserRoot
} from './files'
import {
  MemoryCandidate,
  MemoryCandidateInput,
  MemoryCorrection,
  MemoryDecisionRecord,
  MemoryEntry,
  MemoryProposalResult,
  MemoryQuery,
  MemorySearchResult,
  MemoryStatus
} from './memory'
import {
  Note,
  NoteCreateInput,
  NoteEntry,
  NoteFolder,
  NotePath,
  NoteSearchHit,
  NoteTitle,
  NoteWriteResult,
  NotesStatus
} from './notes'
import {
  MissionDetail,
  MissionId,
  MissionPriority,
  MissionRequestText,
  MissionSummary
} from './missions'
import { SkillId, StepTypeInfo } from './plans'
import { SkillExecutionRecord, SkillFilter, SkillInfo, SkillResult, SkillVersion } from './skills'
import {
  CapabilityCatalogueEntry,
  PermissionAuditEntry,
  PermissionDecision,
  PermissionGrant,
  PermissionRequest
} from './permissions'
import { BackupInfo, DatabaseInfo } from './database'
import { ErrorEnvelope } from './errors'
import { DomainEvent, EventFilter } from './events'
import { UtcTimestamp, Uuidv7 } from './primitives'
import { CapabilityId, RequestKind } from './request'
import { ServiceHealth } from './service-health'
import { SettingDefinitions, SettingRecord } from './settings'
import {
  AudioChunkInput,
  ListenSession,
  ListenStartInput,
  ListenStopInput,
  PlaybackInput,
  SpokenLanguage,
  SystemVoices,
  Utterance,
  VoiceOption,
  VoiceState,
  VoiceStatus
} from './voice'
import {
  AnalyzeInput,
  CameraReportInput,
  CameraSession,
  CameraStartInput,
  CameraStatus,
  CameraStopInput,
  CaptureInput,
  CompareInput,
  ImageContent,
  ImageIdInput,
  ImagePartInput,
  ImagePartResult,
  ImageRef,
  Observation,
  VisionStatus,
  VisualComparison
} from './vision'

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
        capabilities: z.array(CapabilitySummary).max(128)
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
  settingUpdate('ai.preferredEmbeddingModel'),
  settingUpdate('browser.persistentProfile'),
  settingUpdate('memory.semanticSearch'),
  settingUpdate('ai.preferredTranscriptionModel'),
  settingUpdate('ai.preferredSpeechModel'),
  settingUpdate('voice.enabled'),
  settingUpdate('voice.inputDevice'),
  settingUpdate('voice.outputDevice'),
  settingUpdate('voice.wakeWordEnabled'),
  settingUpdate('voice.wakeWord'),
  settingUpdate('voice.speechSource'),
  settingUpdate('voice.voice'),
  settingUpdate('voice.language'),
  settingUpdate('voice.speakingRate'),
  settingUpdate('voice.interruptionSensitivity'),
  settingUpdate('vision.cameraDevice'),
  settingUpdate('vision.redactSecrets')
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

const SkillRef = z.object({ skillId: SkillId, version: SkillVersion.optional() }).strict()

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
        priority: MissionPriority.optional(),
        /** `model` (default): the Planner plans the request; `template`: Jupiter's standard answer plan. */
        planner: z.enum(['model', 'template']).optional()
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
  'missions.archive': { kind: 'command', input: MissionRef, output: MissionDetail },
  /** Answer an approval checkpoint (SET 5). */
  'missions.approve': {
    kind: 'command',
    input: z.object({ missionId: MissionId, stepId: Uuidv7 }).strict(),
    output: MissionDetail
  },
  'missions.reject': {
    kind: 'command',
    input: z.object({ missionId: MissionId, stepId: Uuidv7 }).strict(),
    output: MissionDetail
  },
  /** Plan again: a new plan revision, optionally with the person's corrections. Earlier plans and runs are kept. */
  'missions.replan': {
    kind: 'command',
    input: z
      .object({
        missionId: MissionId,
        feedback: z.string().trim().min(1).max(1000).optional(),
        /** Default: the planner of the current plan, or the model planner when there is none. */
        planner: z.enum(['model', 'template']).optional()
      })
      .strict(),
    output: MissionDetail
  },
  /** The step types (skills) the Workflow Engine can run in this build. */
  'missions.step-types': {
    kind: 'query',
    input: Empty,
    output: z.object({ stepTypes: z.array(StepTypeInfo).max(50) }).strict()
  },

  // ---- Skills (SET 6) ----
  /** Registered Skills (latest version of each), filtered. */
  'skills.list': {
    kind: 'query',
    input: z.object({ filter: SkillFilter }).strict(),
    output: z.object({ skills: z.array(SkillInfo).max(200) }).strict()
  },
  'skills.get': { kind: 'query', input: SkillRef, output: SkillInfo },
  /** Every registered version of a Skill, newest first. */
  'skills.versions': {
    kind: 'query',
    input: z.object({ skillId: SkillId }).strict(),
    output: z.object({ versions: z.array(SkillInfo).max(50) }).strict()
  },
  'skills.enable': { kind: 'command', input: SkillRef, output: SkillInfo },
  'skills.disable': { kind: 'command', input: SkillRef, output: SkillInfo },
  /** Run the Skill's health check now. */
  'skills.health-check': { kind: 'command', input: SkillRef, output: SkillInfo },
  /**
   * Run a Skill. The caller names the execution (so it can cancel it) but
   * never grants permissions: Core decides what the invocation may do.
   */
  'skills.invoke': {
    kind: 'command',
    input: z
      .object({
        executionId: Uuidv7,
        skillId: SkillId,
        version: SkillVersion.optional(),
        input: z.unknown(),
        /** At most the Skill's own timeout. */
        timeoutMs: z.number().int().min(100).max(600_000).optional(),
        idempotencyKey: z.string().min(1).max(128).optional()
      })
      .strict(),
    output: SkillResult
  },
  'skills.cancel': {
    kind: 'command',
    input: z.object({ executionId: Uuidv7 }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict()
  },
  /** Execution history: shapes and sizes of input and output, never their content. */
  'skills.executions': {
    kind: 'query',
    input: z
      .object({ skillId: SkillId.optional(), limit: z.number().int().min(1).max(200) })
      .strict(),
    output: z.object({ executions: z.array(SkillExecutionRecord).max(200) }).strict()
  },

  // ---- Permissions (SET 7) ----
  /** Every capability Jupiter knows, with its risk and consequences. */
  'permissions.catalogue': {
    kind: 'query',
    input: Empty,
    output: z.object({ capabilities: z.array(CapabilityCatalogueEntry).max(100) }).strict()
  },
  /** Permission requests waiting for an answer (or all recent ones). */
  'permissions.requests': {
    kind: 'query',
    input: z
      .object({
        status: z.enum(['PENDING', 'ALL']),
        missionId: Uuidv7.optional(),
        limit: z.number().int().min(1).max(200)
      })
      .strict(),
    output: z.object({ requests: z.array(PermissionRequest).max(200) }).strict()
  },
  /** The person's answer to a request. Only the answers the request offers are accepted. */
  'permissions.decide': {
    kind: 'command',
    input: z.object({ requestId: Uuidv7, decision: PermissionDecision }).strict(),
    output: PermissionRequest
  },
  'permissions.grants': {
    kind: 'query',
    input: z
      .object({ includeEnded: z.boolean(), limit: z.number().int().min(1).max(500) })
      .strict(),
    output: z.object({ grants: z.array(PermissionGrant).max(500) }).strict()
  },
  'permissions.revoke': {
    kind: 'command',
    input: z.object({ grantId: Uuidv7 }).strict(),
    output: PermissionGrant
  },
  /** The permission audit trail, newest first. Targets and reasons are redacted. */
  'permissions.audit': {
    kind: 'query',
    input: z.object({ limit: z.number().int().min(1).max(500) }).strict(),
    output: z.object({ entries: z.array(PermissionAuditEntry).max(500) }).strict()
  },
  // ---- Windows Computer Agent (SET 8) ----
  /** Whether the agent can act on this computer, and why not when it cannot. */
  'computer.status': { kind: 'query', input: Empty, output: ComputerStatus },
  /**
   * Run a task of typed actions. Every action is checked by the Permission
   * Engine; missing permissions are asked for all at once, before anything runs.
   */
  'computer.run': { kind: 'command', input: ComputerTaskRequest, output: ComputerTask },
  /** Stop a running task at the next safe boundary; queued actions do not run. */
  'computer.cancel': {
    kind: 'command',
    input: z.object({ taskId: Uuidv7 }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict()
  },
  'computer.tasks': {
    kind: 'query',
    input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
    output: z.object({ tasks: z.array(ComputerTask).max(100) }).strict()
  },
  // ---- Browser Agent (SET 9) ----------------------------------------------------------------
  'browser.status': { kind: 'query', input: Empty, output: BrowserStatus },
  /**
   * Open a browser session: a temporary profile (removed when it closes), or
   * the persistent profile when the person turned it on. Never the person's
   * own browser profile.
   */
  'browser.sessions.open': {
    kind: 'command',
    input: z.object({ missionId: Uuidv7.nullable(), profile: BrowserProfile }).strict(),
    output: BrowserSession
  },
  'browser.sessions.close': {
    kind: 'command',
    input: z.object({ sessionId: Uuidv7 }).strict(),
    output: z.object({ closed: z.boolean() }).strict()
  },
  'browser.sessions.list': {
    kind: 'query',
    input: Empty,
    output: z.object({ sessions: z.array(BrowserSession).max(50) }).strict()
  },
  /**
   * Run a task of typed browser actions. Every action is checked by the
   * Permission Engine for its exact origin; missing permissions are asked for
   * all at once, before anything runs. Reaching an origin the task was not
   * approved for stops it (SAFETY_STOP).
   */
  'browser.run': { kind: 'command', input: BrowserTaskRequest, output: BrowserTask },
  /** Stop a running task at once: the operation under way is stopped; queued actions do not run. */
  'browser.cancel': {
    kind: 'command',
    input: z.object({ taskId: Uuidv7 }).strict(),
    output: z.object({ cancelled: z.boolean() }).strict()
  },
  'browser.tasks': {
    kind: 'query',
    input: z
      .object({
        limit: z.number().int().min(1).max(100),
        /** Only this Mission's tasks (its browser evidence), oldest first. */
        missionId: Uuidv7.optional()
      })
      .strict(),
    output: z.object({ tasks: z.array(BrowserTask).max(100) }).strict()
  },
  // ---- The File Agent and the Artifact Manager (SET 10) ----
  /** The approved folders, the document runtime and the formats it reads and writes. */
  'files.status': { kind: 'query', input: Empty, output: FilesStatus },
  /**
   * Find files in an approved folder (optionally its sub-folders), filtered
   * by format or name and sorted by the file's real modified time, name or
   * size. Needs `files.list` for the folder.
   */
  'files.find': {
    kind: 'command',
    input: z.object({ query: FileQuery, missionId: Uuidv7.nullable() }).strict(),
    output: FileListing
  },
  /**
   * Read a document in the document runtime. Its text is untrusted data:
   * text that tries to direct Jupiter is labelled, never followed. Needs
   * `files.read` for the exact file.
   */
  'files.read': {
    kind: 'command',
    input: z
      .object({
        location: FileLocation,
        maxChars: z.number().int().min(100).max(200_000),
        missionId: Uuidv7.nullable()
      })
      .strict(),
    output: z
      .object({
        file: FileEntry,
        content: DocumentContent,
        suspicious: z.array(SuspiciousContent).max(7)
      })
      .strict()
  },
  /** Copy a file to a name that does not exist yet (never replaces one). Needs `files.write` for the new file. */
  'files.copy': {
    kind: 'command',
    input: z
      .object({ from: FileLocation, to: FileLocation, missionId: Uuidv7.nullable() })
      .strict(),
    output: FileEntry
  },
  /** Move or rename a file or folder. Needs `files.write` for both the old and the new place. */
  'files.move': {
    kind: 'command',
    input: z
      .object({ from: FileLocation, to: FileLocation, missionId: Uuidv7.nullable() })
      .strict(),
    output: FileEntry
  },
  'files.mkdir': {
    kind: 'command',
    input: z.object({ location: FileLocation, missionId: Uuidv7.nullable() }).strict(),
    output: FileEntry
  },
  /** Open a document in its usual application (never a program). Needs `files.open`. */
  'files.open': {
    kind: 'command',
    input: z.object({ location: FileLocation }).strict(),
    output: z.object({ done: z.boolean() }).strict()
  },
  /** Show the file in its folder. Needs `files.open`. */
  'files.reveal': {
    kind: 'command',
    input: z.object({ location: FileLocation }).strict(),
    output: z.object({ done: z.boolean() }).strict()
  },
  /** Move one file to the Recycle Bin. Needs `files.delete` (CRITICAL) for the exact file, every time. */
  'files.delete': {
    kind: 'command',
    input: z.object({ location: FileLocation, missionId: Uuidv7.nullable() }).strict(),
    output: z.object({ done: z.boolean() }).strict()
  },
  'artifacts.list': {
    kind: 'query',
    input: z
      .object({
        missionId: Uuidv7.nullable(),
        includeDeleted: z.boolean(),
        limit: z.number().int().min(1).max(200)
      })
      .strict(),
    output: z.object({ artifacts: z.array(Artifact).max(200) }).strict()
  },
  /**
   * Create a document in a Mission's workspace (or Jupiter's shared one),
   * written atomically and checked before it is recorded. Needs
   * `artifacts.create` for the workspace folder.
   */
  'artifacts.create': {
    kind: 'command',
    input: z.object({ missionId: Uuidv7.nullable(), name: FileName, spec: DocumentSpec }).strict(),
    output: Artifact
  },
  /** Check the file again: still there, the same content, still valid. */
  'artifacts.verify': {
    kind: 'command',
    input: z.object({ artifactId: Uuidv7 }).strict(),
    output: Artifact
  },
  'artifacts.open': {
    kind: 'command',
    input: z.object({ artifactId: Uuidv7 }).strict(),
    output: z.object({ done: z.boolean() }).strict()
  },
  'artifacts.reveal': {
    kind: 'command',
    input: z.object({ artifactId: Uuidv7 }).strict(),
    output: z.object({ done: z.boolean() }).strict()
  },
  /**
   * Share: save a copy in one of the person's folders (Downloads, Documents
   * or Desktop) under a name that does not exist yet. The copy is a new
   * artifact, kept. Needs `files.write` for the exact new file.
   */
  'artifacts.share': {
    kind: 'command',
    input: z.object({ artifactId: Uuidv7, root: UserRoot }).strict(),
    output: Artifact
  },
  /** Keep (or stop keeping) an artifact as an output: cleanup never removes a kept one. */
  'artifacts.keep': {
    kind: 'command',
    input: z.object({ artifactId: Uuidv7, kept: z.boolean() }).strict(),
    output: Artifact
  },
  /** Move the artifact's file to the Recycle Bin. Needs `files.delete` for the exact file. */
  'artifacts.delete': {
    kind: 'command',
    input: z.object({ artifactId: Uuidv7 }).strict(),
    output: Artifact
  },
  /** Remove a finished Mission's intermediate workspace files; kept outputs stay. */
  'artifacts.cleanup': {
    kind: 'command',
    input: z.object({ missionId: Uuidv7 }).strict(),
    output: z.object({ removed: z.number().int().nonnegative() }).strict()
  },

  // ---- The Memory System (SET 11) ----
  'memory.status': { kind: 'query', input: Empty, output: MemoryStatus },
  /** Metadata, keyword, relationship or (when turned on) semantic search. Sensitive content stays hidden. */
  'memory.search': { kind: 'query', input: MemoryQuery, output: MemorySearchResult },
  /** One memory; `reveal` shows a sensitive memory's content (the person only). */
  'memory.get': {
    kind: 'query',
    input: z.object({ memoryId: Uuidv7, reveal: z.boolean() }).strict(),
    output: MemoryEntry
  },
  /** Something that might be remembered. The Memory Policy decides: SAVE, DO_NOT_SAVE or ASK_USER. */
  'memory.propose': { kind: 'command', input: MemoryCandidateInput, output: MemoryProposalResult },
  /** Candidates waiting for the person (ASK_USER). */
  'memory.candidates': {
    kind: 'query',
    input: Empty,
    output: z.object({ candidates: z.array(MemoryCandidate).max(100) }).strict()
  },
  /** The person's answer to a candidate. Nothing is saved without it. */
  'memory.decide': {
    kind: 'command',
    input: z.object({ candidateId: Uuidv7, decision: z.enum(['SAVE', 'DO_NOT_SAVE']) }).strict(),
    output: MemoryProposalResult
  },
  /** The person corrects a memory. */
  'memory.update': { kind: 'command', input: MemoryCorrection, output: MemoryEntry },
  /** Forget (never recalled, kept) or restore a memory. */
  'memory.forget': {
    kind: 'command',
    input: z.object({ memoryId: Uuidv7, forgotten: z.boolean() }).strict(),
    output: MemoryEntry
  },
  /** Erase a memory for good. Needs `memory.delete`. */
  'memory.delete': {
    kind: 'command',
    input: z.object({ memoryId: Uuidv7 }).strict(),
    output: z.object({ deleted: z.boolean() }).strict()
  },
  /** Export memories as a JSON artifact. Sensitive content is never exported. */
  'memory.export': {
    kind: 'command',
    input: z.object({ includeForgotten: z.boolean() }).strict(),
    output: Artifact
  },
  /** The policy's recent decisions (never their content). */
  'memory.decisions': {
    kind: 'query',
    input: z.object({ limit: z.number().int().min(1).max(200) }).strict(),
    output: z.object({ decisions: z.array(MemoryDecisionRecord).max(200) }).strict()
  },

  // ---- Obsidian notes (SET 11) ----
  'notes.status': { kind: 'query', input: Empty, output: NotesStatus },
  /** The person chooses a vault (or a folder for Jupiter Brain) in the system's folder dialog. */
  'notes.connect': {
    kind: 'command',
    input: z.object({ kind: z.enum(['obsidian-vault', 'jupiter-brain']) }).strict(),
    output: NotesStatus
  },
  'notes.disconnect': { kind: 'command', input: Empty, output: NotesStatus },
  /** Adds the suggested Jupiter Brain folders that are missing; nothing is moved or renamed. */
  'notes.structure': {
    kind: 'command',
    input: Empty,
    output: z
      .object({
        created: z.array(z.string().max(1000)).max(20),
        existing: z.array(z.string().max(1000)).max(20)
      })
      .strict()
  },
  'notes.list': {
    kind: 'query',
    input: z
      .object({
        folder: NoteFolder,
        recursive: z.boolean(),
        limit: z.number().int().min(1).max(500)
      })
      .strict(),
    output: z
      .object({ entries: z.array(NoteEntry).max(500), total: z.number().int().nonnegative() })
      .strict()
  },
  'notes.search': {
    kind: 'command',
    input: z
      .object({
        text: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(100),
        missionId: Uuidv7.nullable()
      })
      .strict(),
    output: z
      .object({ hits: z.array(NoteSearchHit).max(100), scanned: z.number().int().nonnegative() })
      .strict()
  },
  'notes.read': {
    kind: 'command',
    input: z.object({ path: NotePath, missionId: Uuidv7.nullable() }).strict(),
    output: Note
  },
  /** A new note, with frontmatter, links to existing notes and a backlink in each of them. */
  'notes.create': { kind: 'command', input: NoteCreateInput, output: NoteWriteResult },
  /** Adds text under a heading at the end of a note; everything already in it stays. */
  'notes.append': {
    kind: 'command',
    input: z
      .object({
        path: NotePath,
        heading: z.string().trim().min(1).max(200).nullable(),
        text: z.string().trim().min(1).max(50_000),
        missionId: Uuidv7.nullable()
      })
      .strict(),
    output: NoteWriteResult
  },
  /** Links two notes both ways, once: `[[to]]` in `from`, a backlink to `from` in `to`. */
  'notes.link': {
    kind: 'command',
    input: z.object({ from: NotePath, to: NoteTitle, missionId: Uuidv7.nullable() }).strict(),
    output: NoteWriteResult
  },
  // ---- Voice (SET 12) ----
  /** State, the microphone, each engine and where it runs, the last exchange (memory only). */
  'voice.status': { kind: 'query', input: Empty, output: VoiceStatus },
  /** Voices of the operating system and of the speech model the router would use. */
  'voice.voices': {
    kind: 'query',
    input: Empty,
    output: z.object({ voices: z.array(VoiceOption).max(250), system: SystemVoices }).strict()
  },
  /**
   * Lets the interface name the audio devices for a few seconds (the host
   * opens its microphone gate for that only). Asks for `microphone.listen`.
   */
  'voice.devices.reveal': {
    kind: 'command',
    input: Empty,
    output: z.object({ until: UtcTimestamp }).strict()
  },
  /** Starts listening (Push-to-Talk, or the wake word). Asks for `microphone.listen` first. */
  'voice.listen.start': { kind: 'command', input: ListenStartInput, output: ListenSession },
  /** Audio of the listening session, in order; kept in memory only. */
  'voice.audio': {
    kind: 'command',
    input: AudioChunkInput,
    output: z.object({ state: VoiceState, accepted: z.boolean() }).strict()
  },
  /** Ends the session: `released` transcribes what was said; the microphone gate closes. */
  'voice.listen.stop': { kind: 'command', input: ListenStopInput, output: VoiceStatus },
  /** Speech to play, once; it is dropped when played, interrupted or replaced. */
  'voice.utterance': {
    kind: 'query',
    input: z.object({ utteranceId: Uuidv7 }).strict(),
    output: Utterance
  },
  /** The interface reports what really happened to the audio it plays. */
  'voice.playback': { kind: 'command', input: PlaybackInput, output: VoiceStatus },
  /** Stops speaking (barge-in) and whatever the voice pipeline was doing. */
  'voice.interrupt': { kind: 'command', input: Empty, output: VoiceStatus },
  /** Speaks a text (for example to test the voice). */
  'voice.speak': {
    kind: 'command',
    input: z
      .object({ text: z.string().trim().min(1).max(2_000), language: SpokenLanguage.nullable() })
      .strict(),
    output: z.object({ utteranceId: Uuidv7 }).strict()
  },
  /** Leaves ERROR once the person has seen it. */
  'voice.recover': { kind: 'command', input: Empty, output: VoiceStatus },
  // ---- Vision and camera (SET 13) ----
  /** Each engine and where it runs, the images held in memory, and the camera. */
  'vision.status': { kind: 'query', input: Empty, output: VisionStatus },
  /**
   * Captures the whole screen, the active window or a region of the screen,
   * into memory. Asks for `computer.read_screen` first.
   */
  'vision.capture': { kind: 'command', input: CaptureInput, output: ImageRef },
  /** A camera frame or an image the person chose, sent in parts; kept in memory only. */
  'vision.image.part': { kind: 'command', input: ImagePartInput, output: ImagePartResult },
  /** An image held in memory, for the interface to show. */
  'vision.image': { kind: 'query', input: ImageIdInput, output: ImageContent },
  /** Drops an image from memory at once. */
  'vision.image.discard': {
    kind: 'command',
    input: ImageIdInput,
    output: z.object({ discarded: z.boolean() }).strict()
  },
  /**
   * Reads text (on this computer), QR codes and, with a vision model the
   * router allows, what the image shows. Never invents a result: a task that
   * could not run says so.
   */
  'vision.analyze': { kind: 'command', input: AnalyzeInput, output: Observation },
  /** Before/after validation of two captures of the same target. */
  'vision.compare': { kind: 'command', input: CompareInput, output: VisualComparison },
  'camera.status': { kind: 'query', input: Empty, output: CameraStatus },
  /** Starts the camera: asks for `camera.read`, then opens the host's camera gate. */
  'camera.start': { kind: 'command', input: CameraStartInput, output: CameraSession },
  /** The interface reports what really happened to the camera track. */
  'camera.report': { kind: 'command', input: CameraReportInput, output: CameraStatus },
  /** Closes the camera and releases the device. */
  'camera.stop': { kind: 'command', input: CameraStopInput, output: CameraStatus }
} as const satisfies Record<string, { kind: RequestKind; input: z.ZodType; output: z.ZodType }>

export type CapabilityName = keyof typeof Capabilities
export type CapabilityInput<C extends CapabilityName> = z.infer<(typeof Capabilities)[C]['input']>
export type CapabilityOutput<C extends CapabilityName> = z.infer<(typeof Capabilities)[C]['output']>

export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === 'string' && Object.hasOwn(Capabilities, value)
}

export { BackupInfo }
