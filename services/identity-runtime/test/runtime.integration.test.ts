import { join } from 'node:path'
import { createTempDir, removeDir } from '@jupiter/testing'
import { OWNER_FRAMES, identityFixtureRgb, type IdentityFixture } from '@jupiter/testing/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IdentityRuntime, IdentityRuntimeError } from '../src'
import { bundleIdentityRuntime } from '../src/build'

/**
 * The identity runtime (SET 14), bundled as the app ships it and run as its
 * own process: it finds the face in real photographs and describes it, so
 * that the same person is close and someone else is far — and it refuses
 * pixels that do not fit, without taking anything else down.
 */

let folder: string
let runtime: IdentityRuntime

beforeAll(async () => {
  folder = await createTempDir('jupiter-identity')
  const entry = join(folder, 'identity-runtime.cjs')
  const assets = join(folder, 'identity')
  await bundleIdentityRuntime(entry, assets)
  runtime = new IdentityRuntime({
    launch: {
      command: process.execPath,
      entry,
      memoryLimitMb: 1024,
      env: { JUPITER_IDENTITY_ASSETS: assets }
    },
    callTimeoutMs: 60_000,
    startTimeoutMs: 30_000
  })
}, 120_000)

afterAll(async () => {
  await runtime.stop()
  await removeDir(folder)
})

async function describeFixture(name: IdentityFixture) {
  const { width, height, rgb } = identityFixtureRgb(name)
  return runtime.call('describe', { width, height, rgb: rgb.toString('base64') })
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, value, i) => sum + (value - (b[i] ?? 0)) ** 2, 0))
}

describe('SET 14 — identity runtime (face-api on TensorFlow.js WebAssembly)', () => {
  it('loads the models from the assets folder it was given', async () => {
    const status = await runtime.call('status', {})
    expect(status.backend).toBe('wasm')
    expect(status.engine).toMatch(/^face-api/)
  })

  it('finds one face in each frame, describes it, and tells the owner from someone else', async () => {
    const owner = []
    for (const name of OWNER_FRAMES) {
      const { faces } = await describeFixture(name)
      expect(faces).toHaveLength(1)
      owner.push(faces[0])
    }
    const widths = owner.map((face) => face?.box.width ?? 0)
    // The owner moves closer: the face grows from frame to frame.
    expect(widths.at(-1) ?? 0).toBeGreaterThan((widths[0] ?? 0) * 1.3)
    const first = owner[0]?.descriptor ?? []
    for (const face of owner.slice(1))
      expect(distance(first, face?.descriptor ?? [])).toBeLessThan(0.3)
    const other = (await describeFixture('other')).faces
    expect(other).toHaveLength(1)
    expect(distance(first, other[0]?.descriptor ?? [])).toBeGreaterThan(0.6)
  })

  it('refuses pixels that do not match the size given', async () => {
    const error = await runtime
      .call('describe', { width: 64, height: 64, rgb: Buffer.alloc(10).toString('base64') })
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(IdentityRuntimeError)
    expect(error).toMatchObject({ code: 'INVALID_IMAGE' })
    // The runtime is still there for the next request.
    expect((await describeFixture('owner-1')).faces).toHaveLength(1)
  })
})
