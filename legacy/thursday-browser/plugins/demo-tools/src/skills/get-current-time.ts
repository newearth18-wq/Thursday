import type { ThursdaySkill } from '@thursday/plugin-api'

/** Reads the host clock. Still no permissions needed. */
export const getCurrentTime: ThursdaySkill = {
  id: 'get_current_time',
  name: 'Get current time',
  description: 'Returns the current date and time from the machine Thursday is running on.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['iso', 'locale'],
        description: 'iso for a machine-readable timestamp, locale for a human-readable one'
      }
    },
    additionalProperties: false
  },
  execute(input) {
    const now = new Date()
    const format = input.format === 'locale' ? 'locale' : 'iso'
    return {
      iso: now.toISOString(),
      epochMs: now.getTime(),
      formatted: format === 'locale' ? now.toLocaleString() : now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  }
}
