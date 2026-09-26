import type { AdapterInfo, FinishReason, TokenUsage } from '@jupiter/contracts'
import { JupiterError } from '../errors'
import type { DiscoveredModel } from '../ports'
import { sanitizeProviderText } from './sanitize'

/**
 * The provider adapter port.
 *
 * An adapter translates between Jupiter's provider-neutral requests and one
 * provider protocol. Jupiter Core depends only on this interface: which
 * adapters exist is decided where Core is assembled (the Core process entry),
 * so adding or removing a provider protocol never changes Core.
 *
 * Adapters never touch the network themselves. Every request goes through
 * the `Transport` Core hands them, which enforces the routing mode (Local
 * only blocks every endpoint that is not on this computer, before anything is
 * sent), refuses redirects, and refuses to send a key over an unencrypted
 * connection to another machine.
 */

export interface TransportRequest {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly signal: AbortSignal
  /** True when the headers carry the API key. */
  readonly carriesSecret: boolean
}

export interface Transport {
  request(url: URL, init: TransportRequest): Promise<Response>
}

export interface AdapterContext {
  /** The name the person gave the provider, for messages. */
  readonly providerName: string
  readonly baseUrl: URL
  /** The provider's API key, read from secure storage for this request only. Null when none. */
  readonly apiKey: string | null
  readonly signal: AbortSignal
  readonly transport: Transport
}

export type AdapterContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly dataBase64: string }

export interface AdapterToolCall {
  readonly callId: string
  readonly name: string
  /** JSON text, exactly as the model produced it. */
  readonly arguments: string
}

export type AdapterMessage =
  | { readonly role: 'system'; readonly text: string }
  | { readonly role: 'user'; readonly content: readonly AdapterContentPart[] }
  | {
      readonly role: 'assistant'
      readonly text: string
      readonly toolCalls: readonly AdapterToolCall[]
    }
  | { readonly role: 'tool'; readonly callId: string; readonly content: string }

export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments. */
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface ChatRequest {
  readonly model: string
  readonly messages: readonly AdapterMessage[]
  readonly tools?: readonly ToolSpec[]
  /** Ask for JSON that matches this schema (structured output). */
  readonly responseFormat?: {
    readonly name: string
    readonly schema: Readonly<Record<string, unknown>>
  } | null
  readonly maxOutputTokens?: number | null
}

/**
 * What an adapter yields while a chat answer streams. There is deliberately
 * no chunk for reasoning text: adapters drop hidden reasoning and report only
 * how many tokens it used.
 */
export type ChatChunk =
  | { readonly type: 'text'; readonly text: string }
  | ({ readonly type: 'tool-call' } & AdapterToolCall)
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: FinishReason }

export interface EmbeddingRequest {
  readonly model: string
  readonly inputs: readonly string[]
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[]
  readonly usage: TokenUsage | null
}

export interface ProviderAdapter {
  readonly info: AdapterInfo
  /** The provider's model list. Throws a ProviderError on failure (for example a rejected key). */
  listModels(context: AdapterContext): Promise<DiscoveredModel[]>
  /** Stream an answer. Must stop and release the connection as soon as `context.signal` aborts. */
  streamChat(context: AdapterContext, request: ChatRequest): AsyncIterable<ChatChunk>
  /** Only for adapters that list `embeddings` among their operations. */
  embed?(context: AdapterContext, request: EmbeddingRequest): Promise<EmbeddingResult>
}

// ---- provider errors -----------------------------------------------------------------------

/**
 * Error codes shared by every adapter, so the router, the interface and the
 * translations see the same vocabulary whichever provider failed.
 */
export const PROVIDER_ERROR_CODES = [
  'PROVIDER_KEY_REJECTED',
  'PROVIDER_UNREACHABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_SERVER_ERROR',
  'PROVIDER_REQUEST_REJECTED',
  'PROVIDER_MODEL_NOT_FOUND',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_TIMEOUT'
] as const
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]

