import {
  JupiterError,
  ProviderError,
  invalidResponse,
  providerErrorFromStatus,
  type AdapterContext
} from '@jupiter/core'

/**
 * Small helpers shared by the adapters. Every request goes through the
 * context's guarded transport; nothing here calls the network directly.
 */

/** `https://host/v1` + `chat/completions` → `https://host/v1/chat/completions`. */
export function endpoint(base: URL, path: string): URL {
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`
  return new URL(path.replace(/^\//, ''), root)
}

const MAX_ERROR_BODY = 16_384
const MAX_JSON_BODY = 16 * 1024 * 1024

/** The provider's own explanation from an error reply, if it gave one. */
export async function errorMessageOf(response: Response): Promise<string | null> {
  let text: string
  try {
    text = (await response.text()).slice(0, MAX_ERROR_BODY)
  } catch {
    return null
  }
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text) as unknown
    const message = findMessage(parsed)
    if (message) return message
  } catch {
    // Not JSON: the text itself is the explanation.
  }
  return text.trim()
}

function findMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  const nested = record.error
  if (typeof nested === 'string') return nested
  return findMessage(nested)
}

export interface JsonRequest {
  readonly method: 'GET' | 'POST'
  readonly url: URL
  readonly headers: Record<string, string>
  readonly body?: unknown
  readonly providerName: string
  readonly accept?: string
}

/** Send a request and return the response, or throw the provider's sanitized error. */
export async function send(context: AdapterContext, request: JsonRequest): Promise<Response> {
  const response = await context.transport.request(request.url, {
    method: request.method,
    headers: {
      accept: request.accept ?? 'application/json',
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...request.headers
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: context.signal,
    carriesSecret: context.apiKey !== null
  })
  if (!response.ok) {
    const message = await errorMessageOf(response)
    throw providerErrorFromStatus(response.status, message, context.apiKey, request.providerName)
  }
  return response
}

/** Read a JSON body, with a size limit and a clear error for anything that is not JSON. */
export async function readJson(
  response: Response,
  providerName: string,
  signal: AbortSignal
): Promise<unknown> {
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > MAX_JSON_BODY) throw invalidResponse(providerName, 'the reply is too large')
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw interrupted(providerName, signal, error)
  }
  if (text.length > MAX_JSON_BODY) throw invalidResponse(providerName, 'the reply is too large')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw invalidResponse(providerName, 'the reply is not JSON')
  }
}

export function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
}

/** A body that stopped arriving: cancelled by Jupiter, or cut off by the connection. */
export function interrupted(
  providerName: string,
  signal: AbortSignal,
  cause: unknown
): JupiterError {
  if (signal.aborted)
    return new JupiterError('CANCELLED', 'The request was stopped.', {
      category: 'cancellation',
      userAction: null,
      cause
    })
  return new ProviderError(
    'PROVIDER_UNREACHABLE',
    `The connection to ${providerName} was closed before the reply was complete.`,
    { cause }
  )
}
