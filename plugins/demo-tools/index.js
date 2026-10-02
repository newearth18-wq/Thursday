// demo-tools (SET 15): Jupiter's demonstration plugin.
// Runs only in Jupiter's plugin runtime: there is no require, process, file system or network
// here. The plugin reaches Jupiter only through context.use(handle, args), and only with the
// handles its manifest declares — each behind a permission the person grants.

/** Returns exactly the text it is given. */
module.exports.echoText = async (input) => ({ text: input.text })

/** Returns the version and channel of this Jupiter (handle: app.version). */
module.exports.getAppVersion = async (input, context) => {
  const build = await context.use('app.version')
  return { version: build.version, channel: build.channel }
}

/** Saves a note in the plugin's own storage (handle: storage.write). Never replaces a note. */
module.exports.saveNote = async (input, context) => {
  const saved = await context.use('storage.write', {
    path: 'notes/' + input.name + '.md',
    text: input.text
  })
  return { path: saved.path, bytes: saved.bytes }
}