/** Failures that say nothing about the request itself: another model may succeed. */
export const TRANSIENT_PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  'PROVIDER_UNREACHABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_SERVER_ERROR',
  'PROVIDER_TIMEOUT'
])

export class ProviderError extends JupiterError {
  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { status?: number | null; retryable?: boolean; cause?: unknown } = {}
  ) {
    const retryable = options.retryable ?? TRANSIENT_PROVIDER_ERRORS.has(code)
    super(code, message, {
      category:
        code === 'PROVIDER_KEY_REJECTED' || code === 'PROVIDER_MODEL_NOT_FOUND'
          ? 'configuration'
          : code === 'PROVIDER_UNREACHABLE'
            ? 'dependency'
            : code === 'PROVIDER_TIMEOUT'
              ? 'timeout'
              : 'provider',
      userAction: userActionFor(code),
      retryable,
      ...(options.status === undefined || options.status === null
        ? {}
        : { details: { httpStatus: options.status } }),
      ...(options.cause === undefined ? {} : { cause: options.cause })
    })
    this.name = 'ProviderError'
  }
}

function userActionFor(code: ProviderErrorCode): string {
  switch (code) {
    case 'PROVIDER_KEY_REJECTED':
      return 'Check the API key in AI models and save a valid one.'
    case 'PROVIDER_UNREACHABLE':
      return 'Check that the provider is running and its address is right, then try again.'
    case 'PROVIDER_RATE_LIMITED':
      return 'The provider is limiting requests. Wait a moment and try again.'
    case 'PROVIDER_SERVER_ERROR':
      return 'The provider had a problem. Try again later.'
    case 'PROVIDER_REQUEST_REJECTED':
      return 'The provider refused this request. Try a different model or a shorter message.'
    case 'PROVIDER_MODEL_NOT_FOUND':
      return 'The provider no longer offers this model. Check the models in AI models.'
    case 'PROVIDER_RESPONSE_INVALID':
      return 'The provider sent a reply Jupiter could not read. Try again, or use another model.'
    case 'PROVIDER_TIMEOUT':
      return 'The provider stopped responding. Try again.'
  }
}

/**
 * Turn an HTTP error reply into a ProviderError. The provider's own message
 * is kept (it is often the most useful explanation) but sanitized: the key is
 * removed even when the provider echoes it, credential formats are redacted,
 * and it is shortened.
 */
export function providerErrorFromStatus(
  status: number,
  providerMessage: string | null,
  apiKey: string | null,
  providerName: string
): ProviderError {
  const detail = providerMessage ? sanitizeProviderText(providerMessage, [apiKey]) : null
  const suffix = detail ? `: ${detail}` : '.'
  if (status === 401 || status === 403)
    return new ProviderError(
      'PROVIDER_KEY_REJECTED',
      `${providerName} rejected the API key (HTTP ${String(status)})${suffix}`,
      { status }
    )
  if (status === 404)
    return new ProviderError(
      'PROVIDER_MODEL_NOT_FOUND',
      `${providerName} does not know this model or address (HTTP 404)${suffix}`,
      { status }
    )
  if (status === 408)
    return new ProviderError('PROVIDER_TIMEOUT', `${providerName} timed out (HTTP 408)${suffix}`, {
      status
    })
  if (status === 429)
    return new ProviderError(
      'PROVIDER_RATE_LIMITED',
      `${providerName} is limiting requests (HTTP 429)${suffix}`,
      { status }
    )
  if (status >= 500)
    return new ProviderError(
      'PROVIDER_SERVER_ERROR',
      `${providerName} had a server error (HTTP ${String(status)})${suffix}`,
      { status }
    )
  return new ProviderError(
    'PROVIDER_REQUEST_REJECTED',
    `${providerName} refused the request (HTTP ${String(status)})${suffix}`,
    { status }
  )
}

export function invalidResponse(providerName: string, what: string): ProviderError {
  return new ProviderError(
    'PROVIDER_RESPONSE_INVALID',
    `${providerName} sent a reply Jupiter could not read (${what}).`
  )
}
