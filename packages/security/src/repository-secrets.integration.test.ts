import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCredentialAssignment, fakeCredentials } from '@jupiter/testing/fake-credentials'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const script = join(repoRoot, 'scripts', 'check-secrets.mjs')
const temp: string[] = []

afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true })
})

function scan(root: string, ...extra: string[]) {
  return spawnSync(process.execPath, [script, root, ...extra], { encoding: 'utf8' })
}

describe('repository secret scan', () => {
  it('finds no hardcoded credentials in the repository or its build output', () => {
    const result = scan(repoRoot, '--include-build')
    expect(result.stderr).not.toMatch(/finding/)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/no credentials found in \d+ file/)
  })

  it('fails, without printing the secret, when a credential is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jupiter-scan-'))
    temp.push(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const secret = fakeCredentials()[0]?.value ?? ''
    writeFileSync(
      join(dir, 'config.ts'),
      `export const key = '${secret}'\nexport const cfg = { ${fakeCredentialAssignment()} }\n`
    )
    writeFileSync(join(dir, '.env'), 'NOTHING=here\n')
    const result = scan(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('config.ts:1')
    expect(result.stderr).toContain('credential-assignment')
    expect(result.stderr).toContain('env-file')
    expect(result.stderr).not.toContain(secret)
  })
})
