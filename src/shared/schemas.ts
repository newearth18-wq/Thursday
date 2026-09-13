import { z } from 'zod'
import { PERMISSIONS } from './permissions.js'

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export const LogCategory = z.enum([
  'CORE',
  'BROWSER',
  'DB',
  'MODEL',
  'PLUGIN',
  'SKILL',
  'WORKFLOW',
  'MISSION',
  'PERMISSION',
  'ERROR'
])
export type LogCategory = z.infer<typeof LogCategory>

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof LogLevel>

export const LogEntry = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  level: LogLevel,
  category: LogCategory,
  message: z.string(),
  /** Structured detail, JSON-serialisable. */
  data: z.record(z.unknown()).nullable()
})
export type LogEntry = z.infer<typeof LogEntry>

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */

export const TabState = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  favicon: z.string().nullable()
})
export type TabState = z.infer<typeof TabState>

export const BrowserState = z.object({
  tabs: z.array(TabState),
  activeTabId: z.string().nullable()
})
export type BrowserState = z.infer<typeof BrowserState>

export const DownloadItem = z.object({
  id: z.string(),
  filename: z.string(),
  url: z.string(),
  savePath: z.string(),
  state: z.enum(['progressing', 'completed', 'cancelled', 'interrupted']),
  receivedBytes: z.number(),
  totalBytes: z.number(),
  startedAt: z.number().int()
})
export type DownloadItem = z.infer<typeof DownloadItem>

/* ------------------------------------------------------------------ */
/* AI providers                                                        */
/* ------------------------------------------------------------------ */

export const ProviderKind = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'openai-compat',
  'ollama',
  'lmstudio'
])
export type ProviderKind = z.infer<typeof ProviderKind>

/** A provider as stored in the database. The API key never appears here. */
export const ProviderConfig = z.object({
  id: z.string(),
  kind: ProviderKind,
  label: z.string().min(1),
  baseUrl: z.string(),
  model: z.string().nullable(),
  enabled: z.boolean(),
  /** True when a secret is present in secure storage for this provider. */
  hasApiKey: z.boolean(),
  createdAt: z.number().int()
})
export type ProviderConfig = z.infer<typeof ProviderConfig>

export const ProviderDraft = z.object({
  id: z.string().optional(),
  kind: ProviderKind,
  label: z.string().min(1),
  baseUrl: z.string().optional(),
  model: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  /** Plain secret in transit only; stored via OS secure storage. */
  apiKey: z.string().optional()
})
export type ProviderDraft = z.infer<typeof ProviderDraft>

export const ModelInfo = z.object({
  id: z.string(),
  label: z.string(),
  contextWindow: z.number().int().nullable().optional()
})
export type ModelInfo = z.infer<typeof ModelInfo>

export const ConnectionResult = z.object({
  ok: z.boolean(),
  /** Human-readable, specific. Never "something went wrong". */
  message: z.string(),
  latencyMs: z.number().int().optional(),
  detail: z.string().optional()
})
export type ConnectionResult = z.infer<typeof ConnectionResult>

export const ChatRole = z.enum(['system', 'user', 'assistant'])
export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string()
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const ChatRequest = z.object({
  providerId: z.string(),
  model: z.string(),
  messages: z.array(ChatMessage).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** Skill ids the model is allowed to call for this turn. */
  tools: z.array(z.string()).optional()
})
export type ChatRequest = z.infer<typeof ChatRequest>

export const ChatChunk = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.unknown())
  }),
  z.object({ type: z.literal('error'), message: z.string(), detail: z.string().optional() }),
  z.object({
    type: z.literal('done'),
    finishReason: z.string().optional(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).partial().optional()
  })
])
export type ChatChunk = z.infer<typeof ChatChunk>

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export const Conversation = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type Conversation = z.infer<typeof Conversation>

export const StoredMessage = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: ChatRole,
  content: z.string(),
  createdAt: z.number().int()
})
export type StoredMessage = z.infer<typeof StoredMessage>

/* ------------------------------------------------------------------ */
/* Plugins and skills                                                  */
/* ------------------------------------------------------------------ */

export const PermissionEnum = z.enum(PERMISSIONS)

/** Declared inside a plugin's manifest.json. Validated on every load. */
export const PluginManifest = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver (x.y.z)'),
  description: z.string().optional().default(''),
  /** Entry file, relative to the plugin directory. */
  main: z.string().default('index.js'),
  permissions: z.array(PermissionEnum).default([]),
  skills: z.array(z.string()).default([])
})
export type PluginManifest = z.infer<typeof PluginManifest>

export const PluginHealth = z.enum(['ok', 'starting', 'disabled', 'error', 'crashed'])
export type PluginHealth = z.infer<typeof PluginHealth>

export const PluginRecord = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  dir: z.string(),
  enabled: z.boolean(),
  health: PluginHealth,
  /** Set when health is 'error' or 'crashed'. Always specific. */
  error: z.string().nullable(),
  permissions: z.array(PermissionEnum),
  grantedPermissions: z.array(PermissionEnum),
  skillIds: z.array(z.string()),
  installedAt: z.number().int()
})
export type PluginRecord = z.infer<typeof PluginRecord>

/** A skill as advertised by the registry. */
export const SkillDescriptor = z.object({
  id: z.string(),
  pluginId: z.string(),
  name: z.string(),
  description: z.string(),
  /** JSON Schema describing the input object. */
  inputSchema: z.record(z.unknown())
})
export type SkillDescriptor = z.infer<typeof SkillDescriptor>

