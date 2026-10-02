# demo-tools

Jupiter's demonstration plugin (SET 15). Its three Skills are registered as
`demo-tools.echo_text`, `demo-tools.get_app_version` and `demo-tools.save_note`.

- `echo_text` returns the text it is given (no permission).
- `get_app_version` reads this Jupiter's version (`app.version.read`).
- `save_note` saves a note in the plugin's own storage
  (`plugin.storage.write`); it cannot write anywhere else, and never replaces
  a note — a name already taken gets a free one.

`manifest.json` lists the SHA-256 of every file. After changing a file, run
`node scripts/plugin-integrity.mjs plugins/demo-tools` from the repository root.
