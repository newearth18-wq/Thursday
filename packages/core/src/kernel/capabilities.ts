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
import type { CoreKernel } from './core-kernel'

/**
 * Jupiter Core's SET 1 capabilities. Input and output schemas come from the
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
    )
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
