import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'

export const appDirectory = join(import.meta.dirname, '..')
export const outDirectory = join(appDirectory, 'out')

export const packageJson = JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8')) as {
  version: string
  productName: string
}

export function assertBuilt(): void {
  for (const file of ['main/index.js', 'preload/index.cjs', 'renderer/index.html']) {
    if (!existsSync(join(outDirectory, file))) {
      throw new Error(
        `apps/desktop/out/${file} is missing. Run "npm run build" before the integration tests.`
      )
    }
  }
}

export function headCommit(): string {
  const sha = process.env.GITHUB_SHA
  if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appDirectory, encoding: 'utf8' }).trim()
}

/** Wait until the runtime has finished starting and return its overall status. */
export async function settledOverallStatus(window: Page): Promise<string> {
  const overall = window.getByTestId('overall-status')
  await overall.waitFor()
  await window.waitForFunction(
    () =>
      document.querySelector('[data-testid="overall-status"]')?.getAttribute('data-status') !==
      'STARTING'
  )
  return (await overall.getAttribute('data-status')) ?? ''
}
