import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BuildMetadata } from '@jupiter/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { assertBuilt, outDirectory, packageJson } from './helpers'

/** Static checks on the production build that runtime tests cannot see directly. */

function rendererScripts(): string {
  const assets = join(outDirectory, 'renderer', 'assets')
  return readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(assets, file), 'utf8'))
    .join('\n')
}

beforeAll(() => {
  assertBuilt()
})

describe('production build output', () => {
  it('ships a strict Content Security Policy with no inline or evaluated script', () => {
    const html = readFileSync(join(outDirectory, 'renderer', 'index.html'), 'utf8')
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/)
  })

  it('does not hardcode the app version in the interface bundle', () => {
    expect(rendererScripts()).not.toContain(packageJson.version)
  })

  it('keeps Node.js and Electron out of the interface bundle', () => {
    const scripts = rendererScripts()
    for (const forbidden of [
      'ipcRenderer',
      'require("electron")',
      'require("fs")',
      'require("child_process")',
      'node:fs',
      'nodeIntegration'
    ]) {
      expect(scripts, forbidden).not.toContain(forbidden)
    }
  })

  it('injects schema-valid build metadata into the main process only', () => {
    const main = readFileSync(join(outDirectory, 'main', 'index.js'), 'utf8')
    // Vite emits the define as an object literal: quote its keys to read it as JSON.
    const literal = /define_JUPITER_BUILD_METADATA_default = (\{[^;]*\});/.exec(main)?.[1]
    expect(literal).toBeDefined()
    const metadata = BuildMetadata.parse(
      JSON.parse((literal ?? '').replace(/([{,]\s*)(\w+):/g, '$1"$2":'))
    )
    expect(metadata.version).toBe(packageJson.version)
    expect(rendererScripts()).not.toContain(metadata.buildId)
  })

  it('bundles Jupiter Core as its own entry that never touches Electron windows or IPC', () => {
    const core = readFileSync(join(outDirectory, 'main', 'core.js'), 'utf8')
    const chunksDirectory = join(outDirectory, 'main', 'chunks')
    const shared = readdirSync(chunksDirectory).map((file) =>
      readFileSync(join(chunksDirectory, file), 'utf8')
    )
    const imports = (source: string) =>
      [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] ?? '')
    const external = [core, ...shared]
      .flatMap(imports)
      .filter((specifier) => !specifier.startsWith('./'))
    expect(new Set(external)).toEqual(
      new Set(['node:crypto', 'node:fs', 'node:path', 'node:sqlite'])
    )
    expect(core).toContain('parentPort')
    for (const forbidden of ['BrowserWindow', 'ipcMain', 'webContents', 'shell.openPath']) {
      expect(core, forbidden).not.toContain(forbidden)
    }
  })

  it('builds a sandbox-compatible preload that only requires electron', () => {
    const preload = readFileSync(join(outDirectory, 'preload', 'index.cjs'), 'utf8')
    const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
    expect(new Set(requires)).toEqual(new Set(['electron']))
    expect(preload).toContain('exposeInMainWorld')
  })
})
