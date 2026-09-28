import { resolve } from 'node:path'
import { bundleBrowserRuntime } from '@jupiter/browser-runtime/build'
import { bundleDocumentRuntime } from '@jupiter/document-runtime/build'
import { bundleIdentityRuntime } from '@jupiter/identity-runtime/build'
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

/**
 * The browser runtime (SET 9) runs in a process of its own: it is bundled
 * separately, with Playwright inside, next to the main bundle.
 */
function browserRuntime(): Plugin {
  return {
    name: 'jupiter-browser-runtime',
    apply: 'build',
    async closeBundle() {
      await bundleBrowserRuntime(resolve(__dirname, 'out/main/browser-runtime.cjs'))
    }
  }
}

/** The document runtime (SET 10), bundled into one ES module next to the main process. */
function documentRuntime(): Plugin {
  return {
    name: 'jupiter-document-runtime',
    apply: 'build',
    async closeBundle() {
      await bundleDocumentRuntime(resolve(__dirname, 'out/main/document-runtime.mjs'))
    }
  }
}

/**
 * The identity runtime (SET 14): the face engine in a process of its own, with the face
 * models and TensorFlow.js's WebAssembly files copied next to it (nothing is downloaded).
 */
function identityRuntime(): Plugin {
  return {
    name: 'jupiter-identity-runtime',
    apply: 'build',
    async closeBundle() {
      await bundleIdentityRuntime(
        resolve(__dirname, 'out/main/identity-runtime.cjs'),
        resolve(__dirname, 'out/main/identity')
      )
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
      plugins: [browserRuntime(), documentRuntime(), identityRuntime()],
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
