import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Compiles every plugin under ./plugins from TypeScript into the single
 * JavaScript entry file its manifest points at.
 *
 * Plugins are bundled (not merely transpiled) so a plugin directory is
 * self-contained at runtime: the plugin host loads one file and never has to
 * resolve a plugin's own module graph.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(root, 'plugins')

async function main() {
  if (!existsSync(pluginsDir)) {
    console.log('[plugins] no plugins directory; nothing to build')
    return
  }

  const entries = await readdir(pluginsDir)
  let built = 0

  for (const name of entries) {
    const dir = join(pluginsDir, name)
    if (!(await stat(dir)).isDirectory()) continue

    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      console.warn(`[plugins] skipping ${name}: no manifest.json`)
      continue
    }

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const outfile = join(dir, manifest.main ?? 'index.js')
    const source = join(dir, 'src', 'index.ts')

    if (!existsSync(source)) {
      // A plugin may ship plain JavaScript already; nothing to compile.
      if (existsSync(outfile)) {
        console.log(`[plugins] ${name}: prebuilt ${manifest.main ?? 'index.js'}, skipping`)
        continue
      }
      console.warn(`[plugins] skipping ${name}: neither src/index.ts nor ${manifest.main} exists`)
      continue
    }

    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      sourcemap: false,
      logLevel: 'warning',
      // Plugin sources import their types under this public name.
      alias: { '@thursday/plugin-api': join(root, 'src', 'shared', 'plugin-api.ts') }
    })

    console.log(`[plugins] built ${name} -> ${manifest.main ?? 'index.js'}`)
    built++
  }

  console.log(`[plugins] ${built} plugin(s) built`)
}

main().catch((err) => {
  console.error('[plugins] build failed:', err.message)
  process.exit(1)
})
