import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** Bundles the plugin runtime process (SET 15) into one CommonJS file with no dependencies. */
export async function bundlePluginRuntime(outfile: string): Promise<void> {
  await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'runtime.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'error',
    legalComments: 'none'
  })
}
