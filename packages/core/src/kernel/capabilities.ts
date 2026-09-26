import {
  Capabilities,
  SettingDefinitions,
  SettingKey,
  type CapabilityInput,
  type CapabilityName,
  type CapabilityOutput,
  type SettingRecord
} from '@jupiter/contracts'
import { JupiterError } from '../errors'
import type { CapabilityContext, CapabilityDefinition } from '../dispatch/dispatcher'
import type { OperationContext } from '../ai/providers'
import type { CoreKernel } from './core-kernel'

/**
 * Jupiter Core's capabilities (SET 1, the SET 2 notification bridge, and SET 3
 * AI providers, routing and chat). Input and output schemas come from the
 * shared capability catalogue; the policy (who may call it, risk, audit,
 * dependencies) is declared here, next to the handler.
 */

type Policy = Omit<
  CapabilityDefinition<unknown, unknown>,
  'id' | 'kind' | 'input' | 'output' | 'handle' | 'target'
>

function define<C extends CapabilityName>(
  id: C,
  policy: Policy,
  handle: (
    input: CapabilityInput<C>,
    context: CapabilityContext
  ) => Promise<CapabilityOutput<C>> | CapabilityOutput<C>,
  target?: (input: CapabilityInput<C>) => string | null
): CapabilityDefinition<CapabilityInput<C>, CapabilityOutput<C>> {
  const contract = Capabilities[id]
  return {
    id,
    kind: contract.kind,
    input: contract.input as never,
    output: contract.output as never,
    ...policy,
    handle,
    ...(target ? { target } : {})
  }
}

const UI_READ: Policy = {
  allowedActors: ['user-interface'],
  risk: 'LOW',
  provider: 'core',
  audit: 'denials-only',
  timeoutMs: 10_000,
  requires: []
}

/** Reads of AI configuration and chat history (SET 3). */
const AI_READ: Policy = { ...UI_READ, requires: ['database', 'model-router'] }
/** Changes the person makes to AI configuration or chat: always audited. */
const AI_WRITE: Policy = { ...AI_READ, audit: 'always' }

/** Missions (SET 4): reads, and changes that are audited on every call (refusals included). */
const MISSION_READ: Policy = { ...UI_READ, requires: ['database', 'mission-manager'] }
const MISSION_WRITE: Policy = { ...MISSION_READ, audit: 'always' }
/** Skills (SET 6): reads; state changes and invocations are audited on every call. */
const SKILL_READ: Policy = {
  ...UI_READ,
  requires: ['database', 'permission-engine', 'skill-registry']
}
const SKILL_WRITE: Policy = { ...SKILL_READ, audit: 'always' }
/** An invocation may run up to the longest Skill timeout (10 minutes). */
const SKILL_INVOKE: Policy = { ...SKILL_WRITE, risk: 'MEDIUM', timeoutMs: 610_000 }
/** Permissions (SET 7): only the person may answer or revoke; every change is audited. */
const PERMISSION_READ: Policy = { ...UI_READ, requires: ['database', 'permission-engine'] }
const PERMISSION_WRITE: Policy = { ...PERMISSION_READ, risk: 'HIGH', audit: 'always' }
/** Commands that plan or run a workflow (SET 5) also need the workflow engine. */
const WORKFLOW_WRITE: Policy = {
  ...MISSION_WRITE,
  requires: ['database', 'mission-manager', 'workflow-engine']
}

function operation(context: CapabilityContext): OperationContext {
  return {
    correlationId: context.request.correlationId,
    actor: context.request.actor,
    signal: context.signal
  }
}

