# Plugin development

A plugin is a directory containing a manifest and one JavaScript entry file. It
exports skills; Thursday runs them in a separate process and offers them to the
AI core, missions and workflows.

Read [`plugins/demo-tools`](../plugins/demo-tools) alongside this — it is the
reference implementation and it is small.

---

## Package layout

```
my-plugin/
├── manifest.json          required
├── index.js               required — the built entry file
└── src/                   optional — TypeScript source
    ├── index.ts
    └── skills/
        └── my-skill.ts
```

If `src/index.ts` exists, `npm run build:plugins` bundles it to the file named
by `manifest.main`. A plugin that already ships plain JavaScript is left alone.

---

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does.",
  "main": "index.js",
  "permissions": ["filesystem.write"],
  "skills": ["my_skill"]
}
```

| Field | Rules |
|---|---|
| `id` | lowercase letters, digits and dashes; must start alphanumeric; unique |
| `name` | shown in the UI |
| `version` | strict semver `x.y.z` |
| `main` | entry file, relative to the plugin directory; must exist |
| `permissions` | see the catalogue below; **anything not listed here can never be granted** |
| `skills` | documentation for the user; the real list is what the entry module exports |

The manifest is validated with zod on every load. An invalid manifest is
reported with the exact field and reason, and the plugin is skipped — other
plugins load normally.

---

## The entry module

Default-export an object with a `skills` array.

```ts
import type { ThursdayPlugin, ThursdaySkill } from '@thursday/plugin-api'

const greet: ThursdaySkill = {
  id: 'greet',
  name: 'Greet someone',
  description: 'Returns a greeting. The description is what the model reads when deciding to call this.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, description: 'Who to greet' }
    },
    required: ['name'],
    additionalProperties: false
  },
  execute(input, context) {
    context.log(`greeting ${String(input.name)}`)
    return { greeting: `Hello, ${String(input.name)}!` }
  }
}

const plugin: ThursdayPlugin = {
  activate(context) {
    // Optional. Throwing here marks the plugin unhealthy and it will not load.
    console.log(`ready with: ${context.permissions.join(', ') || 'no permissions'}`)
  },
  deactivate() {
    // Optional. Called on disable, reload and app shutdown.
  },
  skills: [greet]
}

export default plugin
```

`@thursday/plugin-api` is an alias onto `src/shared/plugin-api.ts`, configured
in both `tsconfig.node.json` and `scripts/build-plugins.mjs`. The import is
types only and disappears at build time.

### Skill id namespacing

Thursday registers your skill as `<pluginId>.<skillId>`. The `greet` skill in
`my-plugin` is invoked as `my-plugin.greet`. Ids are unique per plugin, so two
plugins can both ship a `greet`.

### Input schemas are enforced

`inputSchema` is a JSON Schema subset, and the registry validates against it
**before** your `execute` runs. Anything that does not match is rejected with
`INVALID_INPUT` and a message naming the offending field. Your `execute` never
sees input of the wrong shape.

Supported: `type` (object/array/string/number/integer/boolean/null),
`properties`, `required`, `enum`, `minimum`, `maximum`, `minLength`,
`maxLength`, `items`, `additionalProperties: false`. Anything else is allowed
through rather than rejected, so an unusual-but-valid schema never blocks a
working skill.

The same schema is handed to the model as a tool definition, so write real
descriptions — that is what the model uses to decide whether to call you.

### Return values

Whatever you return is JSON-serialised across the process boundary. Return
plain data. `undefined` becomes `null`. Values that cannot be serialised become
their string form.

Throwing is how you report failure. The message reaches the user directly, so
make it say what went wrong and what to do:

```ts
throw new Error('save_note needs the "filesystem.write" permission. Grant it under Plugins.')
```

---

## SkillContext

```ts
interface SkillContext {
  readonly pluginId: string
  readonly permissions: readonly Permission[]   // granted, not merely declared
  readonly dataDir: string                      // your own writable directory
  log(message: string, data?: Record<string, unknown>): void
  hasPermission(permission: Permission): boolean
  readonly host: HostBridge
}

interface HostBridge {
  getActiveTab(): Promise<{ url: string; title: string } | null>   // browser.read
  writeFile(relativePath: string, contents: string): Promise<{ path: string }>  // filesystem.write
  readFile(relativePath: string): Promise<string>                  // filesystem.read
}
```

`log()` writes a structured entry under `[PLUGIN]`, visible in Diagnostics.

Check `hasPermission` before using a gated call so you can throw a message the
user can act on. The gate is enforced in the main process regardless — checking
first is about the error message, not about security.

File access is confined to `dataDir`. Absolute paths and paths escaping the
directory with `..` are rejected by the host, not by you.

---

## Permissions

| Permission | Enforced in Alpha | What it allows |
|---|---|---|
| `browser.read` | yes | read the active tab's URL and title |
| `filesystem.read` | yes | read inside the plugin data directory |
| `filesystem.write` | yes | write inside the plugin data directory |
| `network` | yes | outbound network requests |
| `browser.control` | declared only | navigate, open and close tabs |
| `computer.mouse` / `computer.keyboard` / `computer.apps` | declared only | — |
| `camera` / `microphone` | declared only | — |
| `trading.read` / `trading.execute` | declared only | — |

"Declared only" means the permission exists in the catalogue and can be declared
and granted, but no host capability is wired to it yet. The UI labels these so
nobody believes a capability exists when it does not.

Declaring is not granting. A newly discovered plugin starts with its declared
set granted; the user can revoke any of them on the plugin's card, and
`grantPermissions` silently refuses anything the manifest never declared.

---

## Building and installing

```bash
npm run build:plugins     # compiles every plugins/*/src into its entry file
```

Plugins in `plugins/` are discovered as **built-in** on launch. To install one
from elsewhere, open **Plugins**, paste the directory path and press
**Install plugin** — it is copied into `<userData>/plugins/<id>` and started
immediately.

After editing plugin source: `npm run build:plugins`, then press **Reload** on
the plugin's card. Entry files are built, not read from source, so a reload
without a rebuild loads the old code.

---

## Testing a skill

The plugin's card has a **Try a skill** section: pick a skill, supply input
JSON, press **Run skill**, and see the full `SkillResult` — including the
failure code when it fails.

---

## What happens when a plugin misbehaves

Your plugin runs in its own process, so you cannot take Thursday down.

| Situation | Result |
|---|---|
| Entry module throws on import | health `error`, your message on the card |
| Not ready within 15 seconds | health `error`, host killed |
| Process crashes | health `crashed`, restarted up to twice, then left with the reason |
| A skill hangs | that call returns `TIMEOUT` after 30s; the plugin keeps running |
| A skill throws | that call returns `EXECUTION_ERROR` with your message |

The browser core, the AI core and every other plugin keep working throughout.
The acceptance suite installs a deliberately broken plugin and asserts exactly
this.

---

## Checklist

- [ ] `manifest.json` validates: semver version, dashed-lowercase id, `main` exists
- [ ] Every permission you use is declared in the manifest
- [ ] Every skill has a real `description` — the model reads it
- [ ] `inputSchema` matches what `execute` actually expects
- [ ] Return values are plain JSON-serialisable data
- [ ] Error messages say what went wrong *and* what to do about it
- [ ] `hasPermission` checked before any gated host call
