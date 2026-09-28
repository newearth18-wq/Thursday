import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Bundles the identity runtime (SET 14) into one CommonJS file, and copies
 * what it reads at run time — the three face models and TensorFlow.js's
 * WebAssembly binaries — into an assets folder next to it. The packaged app
 * ships no node_modules; nothing is ever downloaded.
 */

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export const IDENTITY_MODELS = [
  'ssd_mobilenetv1_model',
  'face_landmark_68_model',
  'face_recognition_model'
] as const

export async function bundleIdentityRuntime(outfile: string, assetsDir: string): Promise<void> {
  await build({
    entryPoints: [join(here, 'runtime.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // TensorFlow.js asks for these only on backends the runtime does not use.
    external: ['@tensorflow/tfjs-node', '@tensorflow/tfjs-node-gpu'],
    logLevel: 'error',
    legalComments: 'none'
  })
  mkdirSync(assetsDir, { recursive: true })
  const models = join(dirname(require.resolve('@vladmandic/face-api/package.json')), 'model')
  for (const name of IDENTITY_MODELS)
    for (const file of [`${name}-weights_manifest.json`, `${name}.bin`])
      copyFileSync(join(models, file), join(assetsDir, file))
  const wasm = dirname(require.resolve('@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm'))
  for (const file of readdirSync(wasm).filter((name) => name.endsWith('.wasm')))
    copyFileSync(join(wasm, file), join(assetsDir, file))
}
