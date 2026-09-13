import { z } from 'zod'
import { IPC_CHANNELS, IPC_EVENT_NAMES, type ChannelName, type EventName } from './channels.js'
import * as S from './schemas.js'

/**
 * The IPC contract.
 *
 * `IPC_INPUT` is the runtime validator used by the main process: every
 * renderer->main call is parsed before a handler ever sees it. `ThursdayApi`
 * is the compile-time shape shared by the preload bridge and the renderer,
 * so a typo in a channel name is a build error rather than a silent no-op.
 */

const empty = z.void().or(z.undefined())
const id = z.object({ id: z.string().min(1) })

export const IPC_INPUT = {
  /* --- browser core --- */
  'browser:getState': empty,
  'browser:newTab': z.object({ url: z.string().optional() }).optional(),
  'browser:closeTab': id,
  'browser:activateTab': id,
  'browser:navigate': z.object({ id: z.string().min(1), url: z.string().min(1) }),
  'browser:goBack': id,
  'browser:goForward': id,
  'browser:reload': id,
  'browser:stop': id,
  'browser:setViewport': z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    visible: z.boolean()
  }),
  'browser:getDownloads': empty,

  /* --- providers / models --- */
  'providers:list': empty,
  'providers:save': S.ProviderDraft,
  'providers:delete': id,
  'providers:test': id,
  'providers:models': id,
  'localai:detect': empty,

  /* --- chat --- */
  'chat:listConversations': empty,
  'chat:createConversation': z.object({ title: z.string().optional() }).optional(),
  'chat:deleteConversation': id,
  'chat:messages': z.object({ conversationId: z.string().min(1) }),
  'chat:send': z.object({
    conversationId: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    content: z.string().min(1),
    /** Give the model access to registered skills for this turn. */
    useSkills: z.boolean().optional()
  }),
  'chat:cancel': z.object({ streamId: z.string().min(1) }),

  /* --- plugins / skills --- */
  'plugins:list': empty,
  'plugins:install': z.object({ dir: z.string().min(1) }),
  'plugins:uninstall': id,
  'plugins:setEnabled': z.object({ id: z.string().min(1), enabled: z.boolean() }),
  'plugins:grantPermissions': z.object({
    id: z.string().min(1),
    permissions: z.array(S.PermissionEnum)
  }),
  'plugins:reload': id,
  'skills:list': empty,
  'skills:invoke': z.object({
    skillId: z.string().min(1),
    input: z.record(z.unknown()).default({})
  }),

  /* --- missions --- */
  'missions:list': empty,
  'missions:get': id,
  'missions:create': S.MissionDraft,
  'missions:plan': z.object({
    title: z.string().min(1),
    goal: z.string().min(1),
    providerId: z.string().optional(),
    model: z.string().optional()
  }),
  'missions:start': id,
  'missions:pause': id,
  'missions:resume': id,
  'missions:cancel': id,
  'missions:approve': z.object({ missionId: z.string().min(1), stepId: z.string().min(1) }),
  'missions:reject': z.object({
    missionId: z.string().min(1),
    stepId: z.string().min(1),
    reason: z.string().optional()
  }),
  'missions:delete': id,

  /* --- workflows --- */
  'workflows:list': empty,
  'workflows:save': z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    nodes: z.array(S.WorkflowNode.partial({ config: true, next: true, onTrue: true, onFalse: true }))
  }),
  'workflows:delete': id,
  'workflows:run': z.object({ workflowId: z.string().min(1), input: z.record(z.unknown()).optional() }),
  'workflows:runs': z.object({ workflowId: z.string().optional() }).optional(),
  'workflows:approve': z.object({ runId: z.string().min(1), approved: z.boolean() }),
  'workflows:cancel': z.object({ runId: z.string().min(1) }),

  /* --- command center / diagnostics / logs --- */
  'commandcenter:state': empty,
  'diagnostics:run': empty,
  'logs:query': z
    .object({
      category: S.LogCategory.optional(),
      level: S.LogLevel.optional(),
      limit: z.number().int().min(1).max(2000).optional(),
      search: z.string().optional()
    })
    .optional(),
  'logs:clear': empty,

  /* --- settings --- */
  'settings:get': empty,
  'settings:set': S.GeneralSettings.partial(),
  'app:info': empty
} as const

export type IpcChannel = keyof typeof IPC_INPUT

