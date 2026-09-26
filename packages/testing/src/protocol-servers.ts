import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { networkInterfaces } from 'node:os'

/**
 * Protocol test servers — tests only, never part of Jupiter.
 *
 * Real HTTP servers that speak the provider protocols Jupiter's adapters
 * implement (OpenAI-compatible chat completions and the Anthropic Messages
 * API), with answers scripted by the test. They let the tests exercise the
 * real network path — adapters, guarded transport, streaming, cancellation,
 * error handling — and observe exactly what reached the "provider": every
 * request, its headers and body, whether it was aborted, and every TCP
 * connection (so a test can prove that nothing was sent).
 */

export interface ScriptedReply {
  /** HTTP status for an error reply; the text is sent as `{ error: { message } }`. */
  readonly status?: number
  readonly errorMessage?: string
  readonly chunks?: readonly string[]
  /** Hidden reasoning the provider streams; adapters must drop it. */
  readonly reasoning?: readonly string[]
  readonly toolCalls?: readonly { id: string; name: string; arguments: string }[]
  readonly usage?: { input: number; output: number; reasoning?: number }
  readonly finishReason?: string
  /** Wait between chunks. */
  readonly delayMs?: number
  /** Send each chunk only when the test calls `advance()`. */
  readonly gated?: boolean
  /** Stop after this many chunks and keep the connection open (a stalled provider). */
  readonly stallAfter?: number
  /** Close the connection right away without answering. */
  readonly drop?: boolean
}

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: unknown
  readonly receivedAt: number
  /** Set when the client closed the connection before the reply was complete. */
  abortedAt: number | null
}

export interface ProtocolServer {
  /** Base address to configure in Jupiter (includes `/v1` for the OpenAI-compatible server). */
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  /** TCP connections accepted since start or the last reset. */
  readonly connections: () => number
  /** Answers for the next chat requests, in order. Without one, a short default answer is sent. */
  enqueue(...replies: ScriptedReply[]): void
  setModels(models: readonly { id: string; name?: string }[]): void
  /** Require this key (null: accept any, including none). A wrong key gets 401 and an echo of it. */
  requireKey(key: string | null): void
  /** Release the next gated chunk. */
  advance(): void
  /** Answer every request with this status until cleared (an outage). */
  failAll(status: number | null): void
  reset(): void
  close(): Promise<void>
}

type Protocol = 'openai' | 'anthropic'

/** A non-loopback IPv4 address of this machine, to stand in for a "cloud" endpoint. */
export function nonLoopbackAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

export function startOpenAiCompatibleServer(
  options: { host?: string } = {}
): Promise<ProtocolServer> {
  return start('openai', options.host ?? '127.0.0.1')
}

export function startAnthropicServer(options: { host?: string } = {}): Promise<ProtocolServer> {
  return start('anthropic', options.host ?? '127.0.0.1')
}

