import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuildMetadata } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { collectBuildMetadata } from './build-metadata'

const appDirectory = join(import.meta.dirname, '..')
const version = (
  JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8')) as { version: string }
).version

describe('collectBuildMetadata', () => {
  it('reads the version from package.json and produces schema-valid metadata', () => {
    const metadata = collectBuildMetadata({ appDirectory, command: 'build', env: {} })
    expect(BuildMetadata.parse(metadata)).toEqual(metadata)
    expect(metadata.version).toBe(version)
    expect(metadata.productName).toBe('Jupiter')
  })

  it('derives the channel from the pre-release tag, and uses dev for the dev server', () => {
    expect(collectBuildMetadata({ appDirectory, command: 'build', env: {} }).channel).toBe('alpha')
    expect(collectBuildMetadata({ appDirectory, command: 'serve', env: {} }).channel).toBe('dev')
    expect(
      collectBuildMetadata({
        appDirectory,
        command: 'build',
        env: { JUPITER_BUILD_CHANNEL: 'beta' }
      }).channel
    ).toBe('beta')
  })

  it('rejects an invalid channel override instead of shipping it', () => {
    expect(() =>
      collectBuildMetadata({
        appDirectory,
        command: 'build',
        env: { JUPITER_BUILD_CHANNEL: 'nightly' }
      })
    ).toThrow()
  })

  it('prefers CI identifiers and honours SOURCE_DATE_EPOCH', () => {
    const sha = 'a'.repeat(40)
    const metadata = collectBuildMetadata({
      appDirectory,
      command: 'build',
      env: {
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        SOURCE_DATE_EPOCH: '1790000000'
      }
    })
    expect(metadata.commit).toBe(sha)
    expect(metadata.dirty).toBe(false)
    expect(metadata.buildId).toBe(`ci.123.2.${sha.slice(0, 12)}`)
    expect(metadata.builtAt).toBe(new Date(1_790_000_000_000).toISOString())
  })
})
