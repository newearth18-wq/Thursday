import type { ThursdayPlugin } from '@thursday/plugin-api'
import { echoText } from './skills/echo-text.js'
import { getCurrentTime } from './skills/get-current-time.js'
import { saveNote } from './skills/save-note.js'

/**
 * Demo Tools.
 *
 * The reference plugin. Its only job is to prove that the plugin engine, the
 * permission gate and the skill registry work end to end.
 */
const plugin: ThursdayPlugin = {
  activate(context) {
    // Runs inside this plugin's own host process, not in the browser core.
    console.log(
      `Demo Tools activated with permissions: ${context.permissions.join(', ') || 'none'}`
    )
  },
  skills: [echoText, getCurrentTime, saveNote]
}

export default plugin
