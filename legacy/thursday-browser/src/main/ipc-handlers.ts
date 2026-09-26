import { app } from 'electron'
import type { AppInfo } from '@shared/ipc.js'
import { handle } from './core/ipc.js'
import { clearLogs, queryLogs } from './core/logger.js'
import { loadSettings, updateSettings } from './core/settings.js'
import { getCommandCenterState } from './core/app-state.js'
import type { TabManager } from './browser/tab-manager.js'
import { listDownloads } from './browser/downloads.js'
import {
  deleteProvider,
  detectLocalAi,
  fetchModels,
  listProviders,
  saveProvider,
  testProvider
} from './ai/router.js'
import {
  cancelChat,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  sendChat
} from './ai/chat.js'
import {
  grantPermissions,
  installPlugin,
  listPlugins,
  reloadPlugin,
  setPluginEnabled,
  uninstallPlugin
} from './plugins/engine.js'
import { invokeSkill, listSkills } from './skills/registry.js'
import { createMission, deleteMission, getMission, listMissions, requireMission } from './missions/store.js'
import {
  cancelMission,
  pauseMission,
  planMission,
  resolveApproval,
  resumeMission,
  startMission
} from './missions/supervisor.js'
import {
  approveRun,
  cancelRun,
  deleteWorkflow,
  listRuns,
  listWorkflows,
  saveWorkflow,
  startRun
} from './workflow/engine.js'
import { runDiagnostics } from './diagnostics/index.js'

/**
 * Every IPC channel in the contract is registered here, in one place, so the
 * app's entire renderer-reachable surface can be read at a glance.
 */

export interface HandlerDeps {
  getTabManager(): TabManager
  builtinPluginDir: string
}

export function registerIpcHandlers(deps: HandlerDeps): void {
  const tabs = (): TabManager => deps.getTabManager()

  /* ------------------------------ browser ----------------------------- */
  handle('browser:getState', () => tabs().getState())
  handle('browser:newTab', (input) => tabs().createTab(input?.url))
  handle('browser:closeTab', (input) => {
    tabs().closeTab(input.id)
    return tabs().getState()
  })
  handle('browser:activateTab', (input) => {
    tabs().setActive(input.id)
    return tabs().getState()
  })
  handle('browser:navigate', (input) => tabs().navigate(input.id, input.url))
  handle('browser:goBack', (input) => tabs().goBack(input.id))
  handle('browser:goForward', (input) => tabs().goForward(input.id))
  handle('browser:reload', (input) => tabs().reload(input.id))
  handle('browser:stop', (input) => tabs().stop(input.id))
  handle('browser:setViewport', (input) => tabs().setViewport(input))
  handle('browser:getDownloads', () => listDownloads())

  /* ----------------------------- providers ---------------------------- */
  handle('providers:list', () => listProviders())
  handle('providers:save', (input) => saveProvider(input))
  handle('providers:delete', (input) => deleteProvider(input.id))
  handle('providers:test', (input) => testProvider(input.id))
  handle('providers:models', (input) => fetchModels(input.id))
  handle('localai:detect', () => detectLocalAi())

  /* -------------------------------- chat ------------------------------ */
  handle('chat:listConversations', () => listConversations())
  handle('chat:createConversation', (input) => createConversation(input?.title))
  handle('chat:deleteConversation', (input) => deleteConversation(input.id))
  handle('chat:messages', (input) => listMessages(input.conversationId))
  handle('chat:send', (input) => sendChat(input))
  handle('chat:cancel', (input) => cancelChat(input.streamId))

  /* --------------------------- plugins/skills ------------------------- */
  handle('plugins:list', () => listPlugins())
  handle('plugins:install', (input) => installPlugin(input.dir))
  handle('plugins:uninstall', (input) => uninstallPlugin(input.id))
  handle('plugins:setEnabled', (input) => setPluginEnabled(input.id, input.enabled))
  handle('plugins:grantPermissions', (input) => grantPermissions(input.id, input.permissions))
  handle('plugins:reload', (input) => reloadPlugin(input.id))
  handle('skills:list', () => listSkills())
  handle('skills:invoke', (input) => invokeSkill(input.skillId, input.input))

  /* ------------------------------ missions ---------------------------- */
  handle('missions:list', () => listMissions())
  handle('missions:get', (input) => getMission(input.id))
  handle('missions:create', (input) => createMission(input))
  handle('missions:plan', (input) => planMission(input))
  handle('missions:start', (input) => startMission(input.id))
  handle('missions:pause', (input) => pauseMission(input.id))
  handle('missions:resume', (input) => resumeMission(input.id))
  handle('missions:cancel', (input) => cancelMission(input.id))
  handle('missions:approve', (input) => resolveApproval(input.missionId, input.stepId, true))
  handle('missions:reject', (input) =>
    resolveApproval(input.missionId, input.stepId, false, input.reason)
  )
  handle('missions:delete', (input) => {
    requireMission(input.id)
    deleteMission(input.id)
  })

  /* ----------------------------- workflows ---------------------------- */
  handle('workflows:list', () => listWorkflows())
  handle('workflows:save', (input) => saveWorkflow(input))
  handle('workflows:delete', (input) => deleteWorkflow(input.id))
  handle('workflows:run', (input) => startRun(input.workflowId, input.input ?? {}))
  handle('workflows:runs', (input) => listRuns(input?.workflowId))
  handle('workflows:approve', (input) => approveRun(input.runId, input.approved))
  handle('workflows:cancel', (input) => cancelRun(input.runId))

  /* --------------------- command centre / diagnostics ----------------- */
  handle('commandcenter:state', () => getCommandCenterState())
  handle('diagnostics:run', () => runDiagnostics())
  handle('logs:query', (input) => queryLogs(input ?? {}))
  handle('logs:clear', () => clearLogs())

  /* ------------------------------ settings ---------------------------- */
  handle('settings:get', () => loadSettings())
  handle('settings:set', (input) => updateSettings(input))
  handle('app:info', (): AppInfo => ({
    name: 'Thursday Browser',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    userDataDir: app.getPath('userData')
  }))
}
