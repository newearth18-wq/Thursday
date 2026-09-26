import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanDraft, PlanStep } from '@jupiter/contracts'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import type { Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appDirectory, assertBuilt, query, waitForGateway } from './helpers'

/**
 * SET 5 acceptance tests against the real application: the Planner and
 * Workflow Engine in Jupiter Core's utility process with SQLite, the
 * interface a person uses, and a real HTTP server speaking the
 * OpenAI-compatible protocol as the model — which answers the planning
 * request with a plan (JSON) and each model step with text, as scripted per
 * test. Screenshots are written to test-results/set-05/ as evidence.
 */

const EVIDENCE = join(appDirectory, '..', '..', 'test-results', 'set-05')

let userDataDir: string
let jupiter: LaunchedJupiter
let page: Page
let model: ProtocolServer

beforeAll(async () => {
  assertBuilt()
  mkdirSync(EVIDENCE, { recursive: true })
  model = await startOpenAiCompatibleServer()
  model.setModels([{ id: 'planner-model', name: 'Planner Model' }])
  userDataDir = await createTempDir('jupiter-set05')
  jupiter = await launch()
  page = jupiter.window
  const provider = await query(page, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: 'Local server',
    baseUrl: model.baseUrl
  })
  await query(page, 'ai.providers.check', { providerId: provider.providerId })
  await query(page, 'ai.models.update', {
    providerId: provider.providerId,
    modelId: 'planner-model',
    enabled: true,
    capabilities: ['chat']
  })
})

afterAll(async () => {
  await jupiter.close()
  await model.close()
  await removeDir(userDataDir)
})

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return
  const name = task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
  await page.screenshot({ path: join(EVIDENCE, `failed-${name}.png`) }).catch(() => undefined)
})

async function launch(): Promise<LaunchedJupiter> {
  const launched = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 1100)
  })
  await waitForGateway(
    launched.window,
    (status) => status.core.state === 'running' && status.runtime.overall !== 'STARTING'
  )
  return launched
}

/** A window screenshot with `section` scrolled into view (element shots clip inside scroll areas). */
async function evidence(name: string, section?: Locator): Promise<void> {
  if (section)
    await section.evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

async function open(view: string): Promise<void> {
  await page.getByTestId(`nav-${view}`).click()
  await page.getByTestId(`view-${view}`).waitFor()
}

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    description: `Does ${id}.`,
    skillId: 'model.generate',
    dependencies: [],
    input: { prompt: `Do ${id}` },
    condition: null,
    timeoutMs: 60_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, multiplier: 1 },
    verification: null,
    required: true,
    ...overrides
  }
}

function plan(steps: PlanStep[], overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    goal: 'Get it done',
    assumptions: ['The answer can be in English'],
    rationale: 'Small steps, each checked.',
    steps,
    requiredSkills: [...new Set(steps.map((item) => item.skillId))],
    requiredPermissions: [],
    expectedArtifacts: [],
    verificationPlan: {
      checks: [{ step: steps.at(-1)?.id ?? 'a', check: 'non-empty', description: 'Output present' }]
    },
    ...overrides
  }
}

const planned = (draft: PlanDraft | Record<string, unknown>) => ({
  chunks: [JSON.stringify(draft)]
})

/** Start a Mission through the New Mission dialog with the planner (the default). */
async function createMission(requestText: string): Promise<string> {
  await open('missions')
  await page.getByTestId('mission-new').click()
  const dialog = page.getByTestId('mission-new-dialog')
  await dialog.getByTestId('mission-new-request').fill(requestText)
  expect(await dialog.getByTestId('mission-planner-model').isChecked()).toBe(true)
  const create = dialog.getByTestId('mission-new-create')
  await expect.poll(() => create.isEnabled()).toBe(true)
  await create.click()
  await expect.poll(() => dialog.isVisible()).toBe(false)
  await detail().waitFor()
  return (await detail().getAttribute('data-mission-id')) ?? ''
}

function detail(): Locator {
  return page.getByTestId('mission-detail')
}

async function statusOf(): Promise<string | null> {
  return detail().getAttribute('data-status')
}

function nodes(): Promise<[string | null, string | null][]> {
  return detail()
    .getByTestId('mission-step')
    .evaluateAll((items) =>
      items.map((item) => [item.getAttribute('data-key'), item.getAttribute('data-status')])
    )
}

