import type { ThursdaySkill } from '@thursday/plugin-api'

/** The simplest possible skill: no permissions, no I/O, fully deterministic. */
export const echoText: ThursdaySkill = {
  id: 'echo_text',
  name: 'Echo text',
  description: 'Returns the text it was given. Useful for checking that skill routing works.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, description: 'The text to echo back' }
    },
    required: ['text'],
    additionalProperties: false
  },
  execute(input) {
    const text = String(input.text)
    return {
      echoed: text,
      length: text.length
    }
  }
}