async function start(protocol: Protocol, host: string): Promise<ProtocolServer> {
  const requests: RecordedRequest[] = []
  const queue: ScriptedReply[] = []
  const gates: (() => void)[] = []
  let pendingAdvances = 0
  let models: { id: string; name?: string }[] = [{ id: 'test-model' }]
  let key: string | null = null
  let outage: number | null = null
  let connections = 0
  const sockets = new Set<Socket>()

  const waitGate = () =>
    new Promise<void>((resolve) => {
      if (pendingAdvances > 0) {
        pendingAdvances--
        resolve()
      } else gates.push(resolve)
    })

  const server = createServer((request, response) => {
    void handle(request, response)
  })
  server.on('connection', (socket) => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const text = await readBody(request)
    const body = parseBody(text)
    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: { ...request.headers },
      body,
      receivedAt: Date.now(),
      abortedAt: null
    }
    requests.push(recorded)
    response.on('close', () => {
      if (!response.writableFinished) recorded.abortedAt = Date.now()
    })

    if (outage !== null) {
      sendError(response, outage, 'The service is unavailable (test outage).')
      return
    }
    const presented =
      protocol === 'openai'
        ? (request.headers.authorization ?? '').replace(/^Bearer /, '')
        : String(request.headers['x-api-key'] ?? '')
    if (key !== null && presented !== key) {
      // Real providers sometimes echo the key they got; Jupiter must never show it.
      sendError(response, 401, `Incorrect API key provided: ${presented}`)
      return
    }
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      sendJson(response, 200, {
        data: models.map((model) =>
          protocol === 'openai'
            ? { id: model.id, object: 'model', ...(model.name ? { name: model.name } : {}) }
            : { id: model.id, type: 'model', display_name: model.name ?? model.id }
        )
      })
      return
    }
    if (request.method === 'POST' && protocol === 'openai' && path === '/v1/embeddings') {
      const inputs = Array.isArray((body as { input?: unknown }).input)
        ? (body as { input: unknown[] }).input
        : []
      sendJson(response, 200, {
        data: inputs.map((_, index) => ({
          object: 'embedding',
          index,
          embedding: [index, 0.5, 1]
        })),
        usage: { prompt_tokens: inputs.length }
      })
      return
    }
    const chatPath = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'
    if (request.method !== 'POST' || path !== chatPath) {
      sendError(response, 404, 'Not found')
      return
    }

    const reply = queue.shift() ?? { chunks: ['Hello', ' from the test server.'] }
    if (reply.drop) {
      request.socket.destroy()
      return
    }
    if (reply.status) {
      sendError(response, reply.status, reply.errorMessage ?? 'Test error')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const write = (data: string, event?: string) =>
      response.write(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`)
    const pause = async () => {
      if (reply.gated) await waitGate()
      else if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
    }
    const alive = () => !response.destroyed && !response.writableEnded

    if (protocol === 'anthropic')
      write(
        JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: reply.usage?.input ?? 3 } }
        }),
        'message_start'
      )
    for (const [index, reasoning] of (reply.reasoning ?? []).entries()) {
      if (protocol === 'openai')
        write(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] }))
      else {
        if (index === 0)
          write(
            JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking' }
            }),
            'content_block_start'
          )
        write(
          JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: reasoning }
          }),
          'content_block_delta'
        )
      }
    }
    const textIndex = protocol === 'anthropic' && reply.reasoning?.length ? 1 : 0
    if (protocol === 'anthropic')
      write(
        JSON.stringify({
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' }
        }),
        'content_block_start'
      )
    for (const [index, chunk] of (reply.chunks ?? []).entries()) {
      if (reply.stallAfter !== undefined && index >= reply.stallAfter) return
      if (index > 0 || reply.gated) await pause()
      if (!alive()) return
      write(
        protocol === 'openai'
          ? JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] })
          : JSON.stringify({
              type: 'content_block_delta',
              index: textIndex,
              delta: { type: 'text_delta', text: chunk }
            }),
        protocol === 'anthropic' ? 'content_block_delta' : undefined
      )
    }
    if (!alive()) return
    for (const [index, call] of (reply.toolCalls ?? []).entries()) {
      if (protocol === 'openai') {
        write(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: '' }
                    }
                  ]
                }
              }
            ]
          })
        )
        write(
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index, function: { arguments: call.arguments } }] }
              }
            ]
          })
        )
      } else {
        const blockIndex = textIndex + 1 + index
        write(
          JSON.stringify({
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} }
          }),
          'content_block_start'
        )
        write(
          JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: call.arguments }
          }),
          'content_block_delta'
        )
        write(
          JSON.stringify({ type: 'content_block_stop', index: blockIndex }),
          'content_block_stop'
        )
      }
    }
    const finish = reply.finishReason ?? (reply.toolCalls?.length ? 'tool_calls' : 'stop')
    if (protocol === 'openai') {
      write(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }))
      write(
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: reply.usage?.input ?? 3,
            completion_tokens: reply.usage?.output ?? reply.chunks?.length ?? 0,
            completion_tokens_details: { reasoning_tokens: reply.usage?.reasoning ?? 0 }
          }
        })
      )
      response.end('data: [DONE]\n\n')
    } else {
      write(JSON.stringify({ type: 'content_block_stop', index: textIndex }), 'content_block_stop')
      write(
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: finish === 'tool_calls' ? 'tool_use' : 'end_turn' },
          usage: { output_tokens: reply.usage?.output ?? reply.chunks?.length ?? 0 }
        }),
        'message_delta'
      )
      write(JSON.stringify({ type: 'message_stop' }), 'message_stop')
      response.end()
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`

  return {
    baseUrl: protocol === 'openai' ? `${origin}/v1` : origin,
    requests,
    connections: () => connections,
    enqueue: (...replies) => {
      queue.push(...replies)
    },
    setModels: (next) => {
      models = [...next]
    },
    requireKey: (next) => {
      key = next
    },
    advance: () => {
      const next = gates.shift()
      if (next) next()
      else pendingAdvances++
    },
    failAll: (status) => {
      outage = status
    },
    reset: () => {
      requests.length = 0
      queue.length = 0
      connections = 0
      outage = null
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const resolveGate of gates.splice(0)) resolveGate()
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          resolve()
        })
      })
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      resolve(Buffer.concat(parts).toString('utf8'))
    })
    request.on('error', () => {
      resolve('')
    })
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: { type: 'test_error', message } })
}

function parseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
