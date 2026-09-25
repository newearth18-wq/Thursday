import { ProviderError } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Merge an external abort signal with a connect timeout.
 *
 * `clearTimer` stops only the timeout. The caller's abort signal stays wired
 * to the returned signal for the whole life of the request, so cancelling a
 * chat still aborts a response body that is already streaming.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  clearTimer: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs
  )
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    // `once` removes the listener when it fires, so nothing accumulates.
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return { signal: controller.signal, clearTimer: () => clearTimeout(timer) }
}

/**
 * Turn low-level network failures into messages that name the actual problem.
 * "Something went wrong" is never acceptable, so every branch says what and where.
 */
export function explainNetworkError(err: unknown, url: string): ProviderError {
  const error = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  const code = error?.cause?.code ?? ''
  const host = safeHost(url)

  if (error?.name === 'AbortError') {
    const reason = String((err as { reason?: unknown })?.reason ?? error.message ?? 'aborted')
    return new ProviderError(
      reason.includes('timed out') ? `Timed out waiting for ${host}` : `Request to ${host} was cancelled`
    )
  }
  switch (code) {
    case 'ECONNREFUSED':
      return new ProviderError(
        `Connection refused by ${host} — nothing is listening on that address`,
        `Check the base URL and that the service is running. (${url})`
      )
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ProviderError(
        `Host "${host}" could not be resolved`,
        'Check the base URL spelling and your network connection.'
      )
    case 'ECONNRESET':
      return new ProviderError(`Connection to ${host} was reset before a response arrived`)
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return new ProviderError(`TLS certificate for ${host} could not be verified (${code})`)
    case 'ETIMEDOUT':
      return new ProviderError(`Timed out connecting to ${host}`)
    default:
      return new ProviderError(
        `Could not reach ${host}: ${error?.cause?.message ?? error?.message ?? String(err)}`,
        url
      )
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

export async function httpRequest(url: string, options: RequestOptions = {}): Promise<Response> {
  const { signal, clearTimer } = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal
    })
    if (!response.ok) {
      throw new ProviderError(
        `${safeHost(url)} returned HTTP ${response.status} ${response.statusText}`,
        await readErrorBody(response)
      )
    }
    return response
  } catch (err) {
    if (err instanceof ProviderError) throw err
    throw explainNetworkError(err, url)
  } finally {
    // fetch() settles once response headers arrive, so the timeout only ever
    // guards time-to-first-byte. A slow streaming body is never cut off.
    clearTimer()
  }
}

export async function httpJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await httpRequest(url, options)
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ProviderError(
      `${safeHost(url)} returned a response that is not JSON`,
      text.slice(0, 300)
    )
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return 'The server sent no error details.'
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const nested = parsed.error
      if (typeof nested === 'string') return nested
      if (nested && typeof nested === 'object') {
        const message = (nested as { message?: unknown }).message
        if (typeof message === 'string') return message
      }
      if (typeof parsed.message === 'string') return parsed.message
    } catch {
      // fall through to raw text
    }
    return text.slice(0, 500)
  } catch {
    return 'The error body could not be read.'
  }
}

/** Parse a `text/event-stream` body into successive `data:` payload strings. */
export async function* readSse(response: Response): AsyncGenerator<string> {
  const body = response.body
  if (!body) throw new ProviderError('The server accepted the request but sent no response body')

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true })
    let separator = buffer.indexOf('\n\n')
    while (separator !== -1) {
      const rawEvent = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) yield data
      separator = buffer.indexOf('\n\n')
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) yield tail.slice(5).trimStart()
}

/** Parse a newline-delimited JSON body (Ollama's streaming format). */
export async function* readNdJson(response: Response): AsyncGenerator<string> {
  const body = response.body
  if (!body) throw new ProviderError('The server accepted the request but sent no response body')
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield line
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim()) yield buffer.trim()
}

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}
