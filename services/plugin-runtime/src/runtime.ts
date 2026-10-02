import vm from 'node:vm'

/**
 * The plugin runtime process (SET 15). One process runs one invocation.
 *
 * It is started by Jupiter Core with Node's permission model on (no file
 * system beyond this script, no child processes, no worker threads, no
 * native add-ons) and an empty environment. The plugin's code arrives in
 * the first message — the runtime never reads a plugin file — and runs in a
 * `vm` context that has the JavaScript built-ins and nothing else: no
 * `require`, `process`, timers, console, network or Electron.
 *
 * Only strings cross between this script and the plugin's context, so the
 * plugin never holds a reference to an object of this realm. The only way
 * out is `context.use(handle, args)`, which Core checks against the
 * plugin's manifest and the Permission Engine.
 *
 * A `vm` context is not a security boundary on its own (Node says so); the
 * process boundary and the permission model are the second wall.
 */

interface Waiting {
  readonly resolve: (json: string) => void
  readonly reject: (failure: string) => void
}

const waiting = new Map<number, Waiting>()
let nextId = 0
let started = false

function send(message: Record<string, unknown>): void {
  process.send?.(message)
}

function finish(result: { ok: true; json: string } | { ok: false; code: string; message: string }) {
  send({ type: 'result', ...result })
}

/** Outside the plugin's reach: called only from code defined before the plugin's. */
function bridge(handle: string, argsJson: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    send({ type: 'use', id, handle: handle.slice(0, 64), argsJson })
  })
}

process.on('message', (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return
  const message = raw as Record<string, unknown>
  if (message.type === 'use-reply' && typeof message.id === 'number') {
    const entry = waiting.get(message.id)
    if (!entry) return
    waiting.delete(message.id)
    if (message.ok === true && typeof message.json === 'string') entry.resolve(message.json)
    else
      entry.reject(
        JSON.stringify({
          code: typeof message.code === 'string' ? message.code : 'HANDLE_FAILED',
          message: typeof message.message === 'string' ? message.message : 'The handle failed.'
        })
      )
    return
  }
  if (
    message.type === 'run' &&
    !started &&
    typeof message.code === 'string' &&
    typeof message.handler === 'string' &&
    typeof message.inputJson === 'string'
  ) {
    started = true
    run(message.code, message.handler, message.inputJson)
  }
})

function run(code: string, handler: string, inputJson: string): void {
  const context = vm.createContext(Object.create(null) as object, {
    name: 'plugin',
    codeGeneration: { strings: false, wasm: false }
  })
  // V8 gives every context a debugger-only console, and WebAssembly (compiling is already off).
  vm.runInContext('delete globalThis.console; delete globalThis.WebAssembly;', context)
  // Defined before the plugin's code runs, in the plugin's realm, in strict mode: the plugin
  // can neither reach `bridge`, `done` and `failed` nor change how these closures behave.
  const harness = vm.runInContext(
    `'use strict';
    (function (bridge) {
      var parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze;
      var PromiseCtor = Promise, StringCtor = String;
      function fail(code, message) { var error = new Error(message); error.code = code; return error; }
      var context = freeze({
        use: function (handle, args) {
          var argsJson = stringify(args === undefined ? null : args);
          return new PromiseCtor(function (resolve, reject) {
            bridge(StringCtor(handle), StringCtor(argsJson)).then(
              function (json) { resolve(parse(json)); },
              function (failure) { var f = parse(failure); reject(fail(f.code, f.message)); });
          });
        }
      });
      return freeze({
        module: { exports: {} },
        start: async function (fn, inputJson, done, failed) {
          try {
            var output = await fn(parse(inputJson), context);
            var json;
            try { json = stringify(output === undefined ? null : output); }
            catch (e) { failed('PLUGIN_OUTPUT_NOT_SERIALIZABLE', 'The output cannot be represented as JSON.'); return; }
            done(StringCtor(json));
          } catch (error) {
            var code = error && typeof error.code === 'string' ? error.code : 'PLUGIN_FAILED';
            var message = error && typeof error.message === 'string' ? error.message : StringCtor(error);
            failed(StringCtor(code).slice(0, 64), StringCtor(message).slice(0, 500));
          }
        }
      });
    })`,
    context,
    { filename: 'jupiter-plugin-harness.js' }
  ) as (bridge: (handle: string, argsJson: string) => Promise<string>) => {
    module: { exports: Record<string, unknown> }
    start: (
      fn: unknown,
      inputJson: string,
      done: (json: unknown) => void,
      failed: (code: unknown, message: unknown) => void
    ) => Promise<void>
  }
  const instance = harness(bridge)
  try {
    const define = vm.runInContext(
      `(function (module, exports) { 'use strict';\n${code}\n})`,
      context,
      { filename: 'plugin.js' }
    ) as (module: object, exports: object) => void
    define(instance.module, instance.module.exports)
  } catch (error) {
    finish({ ok: false, code: 'PLUGIN_LOAD_FAILED', message: messageOf(error) })
    return
  }
  const exported = instance.module.exports
  const fn = Object.prototype.hasOwnProperty.call(exported, handler) ? exported[handler] : undefined
  if (typeof fn !== 'function') {
    finish({
      ok: false,
      code: 'PLUGIN_HANDLER_MISSING',
      message: `The plugin does not export a function named "${handler}".`
    })
    return
  }
  void instance.start(
    fn,
    inputJson,
    (json) => {
      if (typeof json === 'string') finish({ ok: true, json })
      else finish({ ok: false, code: 'PLUGIN_OUTPUT_INVALID', message: 'Unreadable output.' })
    },
    (code, message) => {
      finish({
        ok: false,
        code: typeof code === 'string' ? code : 'PLUGIN_FAILED',
        message: typeof message === 'string' ? message : 'The plugin failed.'
      })
    }
  )
}

function messageOf(error: unknown): string {
  // Read through a primitive: an object from the plugin's realm is never inspected further.
  try {
    const value =
      typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : error
    return (typeof value === 'string' ? value : 'The plugin failed.').slice(0, 500)
  } catch {
    return 'The plugin failed.'
  }
}

send({ type: 'ready' })