export function coreCapabilities(kernel: CoreKernel): CapabilityDefinition<never, unknown>[] {
  const capabilities = [
    define('diagnostics.snapshot', UI_READ, () => kernel.diagnostics()),

    define(
      'diagnostics.report-renderer-error',
      { ...UI_READ, audit: 'denials-only' },
      (input, context) => {
        kernel.recordRendererError(input, context.request.correlationId)
        return { recorded: true as const }
      }
    ),

    define('settings.list', { ...UI_READ, requires: ['database'] }, () => ({
      settings: SettingKey.options.map((key) => kernel.readSetting(key))
    })),

    define(
      'settings.update',
      { ...UI_READ, audit: 'always', requires: ['database'] },
      (input, context): SettingRecord =>
        kernel.updateSetting(input.key, SettingDefinitions[input.key].parse(input.value), context),
      (input) => `setting:${input.key}`
    ),

    define('events.list', { ...UI_READ, requires: ['database'] }, (input) =>
      kernel.listEvents(input)
    ),

    define('audit.list', { ...UI_READ, requires: ['database'] }, (input) =>
      kernel.listAudit(input.limit)
    ),

    define(
      'database.backup',
      { ...UI_READ, audit: 'always', timeoutMs: 5 * 60_000, requires: ['database'] },
      (_input, context) => kernel.backupDatabase(context)
    ),

    define(
      'host.logs.reveal',
      { ...UI_READ, audit: 'always', provider: 'host', timeoutMs: 15_000 },
      async (input, context) => {
        const result = await kernel.callHost('host.logs.reveal', input, context)
        return Capabilities['host.logs.reveal'].output.parse(result)
      },
      () => 'logs-folder'
    ),

    define('host.notifications.status', { ...UI_READ, provider: 'host' }, async (input, context) =>
      Capabilities['host.notifications.status'].output.parse(
        await kernel.callHost('host.notifications.status', input, context)
      )
    ),

    define(
      'host.notifications.show',
      { ...UI_READ, audit: 'always', provider: 'host', timeoutMs: 15_000 },
      async (input, context) =>
        Capabilities['host.notifications.show'].output.parse(
          await kernel.callHost('host.notifications.show', input, context)
        ),
      () => 'desktop-notification'
    ),

    define(
      'runtime.report-host-status',
      {
        allowedActors: ['host'],
        risk: 'MEDIUM',
        provider: 'core',
        audit: 'always',
        timeoutMs: 10_000,
        requires: []
      },
      (input, context) => ({
        recorded: kernel.recordHostStatus(input.services, context.request.correlationId)
      })
    ),

    // ---- AI providers, models and routing (SET 3) ----
    define('ai.adapters.list', UI_READ, () => ({ adapters: kernel.providers.adapterList() })),

    define('ai.providers.list', AI_READ, () => ({ providers: kernel.providers.list() })),

    define(
      'ai.providers.add',
      AI_WRITE,
      (input, context) => kernel.providers.add(input, operation(context)),
      (input) => `provider:${input.adapterId}`
    ),

    define(
      'ai.providers.update',
      AI_WRITE,
      (input, context) => kernel.providers.update(input, operation(context)),
      (input) => `provider:${input.providerId}`
    ),

    define(
      'ai.providers.remove',
      { ...AI_WRITE, risk: 'MEDIUM', timeoutMs: 20_000 },
      async (input, context) => {
        await kernel.providers.remove(input.providerId, operation(context))
        return { removed: true as const, providerId: input.providerId }
      },
      (input) => `provider:${input.providerId}`
    ),

    define(
      'ai.providers.check',
      { ...AI_WRITE, timeoutMs: 30_000 },
      (input, context) => kernel.providers.check(input.providerId, operation(context)),
      (input) => `provider:${input.providerId}`
    ),

    define(
      'ai.credentials.set',
      { ...AI_WRITE, risk: 'MEDIUM', timeoutMs: 45_000 },
      (input, context) =>
        kernel.providers.setKey(input.providerId, input.apiKey, operation(context)),
      (input) => `provider-key:${input.providerId}`
    ),

    define(
      'ai.credentials.remove',
      { ...AI_WRITE, risk: 'MEDIUM', timeoutMs: 20_000 },
      (input, context) => kernel.providers.removeKey(input.providerId, operation(context)),
      (input) => `provider-key:${input.providerId}`
    ),

    define(
      'ai.models.add',
      AI_WRITE,
      (input, context) => kernel.providers.addModel(input, operation(context)),
      (input) => `model:${input.providerId}:${input.modelId}`.slice(0, 260)
    ),

    define(
      'ai.models.update',
      AI_WRITE,
      (input, context) => kernel.providers.updateModel(input, operation(context)),
      (input) => `model:${input.providerId}:${input.modelId}`.slice(0, 260)
    ),

    define('ai.route.preview', AI_READ, (input) =>
      kernel.providers.preview(
        input.capability,
        input.conversationId ? kernel.chat.messages(input.conversationId).conversation : null
      )
    ),

    define('host.credentials.status', { ...UI_READ, provider: 'host' }, async (input, context) =>
      Capabilities['host.credentials.status'].output.parse(
        await kernel.callHost('host.credentials.status', input, context)
      )
    ),

    // ---- Chat (SET 3) ----
    define('chat.conversations.list', AI_READ, (input) => ({
      conversations: kernel.chat.listConversations(input.limit)
    })),

    define(
      'chat.conversations.update',
      AI_WRITE,
      (input, context) => kernel.chat.updateConversation(input, operation(context)),
      (input) => `conversation:${input.conversationId}`
    ),

    define(
      'chat.conversations.delete',
      { ...AI_WRITE, risk: 'MEDIUM', timeoutMs: 15_000 },
      async (input, context) => {
        await kernel.chat.deleteConversation(input.conversationId, operation(context))
        return { deleted: true as const, conversationId: input.conversationId }
      },
      (input) => `conversation:${input.conversationId}`
    ),

    define('chat.messages.list', AI_READ, (input) => kernel.chat.messages(input.conversationId)),

    define(
      'chat.send',
      AI_WRITE,
      (input, context) => kernel.chat.send(input, operation(context)),
      (input) =>
        input.conversationId ? `conversation:${input.conversationId}` : 'conversation:new'
    ),

    define(
      'chat.stop',
      AI_WRITE,
      (input) => ({ stopped: kernel.chat.stop(input.messageId) }),
      (input) => `message:${input.messageId}`
    ),

    define(
      'chat.retry',
      AI_WRITE,
      (input, context) => kernel.chat.retry(input.messageId, operation(context)),
      (input) => `message:${input.messageId}`
    ),

    define(
      'chat.edit',
      AI_WRITE,
      (input, context) => kernel.chat.edit(input.messageId, input.text, operation(context)),
      (input) => `message:${input.messageId}`
    ),

    // ---- Missions (SET 4) ----
    define(
      'missions.create',
      WORKFLOW_WRITE,
      (input, context) => kernel.missions.create(input, operation(context)),
      () => 'mission:new'
    ),
    define('missions.list', MISSION_READ, (input) => ({
      missions: kernel.missions.list(input.includeArchived, input.limit)
    })),
    define('missions.get', MISSION_READ, (input) => kernel.missions.detail(input.missionId)),
    define('missions.timeline', MISSION_READ, (input) => ({
      events: kernel.missions.timeline(input.missionId)
    })),
    define(
      'missions.pause',
      MISSION_WRITE,
      (input, context) => kernel.missions.pause(input.missionId, operation(context)),
      (input) => `mission:${input.missionId}`
    ),
    define(
      'missions.resume',
      WORKFLOW_WRITE,
      (input, context) => kernel.missions.resume(input.missionId, operation(context)),
      (input) => `mission:${input.missionId}`
    ),
    define(
      'missions.cancel',
      MISSION_WRITE,
      (input, context) => kernel.missions.cancel(input.missionId, operation(context)),
      (input) => `mission:${input.missionId}`
    ),
    define(
      'missions.retry',
      WORKFLOW_WRITE,
      (input, context) => kernel.missions.retry(input.missionId, operation(context)),
      (input) => `mission:${input.missionId}`
    ),
    define(
      'missions.archive',
      MISSION_WRITE,
      (input, context) => kernel.missions.archive(input.missionId, operation(context)),
      (input) => `mission:${input.missionId}`
    ),

    // ---- Planner and Workflow Engine (SET 5) ----
    define(
      'missions.approve',
      WORKFLOW_WRITE,
      (input, context) =>
        kernel.missions.decide(input.missionId, input.stepId, true, operation(context)),
      (input) => `mission:${input.missionId}`
    ),
    define(
      'missions.reject',
      WORKFLOW_WRITE,
      (input, context) =>
        kernel.missions.decide(input.missionId, input.stepId, false, operation(context)),
      (input) => `mission:${input.missionId}`
    ),
    define(
      'missions.replan',
      WORKFLOW_WRITE,
      (input, context) =>
        kernel.missions.replan(
          input.missionId,
          { feedback: input.feedback, planner: input.planner },
          operation(context)
        ),
      (input) => `mission:${input.missionId}`
    ),
    define('missions.step-types', MISSION_READ, () => ({ stepTypes: kernel.missions.stepTypes() })),

    // ---- Skills (SET 6) ----
    define('skills.list', SKILL_READ, (input) => ({ skills: kernel.skills.search(input.filter) })),
    define('skills.get', SKILL_READ, (input) => kernel.skills.get(input.skillId, input.version)),
    define('skills.versions', SKILL_READ, (input) => ({
      versions: kernel.skills.listVersions(input.skillId)
    })),
    define(
      'skills.enable',
      SKILL_WRITE,
      (input, context) =>
        kernel.skills.setEnabled(input.skillId, input.version, true, context.request.actor),
      (input) => `skill:${input.skillId}`
    ),
    define(
      'skills.disable',
      SKILL_WRITE,
      (input, context) =>
        kernel.skills.setEnabled(input.skillId, input.version, false, context.request.actor),
      (input) => `skill:${input.skillId}`
    ),
    define(
      'skills.health-check',
      SKILL_WRITE,
      (input, context) =>
        kernel.skills.healthCheck(input.skillId, input.version, context.request.actor),
      (input) => `skill:${input.skillId}`
    ),
    define(
      'skills.invoke',
      SKILL_INVOKE,
      (input, context) =>
        kernel.skills.invoke({
          executionId: input.executionId,
          skillId: input.skillId,
          version: input.version,
          input: input.input,
          timeoutMs: input.timeoutMs,
          idempotencyKey: input.idempotencyKey,
          missionId: null,
          actor: context.request.actor,
          correlationId: context.request.correlationId,
          signal: context.signal
        }),
      (input) => `skill:${input.skillId}`
    ),
    define(
      'skills.cancel',
      SKILL_WRITE,
      (input) => ({ cancelled: kernel.skills.cancel(input.executionId) }),
      (input) => `skill-execution:${input.executionId}`
    ),
    define('skills.executions', SKILL_READ, (input) => ({
      executions: kernel.skills.executions({ skillId: input.skillId, limit: input.limit })
    })),

    // ---- Permissions (SET 7) ----
    define('permissions.catalogue', PERMISSION_READ, () => ({
      capabilities: kernel.permissions.catalogue()
    })),
    define('permissions.requests', PERMISSION_READ, (input) => ({
      requests: kernel.permissions.requests({
        pendingOnly: input.status === 'PENDING',
        missionId: input.missionId,
        limit: input.limit
      })
    })),
    define(
      'permissions.decide',
      PERMISSION_WRITE,
      (input, context) =>
        kernel.permissions.decide(input.requestId, input.decision, context.request.actor),
      (input) => `permission-request:${input.requestId}`
    ),
    define('permissions.grants', PERMISSION_READ, (input) => ({
      grants: kernel.permissions.grants({ includeEnded: input.includeEnded, limit: input.limit })
    })),
    define(
      'permissions.revoke',
      PERMISSION_WRITE,
      (input, context) => kernel.permissions.revoke(input.grantId, context.request.actor),
      (input) => `permission-grant:${input.grantId}`
    ),
    define('permissions.audit', PERMISSION_READ, (input) => ({
      entries: kernel.permissions.auditTrail(input.limit)
    }))
  ]
  for (const capability of capabilities) {
    if (!Object.hasOwn(Capabilities, capability.id)) {
      throw new JupiterError(
        'CAPABILITY_NOT_IN_CATALOGUE',
        `${capability.id} is not in the capability catalogue`,
        {
          category: 'internal',
          userAction: null
        }
      )
    }
  }
  return capabilities as unknown as CapabilityDefinition<never, unknown>[]
}
