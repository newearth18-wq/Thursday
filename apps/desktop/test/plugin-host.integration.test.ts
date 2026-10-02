import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, removeDir } from '@jupiter/testing'
import { demoToolsCopy } from '@jupiter/testing/plugins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLUGIN_LIMITS, PluginHost, readPackage } from '../src/main/plugin-host'

/** SET 15: the host's side of plugins on real folders — reading, copying and storage limits. */

const logger = Logger.create({ sessionId: uuidv7(), level: 'warn', sinks: [new MemorySink()] })
let root: string
let chosen: string | null
let host: PluginHost

beforeEach(async () => {
  root = await createTempDir('jupiter-plugin-host')
  chosen = null
  host = new PluginHost({
    logger,
    bundledDirectory: join(root, 'bundled'),
    installedDirectory: join(root, 'installed'),
    stagingDirectory: join(root, 'staging'),
    dataDirectory: join(root, 'data'),
    chooseFolder: () => Promise.resolve(chosen)
  })
})

afterEach(async () => {
  await removeDir(root)
})

describe('plugin host', () => {
  it('lists and hashes the files itself, and reports links and odd names', async () => {
    const folder = demoToolsCopy(join(root, 'source'))
    // A file link elsewhere; on Windows a junction (a file link needs a privilege there).
    if (process.platform === 'win32') {
      mkdirSync(join(root, 'linked-target'))
      symlinkSync(join(root, 'linked-target'), join(folder, 'linked.js'), 'junction')
    } else symlinkSync(join(root, 'source', 'index.js'), join(folder, 'linked.js'))
    writeFileSync(join(folder, 'bad name!.js'), 'x')
    const pack = await readPackage(folder, 'local', 'source')
    expect(Object.keys(pack.files).sort()).toEqual(['README.md', 'index.js'])
    expect(pack.files['index.js']).toMatch(/^[0-9a-f]{64}$/)
    expect(pack.problems).toEqual([
      '"bad name!.js" is not an allowed file name',
      '"linked.js" is a link; plugins may not contain links'
    ])
  })

  it('copies a chosen folder into staging, files only, and commits it in place', async () => {
    chosen = demoToolsCopy(join(root, 'source'))
    expect(await host.choose('install')).toMatchObject({ chosen: true })
    const staged = readdirSync(join(root, 'staging'))
    expect(staged).toHaveLength(1)
    await host.commit(staged[0] ?? '', 'demo-tools')
    expect(readdirSync(join(root, 'installed', 'demo-tools')).sort()).toEqual([
      'README.md',
      'index.js',
      'manifest.json'
    ])
    expect(readdirSync(join(root, 'staging'))).toEqual([])
    chosen = null
    expect(await host.choose('install')).toEqual({ chosen: false })
    expect(await host.remove('demo-tools')).toBe(true)
    expect(readdirSync(join(root, 'installed'))).toEqual([])
  })

  it('keeps storage inside the plugin’s folder, within its quota, never replacing a file', async () => {
    const write = (path: string, text: string) =>
      host.storage({ op: 'write', pluginId: 'demo-tools', path, text })
    expect(await write('notes/a.md', 'one')).toEqual({ op: 'write', path: 'notes/a.md', bytes: 3 })
    expect(await write('notes/a.md', 'two')).toEqual({
      op: 'write',
      path: 'notes/a (2).md',
      bytes: 3
    })
    expect(await host.storage({ op: 'read', pluginId: 'demo-tools', path: 'notes/a.md' })).toEqual({
      op: 'read',
      text: 'one'
    })
    await expect(write('../escape.md', 'x')).rejects.toMatchObject({ code: 'PLUGIN_PATH_INVALID' })
    await expect(write('/etc/x', 'x')).rejects.toMatchObject({ code: 'PLUGIN_PATH_INVALID' })
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(
      join(root, 'elsewhere'),
      join(root, 'data', 'demo-tools', 'out'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(write('out/x.md', 'x')).rejects.toMatchObject({ code: 'PLUGIN_PATH_INVALID' })
    expect(readdirSync(join(root, 'elsewhere'))).toEqual([])
    await expect(
      write('big.md', 'x'.repeat(PLUGIN_LIMITS.storageFileBytes + 1))
    ).rejects.toMatchObject({
      code: 'PLUGIN_STORAGE_FULL'
    })
    for (let i = 0; i < 4; i++)
      await write(`fill-${String(i)}.md`, 'x'.repeat(PLUGIN_LIMITS.storageFileBytes))
    await expect(
      write('fill-5.md', 'x'.repeat(PLUGIN_LIMITS.storageFileBytes))
    ).rejects.toMatchObject({
      code: 'PLUGIN_STORAGE_FULL'
    })
    expect(await host.storage({ op: 'usage', pluginId: 'demo-tools' })).toMatchObject({
      files: 6,
      quotaBytes: PLUGIN_LIMITS.storageBytes
    })
    // Another plugin's storage is a different folder.
    expect(await host.storage({ op: 'list', pluginId: 'other-plugin' })).toEqual({
      op: 'list',
      files: []
    })
  })
})
