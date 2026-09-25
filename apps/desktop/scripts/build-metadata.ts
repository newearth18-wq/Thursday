import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Imported by relative path on purpose: electron-vite bundles this config with
// esbuild and loads bare package imports at runtime with plain Node, which
// cannot execute the TypeScript sources of workspace packages. Relative
// imports are bundled, so the shared schema is still the single source of truth.
import {
  BUILD_METADATA_SCHEMA_VERSION,
  BuildChannel,
  BuildMetadata
} from '../../../packages/contracts/src/build-metadata'

/**
 * Collect build metadata at build time. The result is validated against the
 * shared schema and injected into the main process bundle; the renderer only
 * ever receives it through IPC, so no version string is hardcoded in the UI.
 *
 * Inputs, in priority order:
 *   version   — apps/desktop/package.json
 *   channel   — JUPITER_BUILD_CHANNEL, else `dev` for the dev server, else the
 *               version's pre-release tag (alpha/beta), else `stable`
 *   commit    — GITHUB_SHA, else `git rev-parse HEAD`, else `unknown`
 *   builtAt   — SOURCE_DATE_EPOCH (reproducible builds), else now
 *   buildId   — derived from CI run identifiers when present
 */

interface CollectOptions {
  readonly appDirectory: string
  readonly command: 'build' | 'serve'
  readonly env: NodeJS.ProcessEnv
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

function resolveChannel(
  version: string,
  command: 'build' | 'serve',
  requested: string | undefined
): BuildChannel {
  if (requested) return BuildChannel.parse(requested)
  if (command === 'serve') return 'dev'
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1]
  if (prerelease === 'alpha' || prerelease === 'beta') return prerelease
  if (prerelease) return 'dev'
  return 'stable'
}

export function collectBuildMetadata(options: CollectOptions): BuildMetadata {
  const pkg = JSON.parse(readFileSync(join(options.appDirectory, 'package.json'), 'utf8')) as {
    productName?: string
    version?: string
  }
  const version = pkg.version ?? ''
  const envCommit = options.env.GITHUB_SHA?.toLowerCase()
  const gitCommit = git(['rev-parse', 'HEAD'], options.appDirectory)
  const commit =
    envCommit && /^[0-9a-f]{40}$/.test(envCommit) ? envCommit : (gitCommit ?? 'unknown')
  const status = envCommit
    ? ''
    : git(['status', '--porcelain', '--untracked-files=no'], options.appDirectory)
  const dirty = status === null ? false : status.length > 0

  const epoch = options.env.SOURCE_DATE_EPOCH
  const builtAt = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date()

  const runId = options.env.GITHUB_RUN_ID
  const runAttempt = options.env.GITHUB_RUN_ATTEMPT ?? '1'
  const stamp = builtAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const shortCommit = commit === 'unknown' ? 'nogit' : commit.slice(0, 12)
  const buildId = runId
    ? `ci.${runId}.${runAttempt}.${shortCommit}`
    : `local.${stamp}.${shortCommit}${dirty ? '.dirty' : ''}`

  return BuildMetadata.parse({
    schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
    productName: pkg.productName ?? 'Jupiter',
    version,
    channel: resolveChannel(version, options.command, options.env.JUPITER_BUILD_CHANNEL),
    commit,
    dirty,
    buildId,
    builtAt: builtAt.toISOString()
  })
}
