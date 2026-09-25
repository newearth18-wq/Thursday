import type { ThursdaySkill } from '@thursday/plugin-api'

/**
 * Writes a file, so it needs `filesystem.write`. The host confines the write
 * to this plugin's own data directory — the skill cannot reach anywhere else
 * even if it tries.
 */
export const saveNote: ThursdaySkill = {
  id: 'save_note',
  name: 'Save note',
  description: 'Saves a text note into the plugin data directory and returns the path it was written to.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: 'File name, e.g. "meeting.txt". Sub-directories are allowed.'
      },
      content: { type: 'string', description: 'The note body' }
    },
    required: ['filename', 'content'],
    additionalProperties: false
  },
  async execute(input, context) {
    if (!context.hasPermission('filesystem.write')) {
      throw new Error(
        'save_note needs the "filesystem.write" permission. Grant it under Plugins → Demo Tools.'
      )
    }
    const filename = String(input.filename)
    const content = String(input.content ?? '')
    const written = await context.host.writeFile(filename, content)
    context.log(`Saved note "${filename}"`, { bytes: content.length })
    return {
      path: written.path,
      bytes: content.length,
      savedAt: new Date().toISOString()
    }
  }
}
