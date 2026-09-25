import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { BuildOptions, Plugin } from 'vite'
import { collectBuildMetadata } from './scripts/build-metadata'
import { DEVELOPMENT_CSP, PRODUCTION_CSP } from './src/shared/csp'

/** Writes the CSP meta tag: the strict policy for builds, a relaxed one only for the dev server. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'jupiter-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const policy = context.server ? DEVELOPMENT_CSP : PRODUCTION_CSP
        if (!html.includes('%JUPITER_CSP%'))
          throw new Error('index.html is missing the %JUPITER_CSP% placeholder')
        return html.replace('%JUPITER_CSP%', policy)
      }
    }
  }
}

/** zod ships comments Rollup cannot place; the warning is noise, not a defect. */
const onwarn: NonNullable<NonNullable<BuildOptions['rollupOptions']>['onwarn']> = (
  warning,
  warn
) => {
  if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('/node_modules/zod/')) return
  warn(warning)
}

export default defineConfig(({ command }) => {
  const metadata = collectBuildMetadata({ appDirectory: __dirname, command, env: process.env })

  return {
    main: {
      define: { __JUPITER_BUILD_METADATA__: JSON.stringify(metadata) },
      build: {
        // Everything is bundled: the packaged app ships no node_modules.
        externalizeDeps: false,
        sourcemap: false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            // Jupiter Core runs in its own utility process (a separate crash domain).
            core: resolve(__dirname, 'src/core/index.ts')
          },
          onwarn,
          output: { format: 'es', entryFileNames: '[name].js' }
        }
      }
    },
    preload: {
      build: {
        // Sandboxed preloads cannot require() from node_modules: bundle into one CommonJS file.
        externalizeDeps: false,
        sourcemap: false,
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/preload/index.ts') },
          output: { format: 'cjs', entryFileNames: '[name].cjs' }
        }
      }
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react(), contentSecurityPolicy()],
      build: {
        sourcemap: false,
        // Never inline assets as data: URIs — the CSP only allows the app's own files.
        assetsInlineLimit: 0,
        minify: 'esbuild',
        rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') }, onwarn }
      }
    }
  }
})
