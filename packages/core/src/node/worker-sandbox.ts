import { Worker } from 'node:worker_threads'
import type { SandboxOutcome, SandboxRequest, SkillSandbox } from '../skills/sandbox'

/**
 * Runs each Skill invocation in its own worker thread (SET 6).
 *
 * - The thread has no environment variables, a memory limit, and no stdio
 *   of its own.
 * - Inside it, the Skill's code runs in a separate `vm` context: no
 *   `require`, `process`, timers or file access.
 * - Everything crossing into or out of that context is copied as JSON, so
 *   the Skill never holds a reference to an outside object.
 * - Timeout or cancel terminates the thread, which stops the Skill's code
 *   even in a busy loop.
 *
 * This isolates faults and stops work. It is not a hardened boundary for
 * untrusted code: plugins get their own isolated runtime (SET 15).
 */

const BOOTSTRAP = String.raw`
'use strict';
// Loaded via module.require: a literal call would make the Core bundler add a createRequire shim.
const load = module.require.bind(module);
const { parentPort, workerData } = load('node:worker_threads');
const vm = load('node:vm');
const pending = new Map();
let nextId = 0;
parentPort.on('message', (message) => {
  if (!message || message.type !== 'resource-reply') return;
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.ok) waiting.resolve(message.json);
  else waiting.reject({ code: String(message.code), message: String(message.message) });
});
function bridge(resource, argsJson) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'resource', id, resource: String(resource), argsJson: argsJson });
  });
}
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const makeContext = vm.runInContext(
  '(function (bridge) {' +
  '  function fail(code, message) { var error = new Error(message); error.code = code; return error; }' +
  '  return Object.freeze({' +
  '    use: function (resource, args) {' +
  '      var argsJson = args === undefined ? "null" : JSON.stringify(args);' +
  '      return new Promise(function (resolve, reject) {' +
  '        bridge(String(resource), argsJson).then(' +
  '          function (json) { resolve(JSON.parse(json)); },' +
  '          function (error) { reject(fail(String(error.code), String(error.message))); });' +
  '      });' +
  '    }' +
  '  });' +
  '})',
  context
);
function finish(message) { parentPort.postMessage(Object.assign({ type: 'result' }, message)); }
(async () => {
  try {
    const run = vm.runInContext('(' + workerData.source + ')', context, { filename: 'skill.js' });
    if (typeof run !== 'function') throw Object.assign(new Error('The Skill code is not a function.'), { code: 'SKILL_NOT_A_FUNCTION' });
    const input = vm.runInContext('JSON.parse', context)(workerData.inputJson);
    const output = await run(input, makeContext(bridge));
    let json;
    try { json = JSON.stringify(output === undefined ? null : output); }
    catch (error) { return finish({ ok: false, code: 'SKILL_OUTPUT_NOT_SERIALIZABLE', message: 'The output cannot be represented as JSON.' }); }
    finish({ ok: true, json: json });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : null;
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    finish({ ok: false, code: code, message: message.slice(0, 500) });
  }
})();
`

interface ResourceMessage {
  readonly type: 'resource'
  readonly id: number
  readonly resource: string
  readonly argsJson: string
}

interface ResultMessage {
  readonly type: 'result'
  readonly ok: boolean
  readonly json?: string
  readonly code?: string | null
  readonly message?: string
}

export class WorkerSkillSandbox implements SkillSandbox {
  readonly runtime = 'sandbox@1'

  constructor(private readonly options: { readonly memoryLimitMb?: number } = {}) {}

  run(request: SandboxRequest): Promise<SandboxOutcome> {
    return new Promise<SandboxOutcome>((resolve) => {
      if (request.signal.aborted) {
        resolve({ kind: 'cancelled' })
        return
      }
      let settled = false
      const worker = new Worker(BOOTSTRAP, {
        eval: true,
        workerData: { source: request.source, inputJson: JSON.stringify(request.input ?? null) },
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: this.options.memoryLimitMb ?? 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4
        }
      })
      // The Skill has no console; drain the thread's output so it never blocks.
      worker.stdout.resume()
      worker.stderr.resume()

      const settle = (outcome: SandboxOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
        // Ends the thread, including code still running after a timeout or cancel.
        void worker.terminate()
      }
      const onAbort = () => {
        settle({ kind: 'cancelled' })
      }
      const timer = setTimeout(() => {
        settle({ kind: 'timed-out' })
      }, request.timeoutMs)
      request.signal.addEventListener('abort', onAbort, { once: true })

      worker.on('message', (raw: unknown) => {
        if (settled || typeof raw !== 'object' || raw === null) return
        const message = raw as { type?: unknown }
        if (message.type === 'resource') {
          const call = raw as ResourceMessage
          const args = parseArgs(call.argsJson)
          request.useResource(call.resource, args).then(
            (value) => {
              if (!settled)
                worker.postMessage({
                  type: 'resource-reply',
                  id: call.id,
                  ok: true,
                  json: JSON.stringify(value ?? null)
                })
            },
            (error: unknown) => {
              const failure = error as { code?: unknown; message?: unknown }
              if (!settled)
                worker.postMessage({
                  type: 'resource-reply',
                  id: call.id,
                  ok: false,
                  code: typeof failure.code === 'string' ? failure.code : 'RESOURCE_FAILED',
                  message:
                    typeof failure.message === 'string' ? failure.message : 'The resource failed.'
                })
            }
          )
          return
        }
        if (message.type === 'result') {
          const result = raw as ResultMessage
          if (result.ok) {
            try {
              settle({ kind: 'completed', output: JSON.parse(result.json ?? 'null') as unknown })
            } catch {
              settle({
                kind: 'failed',
                code: 'SKILL_OUTPUT_INVALID',
                message: 'Unreadable output.'
              })
            }
          } else {
            settle({
              kind: 'failed',
              code: typeof result.code === 'string' ? result.code : null,
              message: typeof result.message === 'string' ? result.message : 'The Skill failed.'
            })
          }
        }
      })
      worker.on('error', (error: Error) => {
        settle({ kind: 'crashed', message: error.message.slice(0, 500) })
      })
      worker.on('exit', (code) => {
        settle({
          kind: 'crashed',
          message: `The Skill's runtime ended without a result (exit code ${String(code)}).`
        })
      })
    })
  }
}

function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch {
    return null
  }
}
