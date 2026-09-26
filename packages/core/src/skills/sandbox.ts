/**
 * The port through which the Skill Registry runs Skill code (SET 6).
 *
 * Every invocation gets its own isolated runtime, and the runtime can be
 * torn down at any moment: a timeout or a cancel ends the work itself, not
 * just its display. Skill code reaches nothing but the resources the
 * registry hands it through `use`, which the registry checks against the
 * permissions the Skill declared and the invocation was granted.
 *
 * The Node implementation (`WorkerSkillSandbox`, `@jupiter/core/node`) runs
 * each invocation in a worker thread without environment variables or
 * `require`, and terminates the thread on timeout or cancel.
 */

export interface SandboxRequest {
  /** The Skill's code: a JavaScript function expression `async (input, context) => output`. */
  readonly source: string
  readonly input: unknown
  readonly timeoutMs: number
  readonly signal: AbortSignal
  /** Called for every `context.use(resource, args)`; its rejection is returned to the Skill. */
  readonly useResource: (resource: string, args: unknown) => Promise<unknown>
}

export type SandboxOutcome =
  | { readonly kind: 'completed'; readonly output: unknown }
  /** The Skill threw or rejected. `code` is what it set on its error, if anything. */
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'cancelled' }
  /** The runtime itself ended without a result (exit, uncaught error, memory limit). */
  | { readonly kind: 'crashed'; readonly message: string }

export interface SkillSandbox {
  /** The runtime this sandbox provides, e.g. `sandbox@1`. */
  readonly runtime: string
  run(request: SandboxRequest): Promise<SandboxOutcome>
}

/** Error a resource rejects with; its code and message reach the Skill. */
export class ResourceDenied extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ResourceDenied'
  }
}
