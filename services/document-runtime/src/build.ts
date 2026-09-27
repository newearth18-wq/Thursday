import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Bundles the document runtime into one self-contained ES module (SET 10):
 * the runtime, its readers and writers, pdf.js and the contracts it
 * validates with. The packaged app ships no node_modules, so everything is
 * inside this file. pdf.js's worker is bundled too and runs in the same
 * process (the runtime is already a process of its own).
 */

const here = dirname(fileURLToPath(import.meta.url))

export async function bundleDocumentRuntime(outfile: string): Promise<void> {
  await build({
    entryPoints: [join(here, 'runtime.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // pdf.js loads a canvas implementation only to render pages; the runtime only reads text.
    external: ['@napi-rs/canvas'],
    banner: {
      js: "import { createRequire as __jupiterRequire } from 'node:module'; const require = __jupiterRequire(import.meta.url);"
    },
    logLevel: 'error',
    legalComments: 'none'
  })
}
