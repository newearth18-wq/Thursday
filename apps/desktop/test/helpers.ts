import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTRACT_VERSION,
  Capabilities,
  GatewayReply,
  GatewayStatus,
  LogEntry,
  ResultEnvelope,
  type CapabilityName,
  type CapabilityOutput,
  type RequestEnvelope
} from '@jupiter/contracts'
import { uuidv7 } from '@jupiter/core'
import type { Page } from 'playwright'

export const appDirectory = join(import.meta.dirname, '..')
export const outDirectory = join(appDirectory, 'out')

export const packageJson = JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8')) as {
  version: string
  productName: string
}

export function assertBuilt(): void {
  for (const file of [
    'main/index.js',
    'main/core.js',
    'preload/index.cjs',
    'renderer/index.html'
  ]) {
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

/** Every structured log line Jupiter wrote for this profile (host and Core share one file). */
export function readLog(userDataDir: string): { text: string; entries: LogEntry[] } {
  const text = readFileSync(join(userDataDir, 'logs', 'jupiter.log'), 'utf8')
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map((line) => LogEntry.parse(JSON.parse(line)))
  return { text, entries }
}

/** A well-formed v1 request envelope; tests override fields to break it on purpose. */
export function envelope(
  type: CapabilityName,
  payload: unknown,
  overrides: Record<string, unknown> = {}
): RequestEnvelope {
  return {
    v: CONTRACT_VERSION,
    requestId: uuidv7(),
    kind: Capabilities[type].kind,
    type,
    payload,
    missionId: null,
    executionId: null,
    sentAt: new Date().toISOString(),
    ...overrides
  }
}

/** Send a request exactly as the interface does — through the preload bridge — and validate the reply. */
export async function invoke(page: Page, request: unknown): Promise<ResultEnvelope> {
  const reply = await page.evaluate(
    (message) => window.jupiter?.request(message),
    request as Record<string, unknown>
  )
  return ResultEnvelope.parse(reply)
}

/** Invoke and return the data of a successful reply, failing with the error envelope otherwise. */
export async function query<C extends CapabilityName>(
  page: Page,
  type: C,
  payload: unknown = {}
): Promise<CapabilityOutput<C>> {
  const result = await invoke(page, envelope(type, payload))
  if (!result.ok) throw new Error(`${type} failed: ${JSON.stringify(result.error)}`)
  return Capabilities[type].output.parse(result.data) as CapabilityOutput<C>
}

export async function gatewayStatus(page: Page): Promise<GatewayStatus> {
  const reply = GatewayReply.parse(await page.evaluate(() => window.jupiter?.gatewayStatus()))
  if (!reply.ok) throw new Error(`gatewayStatus failed: ${JSON.stringify(reply.error)}`)
  return GatewayStatus.parse(reply.data)
}

/** Poll the gateway until `predicate` holds, failing with the last status seen. */
export async function waitForGateway(
  page: Page,
  predicate: (status: GatewayStatus) => boolean,
  timeoutMs = 30_000
): Promise<GatewayStatus> {
  const deadline = Date.now() + timeoutMs
  let last: GatewayStatus | null = null
  while (Date.now() < deadline) {
    last = await gatewayStatus(page)
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Gateway status never matched: ${JSON.stringify(last)}`)
}

export function serviceStatus(status: GatewayStatus, serviceId: string): string | undefined {
  return status.runtime.services.find((service) => service.serviceId === serviceId)?.status
}
