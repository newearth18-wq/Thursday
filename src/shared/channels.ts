/**
 * Channel names, with no dependencies at all.
 *
 * The preload script runs sandboxed, so it cannot `require` anything from
 * node_modules. Keeping the name lists here lets the bridge be built from them
 * while the zod schemas stay in `ipc.ts`, which only the main process loads.
 * `ipc.ts` asserts at compile time that the two stay in step.
 */

export const IPC_CHANNELS = [
  'browser:getState',
  'browser:newTab',
  'browser:closeTab',
  'browser:activateTab',
  'browser:navigate',
  'browser:goBack',
  'browser:goForward',
  'browser:reload',
  'browser:stop',
  'browser:setViewport',
  'browser:getDownloads',

  'providers:list',
  'providers:save',
  'providers:delete',
  'providers:test',
  'providers:models',
  'localai:detect',

  'chat:listConversations',
  'chat:createConversation',
  'chat:deleteConversation',
  'chat:messages',
  'chat:send',
  'chat:cancel',

  'plugins:list',
  'plugins:install',
  'plugins:uninstall',
  'plugins:setEnabled',
  'plugins:grantPermissions',
  'plugins:reload',
  'skills:list',
  'skills:invoke',

  'missions:list',
  'missions:get',
  'missions:create',
  'missions:plan',
  'missions:start',
  'missions:pause',
  'missions:resume',
  'missions:cancel',
  'missions:approve',
  'missions:reject',
  'missions:delete',

  'workflows:list',
  'workflows:save',
  'workflows:delete',
  'workflows:run',
  'workflows:runs',
  'workflows:approve',
  'workflows:cancel',

  'commandcenter:state',
  'diagnostics:run',
  'logs:query',
  'logs:clear',

  'settings:get',
  'settings:set',
  'app:info'
] as const

export const IPC_EVENT_NAMES = [
  'browser:state',
  'browser:downloads',
  'chat:chunk',
  'mission:update',
  'missions:invalidate',
  'plugins:update',
  'skills:update',
  'commandcenter:update',
  'workflow:update',
  'log:append',
  'settings:update'
] as const

export type ChannelName = (typeof IPC_CHANNELS)[number]
export type EventName = (typeof IPC_EVENT_NAMES)[number]

/** Shape of the error envelope the main process returns for failed calls. */
export interface ThursdayErrorEnvelope {
  __thursdayError: { message: string; code: string }
}

export function isErrorEnvelope(value: unknown): value is ThursdayErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__thursdayError' in value &&
    typeof (value as ThursdayErrorEnvelope).__thursdayError?.message === 'string'
  )
}
