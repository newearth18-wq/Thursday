import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * One lint configuration for the whole Jupiter monorepo.
 *
 * TypeScript is linted with full type information (strictTypeChecked). The
 * renderer additionally may not import Node.js or Electron at all: the rule
 * below turns "renderer has no direct Node integration" into a build error.
 */

const TS_PROJECTS = [
  './tsconfig.json',
  './packages/contracts/tsconfig.json',
  './packages/core/tsconfig.json',
  './packages/database/tsconfig.json',
  './packages/providers/tsconfig.json',
  './packages/security/tsconfig.json',
  './packages/testing/tsconfig.json',
  './packages/ui/tsconfig.json',
  './apps/desktop/tsconfig.node.json',
  './apps/desktop/tsconfig.web.json',
  './apps/desktop/tsconfig.test.json'
]

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'process',
  'readline',
  'stream',
  'tls',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      'test-results/**',
      // The preserved Thursday Browser prototype keeps its own tooling.
      'legacy/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: TS_PROJECTS,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-definitions': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'off'
    }
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    // Unit tests run in Node, not in the renderer.
    ignores: ['**/*.test.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The renderer has no Electron access. Use the preload bridge (window.jupiter).'
            },
            { name: '@jupiter/core/node', message: 'Node-only code cannot run in the renderer.' },
            ...NODE_BUILTINS.flatMap((name) => [
              { name, message: 'The renderer has no Node.js access.' },
              { name: `node:${name}`, message: 'The renderer has no Node.js access.' }
            ])
          ]
        }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'The renderer has no Node.js access.' },
        { name: 'process', message: 'The renderer has no Node.js access.' },
        { name: '__dirname', message: 'The renderer has no Node.js access.' }
      ]
    }
  },
  {
    // Provider adapters reach the network only through the guarded transport Core hands them,
    // which enforces Local only mode, refuses redirects and never sends a key unencrypted.
    files: ['packages/providers/src/**/*.ts'],
    ignores: ['packages/providers/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use context.transport.request: it enforces the routing mode.' },
        { name: 'XMLHttpRequest', message: 'Use context.transport.request.' },
        { name: 'WebSocket', message: 'Use context.transport.request.' }
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'http',
            'https',
            'net',
            'tls',
            'node:http',
            'node:https',
            'node:net',
            'node:tls',
            'undici'
          ].map((name) => ({
            name,
            message: 'Adapters reach the network only through context.transport.'
          }))
        }
      ]
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } }
  }
)
