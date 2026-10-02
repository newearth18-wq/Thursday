import { describe, expect, it } from 'vitest'
import {
  compareSemVer,
  manifestRuleIssues,
  PluginManifest,
  PluginRelativePath,
  type PluginManifest as Manifest
} from './plugins'

const skill = {
  id: 'save_note',
  name: 'Save note',
  description: 'Saves a note.',
  handler: 'saveNote',
  category: 'text',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  permissions: ['plugin.storage.write'],
  timeoutMs: 5_000,
  healthInput: null
} as const

const manifest = {
  manifestVersion: 1,
  id: 'demo-tools',
  name: 'Demo tools',
  version: '1.0.0',
  description: 'A demo.',
  entrypoint: 'index.js',
  minimumJupiterVersion: '0.1.0-alpha.0',
  publisher: { name: 'Someone', url: null },
  permissions: ['plugin.storage.write'],
  capabilities: ['storage.write'],
  skills: [skill],
  integrity: { algorithm: 'sha256', files: { 'index.js': 'a'.repeat(64) } }
} as const

describe('plugin manifests (SET 15)', () => {
  it('accepts a valid manifest that keeps to its own rules', () => {
    const parsed = PluginManifest.parse(manifest)
    expect(manifestRuleIssues(parsed)).toEqual([])
  })

  it('refuses bad ids, versions, entrypoints and unknown fields', () => {
    for (const change of [
      { id: 'Demo_Tools' },
      { id: 'x' },
      { version: '1.0' },
      { entrypoint: '../index.js' },
      { entrypoint: 'index.ts' },
      { entrypoint: '/abs/index.js' },
      { surprise: true }
    ])
      expect(
        PluginManifest.safeParse({ ...manifest, ...change }).success,
        JSON.stringify(change)
      ).toBe(false)
  })

  it('refuses permissions plugins cannot have, and Skills reaching beyond the plugin', () => {
    const issues = (change: Partial<Manifest>) =>
      manifestRuleIssues(PluginManifest.parse({ ...manifest, ...change }))
    expect(issues({ permissions: ['plugin.storage.write', 'shell.execute'] })).toContain(
      'permissions: "shell.execute" is not available to plugins'
    )
    expect(issues({ capabilities: [] })).toContain(
      'permissions: "plugin.storage.write" is declared but no capability uses it'
    )
    expect(issues({ capabilities: ['storage.write', 'app.version'] })).toContain(
      'capabilities: "app.version" needs the permission app.version.read, which is not declared'
    )
    expect(issues({ skills: [{ ...skill, permissions: ['app.version.read'] }] })).toContain(
      'skills.save_note: "app.version.read" is not among the plugin\'s declared permissions'
    )
    expect(issues({ integrity: { algorithm: 'sha256', files: {} } })).toContain(
      'integrity: the entrypoint "index.js" has no SHA-256'
    )
  })

  it('accepts only plain relative paths', () => {
    for (const ok of ['index.js', 'notes/today.md', 'a-b_c.d/e'])
      expect(PluginRelativePath.safeParse(ok).success, ok).toBe(true)
    for (const bad of [
      '',
      '/etc/passwd',
      '../x',
      'a/../b',
      './x',
      'a//b',
      'C:\\x',
      '.hidden',
      'a\\b',
      'notes/'
    ])
      expect(PluginRelativePath.safeParse(bad).success, bad).toBe(false)
  })

  it('orders versions as Semantic Versioning does', () => {
    const ordered = [
      '0.1.0-alpha.0',
      '0.1.0-alpha.1',
      '0.1.0-beta',
      '0.1.0',
      '0.2.0',
      '1.0.0',
      '1.10.0'
    ]
    for (let i = 1; i < ordered.length; i++) {
      expect(compareSemVer(ordered[i - 1] ?? '', ordered[i] ?? '')).toBeLessThan(0)
      expect(compareSemVer(ordered[i] ?? '', ordered[i - 1] ?? '')).toBeGreaterThan(0)
    }
    expect(compareSemVer('1.2.3', '1.2.3')).toBe(0)
  })
})
