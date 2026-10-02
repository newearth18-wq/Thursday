# Plugins (SET 15)

Each folder here is a plugin that ships with Jupiter. It is copied next to
the app at build time and shown in **Plugins** as available to install; it
runs only after the person installs and enables it.

- [`demo-tools`](demo-tools/) — the demonstration plugin: `echo_text`,
  `get_app_version` and `save_note`.

A plugin is a folder with a `manifest.json` (id, name, version, entrypoint,
`minimumJupiterVersion`, publisher, permissions, capabilities, Skills, and the
SHA-256 of every file) and its code. Jupiter validates all of it before
anything runs, and runs the code only in the isolated plugin runtime
(`services/plugin-runtime`) — never in the Electron main process or the
interface. See [AGENTS.md](../AGENTS.md) and ADR 0016.

After changing a plugin's files, refresh its integrity list:

```bash
node scripts/plugin-integrity.mjs plugins/<plugin>
```