/** Input type for a channel, after zod parsing. */
export type IpcInput<C extends IpcChannel> = z.infer<(typeof IPC_INPUT)[C]>

/**
 * Compile-time guarantee that `channels.ts` and `IPC_INPUT` describe exactly
 * the same set of channels. Adding a channel to one but not the other makes
 * `AssertNever` fail to typecheck rather than producing a channel that is
 * bridged but unvalidated (or validated but unreachable).
 */
type AssertNever<T extends never> = T
type ChannelDrift = Exclude<IpcChannel, ChannelName> | Exclude<ChannelName, IpcChannel>
export type _ChannelsInSync = AssertNever<ChannelDrift>

export { IPC_CHANNELS, IPC_EVENT_NAMES }

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataDir: string
}

export interface ChatSendAck {
  streamId: string
  userMessageId: string
  assistantMessageId: string
}

export interface PluginInstallResult {
  ok: boolean
  pluginId: string | null
  error: string | null
}

/** Return types, keyed by channel. */
export interface IpcResult {
  'browser:getState': S.BrowserState
  'browser:newTab': S.TabState
  'browser:closeTab': S.BrowserState
  'browser:activateTab': S.BrowserState
  'browser:navigate': void
  'browser:goBack': void
  'browser:goForward': void
  'browser:reload': void
  'browser:stop': void
  'browser:setViewport': void
  'browser:getDownloads': S.DownloadItem[]

  'providers:list': S.ProviderConfig[]
  'providers:save': S.ProviderConfig
  'providers:delete': void
  'providers:test': S.ConnectionResult
  'providers:models': { ok: boolean; models: S.ModelInfo[]; error: string | null }
  'localai:detect': S.LocalAiDetection[]

  'chat:listConversations': S.Conversation[]
  'chat:createConversation': S.Conversation
  'chat:deleteConversation': void
  'chat:messages': S.StoredMessage[]
  'chat:send': ChatSendAck
  'chat:cancel': void

  'plugins:list': S.PluginRecord[]
  'plugins:install': PluginInstallResult
  'plugins:uninstall': void
  'plugins:setEnabled': S.PluginRecord
  'plugins:grantPermissions': S.PluginRecord
  'plugins:reload': S.PluginRecord
  'skills:list': S.SkillDescriptor[]
  'skills:invoke': S.SkillResult

  'missions:list': S.Mission[]
  'missions:get': S.Mission | null
  'missions:create': S.Mission
  'missions:plan': S.Mission
  'missions:start': S.Mission
  'missions:pause': S.Mission
  'missions:resume': S.Mission
  'missions:cancel': S.Mission
  'missions:approve': S.Mission
  'missions:reject': S.Mission
  'missions:delete': void

  'workflows:list': S.WorkflowDefinition[]
  'workflows:save': S.WorkflowDefinition
  'workflows:delete': void
  'workflows:run': S.WorkflowRun
  'workflows:runs': S.WorkflowRun[]
  'workflows:approve': S.WorkflowRun
  'workflows:cancel': S.WorkflowRun

  'commandcenter:state': S.CommandCenterState
  'diagnostics:run': S.DiagnosticsReport
  'logs:query': S.LogEntry[]
  'logs:clear': void

  'settings:get': S.GeneralSettings
  'settings:set': S.GeneralSettings
  'app:info': AppInfo
}

/** The bridge the preload script exposes on `window.thursday`. */
export type ThursdayApi = {
  [C in IpcChannel]: (
    ...args: IpcInput<C> extends void | undefined ? [] : [input: IpcInput<C>]
  ) => Promise<IpcResult[C]>
} & {
  on<E extends keyof IpcEvents>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

/* --- main -> renderer events --- */
export interface IpcEvents {
  'browser:state': S.BrowserState
  'browser:downloads': S.DownloadItem[]
  'chat:chunk': { streamId: string; conversationId: string; messageId: string; chunk: S.ChatChunk }
  'mission:update': S.Mission
  'missions:invalidate': void
  'plugins:update': S.PluginRecord[]
  'skills:update': S.SkillDescriptor[]
  'commandcenter:update': S.CommandCenterState
  'workflow:update': S.WorkflowRun
  'log:append': S.LogEntry
  'settings:update': S.GeneralSettings
}

type EventDrift = Exclude<keyof IpcEvents, EventName> | Exclude<EventName, keyof IpcEvents>
export type _EventsInSync = AssertNever<EventDrift>
