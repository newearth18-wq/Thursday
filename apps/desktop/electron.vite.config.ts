import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { BuildOptions, Plugin } from 'vite'
import { collectBuildMetadata } from './scripts/build-metadata'

/**
 * Content Security Policy for the renderer.
 *
 * Production allows nothing but the app's own bundled files: no inline or
 * evaluated script, no remote content, no network connections. The dev server
 * additionally needs inline scripts (React Refresh preamble), inline styles
 * (Vite CSS injection) and its own loopback websocket; those relaxations exist
 * only in `electron-vite dev` and never reach a build.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

const DEVELOPMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self'",
  'connect-src ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*',
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join('; ')

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
          input: { index: resolve(__dirname, 'src/main/index.ts') },
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