export const SkillResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), output: z.unknown(), durationMs: z.number().int() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    code: z.enum([
      'SKILL_NOT_FOUND',
      'PLUGIN_DISABLED',
      'PLUGIN_UNHEALTHY',
      'PERMISSION_DENIED',
      'INVALID_INPUT',
      'TIMEOUT',
      'EXECUTION_ERROR'
    ]),
    durationMs: z.number().int()
  })
])
export type SkillResult = z.infer<typeof SkillResult>

/* ------------------------------------------------------------------ */
/* Missions                                                            */
/* ------------------------------------------------------------------ */

export const MissionStatus = z.enum([
  'IDLE',
  'PLANNING',
  'EXECUTING',
  'WAITING_APPROVAL',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'PAUSED',
  'CANCELLED'
])
export type MissionStatus = z.infer<typeof MissionStatus>

export const MissionStepStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'waiting_approval'
])
export type MissionStepStatus = z.infer<typeof MissionStepStatus>

export const MissionStep = z.object({
  id: z.string(),
  missionId: z.string(),
  index: z.number().int(),
  title: z.string(),
  /** Which skill this step invokes, when it is a skill step. */
  skillId: z.string().nullable(),
  input: z.record(z.unknown()).nullable(),
  status: MissionStepStatus,
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  requiresApproval: z.boolean(),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable()
})
export type MissionStep = z.infer<typeof MissionStep>

export const Mission = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  status: MissionStatus,
  /** 0..100 */
  progress: z.number().int().min(0).max(100),
  currentStepId: z.string().nullable(),
  steps: z.array(MissionStep),
  errors: z.array(z.string()),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  createdAt: z.number().int()
})
export type Mission = z.infer<typeof Mission>

export const MissionDraft = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        skillId: z.string().nullable().optional(),
        input: z.record(z.unknown()).nullable().optional(),
        requiresApproval: z.boolean().optional(),
        maxAttempts: z.number().int().min(1).max(5).optional()
      })
    )
    .min(1)
})
export type MissionDraft = z.infer<typeof MissionDraft>

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

export const WorkflowNodeType = z.enum([
  'ai',
  'skill',
  'condition',
  'wait',
  'human_approval',
  'file',
  'browser',
  'output'
])
export type WorkflowNodeType = z.infer<typeof WorkflowNodeType>

export const WorkflowNode = z.object({
  id: z.string().min(1),
  type: WorkflowNodeType,
  label: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  /** Node id to run next. null means "the following node in the list". */
  next: z.string().nullable().default(null),
  /** For condition nodes only. */
  onTrue: z.string().nullable().default(null),
  onFalse: z.string().nullable().default(null)
})
export type WorkflowNode = z.infer<typeof WorkflowNode>

export const WorkflowDefinition = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  nodes: z.array(WorkflowNode).min(1),
  createdAt: z.number().int()
})
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>

export const WorkflowRunStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'waiting_approval',
  'cancelled'
])
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>

export const WorkflowRun = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: WorkflowRunStatus,
  currentNodeId: z.string().nullable(),
  context: z.record(z.unknown()),
  log: z.array(
    z.object({
      ts: z.number().int(),
      nodeId: z.string(),
      message: z.string(),
      ok: z.boolean()
    })
  ),
  error: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  createdAt: z.number().int()
})
export type WorkflowRun = z.infer<typeof WorkflowRun>

/* ------------------------------------------------------------------ */
/* Command Center / diagnostics                                        */
/* ------------------------------------------------------------------ */

export const BrainState = z.enum([
  'idle',
  'listening',
  'thinking',
  'planning',
  'executing',
  'searching',
  'waiting',
  'warning',
  'error',
  'completed'
])
export type BrainState = z.infer<typeof BrainState>

export const CommandCenterState = z.object({
  brain: BrainState,
  mission: Mission.nullable(),
  activeStepTitle: z.string().nullable(),
  activeModel: z.string().nullable(),
  activeProvider: z.string().nullable(),
  activeSkill: z.string().nullable(),
  pluginHealth: z.array(
    z.object({ id: z.string(), name: z.string(), health: PluginHealth, error: z.string().nullable() })
  ),
  warnings: z.array(z.string())
})
export type CommandCenterState = z.infer<typeof CommandCenterState>

export const HealthStatus = z.enum(['ok', 'degraded', 'error', 'offline', 'disabled', 'unknown'])
export type HealthStatus = z.infer<typeof HealthStatus>

export const DiagnosticItem = z.object({
  key: z.string(),
  label: z.string(),
  status: HealthStatus,
  /** Always specific: "Connection refused at http://127.0.0.1:11434" not "error". */
  detail: z.string(),
  checkedAt: z.number().int()
})
export type DiagnosticItem = z.infer<typeof DiagnosticItem>

export const DiagnosticsReport = z.object({
  generatedAt: z.number().int(),
  items: z.array(DiagnosticItem)
})
export type DiagnosticsReport = z.infer<typeof DiagnosticsReport>

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const GeneralSettings = z.object({
  startupBehavior: z.enum(['home', 'restore']).default('home'),
  homeUrl: z.string().default('https://example.com'),
  downloadDir: z.string().default(''),
  theme: z.enum(['dark', 'midnight']).default('dark'),
  logRetention: z.number().int().min(100).max(100000).default(5000),
  sidebarOpen: z.boolean().default(true),
  activeProviderId: z.string().nullable().default(null),
  activeModel: z.string().nullable().default(null)
})
export type GeneralSettings = z.infer<typeof GeneralSettings>

export const LocalAiDetection = z.object({
  kind: z.enum(['ollama', 'lmstudio']),
  label: z.string(),
  baseUrl: z.string(),
  status: z.enum(['detected', 'not_detected', 'error']),
  detail: z.string(),
  models: z.array(ModelInfo)
})
export type LocalAiDetection = z.infer<typeof LocalAiDetection>
