import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'

/**
 * Bundles the browser runtime into one self-contained CommonJS file (SET 9):
 * the runtime, Playwright's client and the contracts it validates with. The
 * packaged app ships no node_modules, so Playwright is carried inside this
 * bundle. Playwright reads two JSON files next to its sources at run time;
 * they are inlined here. It never downloads a browser: the host passes the
 * browser to use.
 */

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function inlinePlaywrightData(): Plugin {
  const root = dirname(require.resolve('playwright-core/package.json'))
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
  const browsersJson = readFileSync(join(root, 'browsers.json'), 'utf8')
  return {
    name: 'jupiter-inline-playwright-data',
    setup(context) {
      context.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, (args) => {
        let source = readFileSync(args.path, 'utf8')
        const replace = (file: string, json: string) => {
          const pattern = new RegExp(
            `require\\((import_path\\d*)\\.default\\.join\\(packageRoot, "${file.replace('.', '\\.')}"\\)\\)`,
            'g'
          )
          const before = source
          source = source.replace(pattern, `(${json})`)
          if (source === before)
            throw new Error(
              `playwright-core no longer reads ${file} the expected way; update build.ts`
            )
        }
        replace('package.json', packageJson)
        replace('browsers.json', browsersJson)
        return { contents: source, loader: 'js' }
      })
    }
  }
}

export async function bundleBrowserRuntime(outfile: string): Promise<void> {
  await build({
    entryPoints: [join(here, 'runtime.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Only Firefox's BiDi protocol needs it; the runtime drives Chromium over CDP.
    external: ['chromium-bidi/*'],
    logLevel: 'error',
    legalComments: 'none',
    plugins: [inlinePlaywrightData()]
  })
}