function stageSizes(): Promise<number[]> {
  return detail()
    .getByTestId('workflow-stage')
    .evaluateAll((stages) =>
      stages.map((stage) => stage.querySelectorAll('[data-testid="mission-step"]').length)
    )
}

function posts() {
  return model.requests.filter((request) => request.method === 'POST')
}

const PARALLEL = plan(
  [
    step('left', { title: 'Research the left side' }),
    step('right', { title: 'Research the right side' }),
    step('join', {
      title: 'Combine both',
      skillId: 'text.compose',
      dependencies: ['left', 'right'],
      input: { template: '{{left}} + {{right}}' }
    })
  ],
  {
    goal: 'Compare both sides',
    assumptions: ['Both sides are public', 'A short answer is enough'],
    rationale: 'The two sides are independent, so they are researched at the same time.',
    expectedArtifacts: [{ step: 'join', description: 'The comparison' }]
  }
)

describe('SET 5 — Planner and Workflow Engine, in the real application', () => {
  it('AT1 + AT3 + AT4: the planner’s plan is shown, and independent steps run in parallel', async () => {
    model.reset()
    model.enqueue(
      planned(PARALLEL),
      { chunks: ['Left facts'], gated: true },
      { chunks: ['Right facts'], gated: true }
    )
    await createMission('Compare the left and the right side')
    // Both model steps are running at once, in the same stage.
    await expect.poll(() => posts().length).toBe(3)
    await expect.poll(nodes).toEqual([
      ['left', 'RUNNING'],
      ['right', 'RUNNING'],
      ['join', 'PENDING']
    ])
    expect(await stageSizes()).toEqual([2, 1])
    expect(await detail().getByTestId('workflow-stage').first().textContent()).toContain(
      'These steps run in parallel'
    )
    const planPanel = detail().getByTestId('mission-plan')
    expect(await planPanel.getByTestId('plan-source').textContent()).toBe(
      'Planned by the chat model'
    )
    expect(await planPanel.getByTestId('plan-revision').textContent()).toBe('Revision 1')
    expect(await planPanel.getByTestId('plan-goal').textContent()).toBe('Compare both sides')
    expect(await planPanel.getByTestId('plan-assumptions').locator('li').allTextContents()).toEqual(
      ['Both sides are public', 'A short answer is enough']
    )
    expect(await planPanel.getByTestId('plan-rationale').textContent()).toContain('independent')
    await evidence('01-parallel-steps-running', detail().getByTestId('mission-plan'))

    model.advance()
    model.advance()
    await expect.poll(statusOf).toBe('COMPLETED')
    // AT3: the join ran after both, with both outputs.
    expect(await nodes()).toEqual([
      ['left', 'COMPLETED'],
      ['right', 'COMPLETED'],
      ['join', 'COMPLETED']
    ])
    // Which parallel request got which scripted reply depends on arrival order.
    expect(await detail().getByTestId('mission-artifact').last().textContent()).toMatch(
      /(Left facts \+ Right facts|Right facts \+ Left facts)/
    )
    await evidence('02-workflow-completed', detail().getByTestId('mission-workflow'))
  })

  it('AT2 + AT10: invalid, cyclic and permission-needing plans are rejected with reasons; nothing runs', async () => {
    model.reset()
    model.enqueue({ chunks: ['Sure! Let me think step by step first…'] })
    await createMission('Plan with prose')
    await expect.poll(statusOf).toBe('FAILED')
    const rejected = detail().getByTestId('plan-rejected')
    expect(await rejected.locator('li').getAttribute('data-code')).toBe('not-json')
    expect(await detail().getByTestId('mission-step').count()).toBe(0)
    await evidence('03-plan-rejected-not-json', detail().getByTestId('mission-plan'))

    model.enqueue(
      planned(plan([step('a', { dependencies: ['b'] }), step('b', { dependencies: ['a'] })]))
    )
    await createMission('Plan with a cycle')
    await expect.poll(statusOf).toBe('FAILED')
    expect(
      await detail().getByTestId('plan-rejected').locator('li').first().getAttribute('data-code')
    ).toBe('cycle')
    await evidence('04-plan-rejected-cycle', detail().getByTestId('mission-plan'))

    model.enqueue(planned(plan([step('a')], { requiredPermissions: ['files.write'] })))
    await createMission('Plan that needs a permission')
    await expect.poll(statusOf).toBe('FAILED')
    expect(
      await detail().getByTestId('plan-rejected').locator('li').first().getAttribute('data-code')
    ).toBe('permission-unavailable')
    // Three planning requests; no step of any of these plans ran.
    expect(posts()).toHaveLength(3)
  })

  it('waits at an approval checkpoint until the person approves', async () => {
    model.reset()
    model.enqueue(
      planned(
        plan(
          [
            step('draft', { title: 'Draft the message' }),
            step('confirm', {
              title: 'Confirm before sending',
              skillId: 'checkpoint.approval',
              dependencies: ['draft'],
              input: { question: 'Send this message?' }
            }),
            step('send', {
              title: 'Prepare the final text',
              skillId: 'text.compose',
              dependencies: ['confirm', 'draft'],
              input: { template: 'Final: {{draft}}' }
            })
          ],
          {
            verificationPlan: {
              checks: [{ step: 'send', check: 'non-empty', description: 'Ready' }]
            }
          }
        )
      ),
      { chunks: ['Hello team'] }
    )
    await createMission('Draft a message and ask me first')
    await expect.poll(statusOf).toBe('WAITING_APPROVAL')
    const approval = detail().getByTestId('mission-approval')
    expect(await approval.getByTestId('mission-approval-question').textContent()).toBe(
      'Confirm before sending: Send this message?'
    )
    expect(await nodes()).toEqual([
      ['draft', 'COMPLETED'],
      ['confirm', 'WAITING'],
      ['send', 'PENDING']
    ])
    await evidence('05-waiting-for-approval', approval)
    await approval.getByTestId('mission-approve').click()
    await expect.poll(statusOf).toBe('COMPLETED')
    expect(await detail().getByTestId('mission-artifact').last().textContent()).toContain(
      'Final: Hello team'
    )
  })

  it('AT7: retries with growing waits and keeps exactly one output', async () => {
    model.reset()
    model.enqueue(
      planned(
        plan([
          step('fetch', {
            title: 'Fetch the figures',
            retryPolicy: { maxAttempts: 3, backoffMs: 200, multiplier: 2 }
          })
        ])
      ),
      { status: 503, errorMessage: 'busy' },
      { status: 503, errorMessage: 'busy' },
      { chunks: ['Figures: 1, 2, 3'] }
    )
    const missionId = await createMission('Fetch the figures, retrying if busy')
    await expect.poll(statusOf).toBe('COMPLETED')
    const node = detail().locator('[data-testid="mission-step"][data-key="fetch"]')
    expect(await node.getByTestId('step-attempts').textContent()).toBe('Attempt 3 of 3')
    expect(
      await node
        .getByTestId('step-attempt-list')
        .locator('[data-outcome]')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-outcome')))
    ).toEqual(['failed', 'failed', 'completed'])
    const stored = await query(page, 'missions.get', { missionId })
    expect(stored.artifacts.map((item) => item.text)).toEqual(['Figures: 1, 2, 3'])
    await evidence('06-retried-step', detail().getByTestId('mission-workflow'))
  })

  it('AT6: a step past its time limit is stopped', async () => {
    model.reset()
    model.enqueue(planned(plan([step('slow', { title: 'A slow step', timeoutMs: 5_000 })])), {
      chunks: ['Starting…', 'never'],
      stallAfter: 1
    })
    await createMission('Something that hangs')
    await expect.poll(statusOf, { timeout: 20_000 }).toBe('FAILED')
    const node = detail().locator('[data-testid="mission-step"][data-key="slow"]')
    expect(await node.textContent()).toContain('STEP_TIMEOUT')
    expect(await node.getByTestId('step-attempt-list').textContent()).toContain('timed out')
    await expect.poll(() => posts()[1]?.abortedAt ?? null).not.toBeNull()
  }, 40_000)

  it('AT5: Cancel stops every running step', async () => {
    model.reset()
    model.enqueue(
      planned(PARALLEL),
      { chunks: ['never', 'done'], gated: true },
      { chunks: ['never', 'done'], gated: true }
    )
    await createMission('Cancel two steps at once')
    await expect.poll(() => posts().length).toBe(3)
    await detail().getByTestId('mission-cancel').click()
    await page.getByTestId('mission-cancel-dialog').getByTestId('confirm-ok').click()
    await expect.poll(statusOf).toBe('CANCELLED')
    expect(await nodes()).toEqual([
      ['left', 'CANCELLED'],
      ['right', 'CANCELLED'],
      ['join', 'SKIPPED']
    ])
    await expect
      .poll(() =>
        posts()
          .slice(1)
          .map((request) => request.abortedAt !== null)
      )
      .toEqual([true, true])
  })

  it('AT8: after a failure, “Correct and re-plan” makes a new revision; the old one is kept', async () => {
    model.reset()
    model.enqueue(planned(plan([step('lookup', { title: 'Look it up online' })])), {
      status: 503,
      errorMessage: 'unavailable'
    })
    const missionId = await createMission('Find the answer')
    await expect.poll(statusOf).toBe('FAILED')

    model.enqueue(
      planned(
        plan([step('answer', { title: 'Answer from what is known' })], {
          assumptions: ['No lookup is needed']
        })
      ),
      { chunks: ['Forty-two.'] }
    )
    await detail().getByTestId('plan-replan').click()
    const dialog = page.getByTestId('mission-replan-dialog')
    await dialog.getByTestId('mission-replan-feedback').fill('Do not look anything up.')
    await evidence('07-replan-dialog')
    await dialog.getByTestId('mission-replan-submit').click()
    await expect.poll(() => dialog.isVisible()).toBe(false)
    await expect.poll(statusOf).toBe('COMPLETED')

    expect(await detail().getByTestId('plan-revision').textContent()).toBe('Revision 2')
    expect(await detail().getByTestId('workflow-replanned').textContent()).toBe('Re-planned')
    expect(await detail().getByTestId('plan-revisions').locator('li').count()).toBe(2)
    expect(await detail().getByTestId('execution-plan-revision').allTextContents()).toEqual([
      '2',
      '1'
    ])
    expect(posts()[2]?.body).toBeDefined()
    expect(JSON.stringify(posts()[2]?.body)).toContain('Do not look anything up.')
    const stored = await query(page, 'missions.get', { missionId })
    expect(stored.planRevisions.map((item) => item.revision)).toEqual([1, 2])
    expect(stored.executionHistory.map((item) => item.status)).toEqual(['FAILED', 'COMPLETED'])
    await detail().getByTestId('plan-revisions').locator('summary').click()
    await evidence('08-replanned', detail().getByTestId('mission-plan'))
  })

  it('AT9: workflow state survives a refresh and an app restart', async () => {
    model.reset()
    // "right" runs after "left" here, so which request gets which reply is certain.
    const sequential = plan([
      step('left', { title: 'Research the left side' }),
      step('right', { title: 'Research the right side', dependencies: ['left'] }),
      step('join', {
        title: 'Combine both',
        skillId: 'text.compose',
        dependencies: ['left', 'right'],
        input: { template: '{{left}} + {{right}}' }
      })
    ])
    model.enqueue(
      planned(sequential),
      { chunks: ['Left facts'] },
      { chunks: ['cut', 'off'], gated: true }
    )
    const missionId = await createMission('Survive a restart')
    await expect.poll(nodes).toEqual([
      ['left', 'COMPLETED'],
      ['right', 'RUNNING'],
      ['join', 'PENDING']
    ])

    // Refresh: the interface reads the same state back from Core.
    await page.reload()
    await detail().waitFor()
    expect(await detail().getAttribute('data-mission-id')).toBe(missionId)
    await expect.poll(nodes).toEqual([
      ['left', 'COMPLETED'],
      ['right', 'RUNNING'],
      ['join', 'PENDING']
    ])

    // Restart: the cut-off step runs again, the finished one does not.
    await jupiter.close()
    model.enqueue({ chunks: ['Right facts'] })
    jupiter = await launch()
    page = jupiter.window
    await open('missions')
    await page.locator(`[data-testid="mission-item"][data-mission-id="${missionId}"]`).click()
    await expect.poll(statusOf).toBe('COMPLETED')
    const right = detail().locator('[data-testid="mission-step"][data-key="right"]')
    expect(
      await right
        .getByTestId('step-attempt-list')
        .locator('[data-outcome]')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-outcome')))
    ).toEqual(['interrupted', 'completed'])
    // The interrupted attempt does not use up the retry budget.
    expect(await right.getByTestId('step-attempts').textContent()).toBe('Attempt 1 of 1')
    expect(await detail().getByTestId('mission-artifact').last().textContent()).toContain(
      'Left facts + Right facts'
    )
    // Planner, left, right (cut off), right again: the finished step was not repeated.
    expect(posts()).toHaveLength(4)
    await expect
      .poll(() => detail().getByTestId('mission-timeline').textContent())
      .toContain('Jupiter restarted and continued the workflow')
    await evidence('09-after-restart', detail().getByTestId('mission-workflow'))
  })
})
