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

/** A scripted speech-to-text answer (SET 12). */
export interface ScriptedTranscript {
  readonly text?: string
  readonly language?: string
  /** HTTP status for an error reply. */
  readonly status?: number
  readonly errorMessage?: string
  readonly delayMs?: number
}

/** What a transcription request carried, measured from the uploaded WAV. */
export interface ReceivedAudio {
  readonly model: string | null
  readonly language: string | null
  readonly bytes: number
  readonly wav: WavStats | null
}

export interface WavStats {
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
  readonly durationMs: number
  /** Root mean square of the samples, 0–1. */
  readonly rms: number
  /** Largest absolute sample, 0–1. */
  readonly peak: number
}

/** Reads a PCM WAV's format and measures its loudness (tests only). */
export function wavStats(bytes: Uint8Array): WavStats | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.byteLength < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  while (offset + 8 <= buffer.byteLength) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10)
      sampleRate = buffer.readUInt32LE(offset + 12)
      bitsPerSample = buffer.readUInt16LE(offset + 22)
    }
    if (id === 'data') {
      if (bitsPerSample !== 16 || !channels || !sampleRate) return null
      const end = Math.min(buffer.byteLength, offset + 8 + size)
      let sum = 0
      let peak = 0
      let count = 0
      for (let at = offset + 8; at + 1 < end; at += 2) {
        const sample = buffer.readInt16LE(at) / 32768
        sum += sample * sample
        peak = Math.max(peak, Math.abs(sample))
        count++
      }
      return {
        sampleRate,
        channels,
        bitsPerSample,
        durationMs: Math.round((count / channels / sampleRate) * 1000),
        rms: count ? Math.sqrt(sum / count) : 0,
        peak
      }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

/** A mono 16-bit PCM WAV (tests only). */
export function toWav(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.byteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.byteLength, 40)
  return Buffer.concat([header, data])
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
  /**
   * Embeddings by the words of each input (a 32-dimension bag of words), so
   * texts that share words are close. Off: `[index, 0.5, 1]` for each input.
   */
  embedByWords(on: boolean): void
  /** Answers for the next speech-to-text requests, in order (SET 12). Without one: 404-free empty text. */
  transcribe(...replies: ScriptedTranscript[]): void
  /** Audio each transcription request carried, in order. */
  readonly audio: ReceivedAudio[]
  /** The WAV `/audio/speech` returns (default: a short test tone). */
  setSpeech(wav: Uint8Array | null): void
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

/** A tiny deterministic "embedding": each word adds 1 to one of 32 dimensions. */
function wordVector(text: string): number[] {
  const vector = new Array<number>(32).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 0
    for (const char of word) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
    vector[hash % 32] = (vector[hash % 32] ?? 0) + 1
  }
  return vector
}

async function start(protocol: Protocol, host: string): Promise<ProtocolServer> {
  const requests: RecordedRequest[] = []
  let wordEmbeddings = false
  const queue: ScriptedReply[] = []
  const transcripts: ScriptedTranscript[] = []
  const audio: ReceivedAudio[] = []
  let speech: Uint8Array | null = null
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
    const raw = await readBody(request)
    const multipartBody = isMultipart(request) ? parseMultipart(request, raw) : null
    const body = multipartBody
      ? { fields: multipartBody.fields, fileBytes: multipartBody.file?.byteLength ?? 0 }
      : parseBody(raw.toString('utf8'))
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
        data: inputs.map((input, index) => ({
          object: 'embedding',
          index,
          embedding: wordEmbeddings ? wordVector(String(input)) : [index, 0.5, 1]
        })),
        usage: { prompt_tokens: inputs.length }
      })
      return
    }
    if (request.method === 'POST' && protocol === 'openai' && path === '/v1/audio/transcriptions') {
      const file = multipartBody?.file ?? null
      audio.push({
        model: multipartBody?.fields.model ?? null,
        language: multipartBody?.fields.language ?? null,
        bytes: file?.byteLength ?? 0,
        wav: file ? wavStats(file) : null
      })
      const reply = transcripts.shift() ?? { text: '' }
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
      if (reply.status) {
        sendError(response, reply.status, reply.errorMessage ?? 'Test error')
        return
      }
      if (!file) {
        sendError(response, 400, 'No audio file')
        return
      }
      sendJson(response, 200, {
        text: reply.text ?? '',
        ...(reply.language ? { language: reply.language } : {})
      })
      return
    }
    if (request.method === 'POST' && protocol === 'openai' && path === '/v1/audio/speech') {
      const wav = speech ?? testTone()
      response.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(wav.byteLength)
      })
      response.end(Buffer.from(wav))
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
    embedByWords: (on) => {
      wordEmbeddings = on
    },
    transcribe: (...replies) => {
      transcripts.push(...replies)
    },
    audio,
    setSpeech: (wav) => {
      speech = wav
    },
    reset: () => {
      requests.length = 0
      queue.length = 0
      transcripts.length = 0
      audio.length = 0
      speech = null
      connections = 0
      outage = null
      wordEmbeddings = false
      // Replies still waiting from earlier requests must not consume the next test's advances.
      for (const resolveGate of gates.splice(0)) resolveGate()
      pendingAdvances = 0
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

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      resolve(Buffer.concat(parts))
    })
    request.on('error', () => {
      resolve(Buffer.alloc(0))
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

function isMultipart(request: IncomingMessage): boolean {
  return (request.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data')
}

/** A minimal multipart/form-data reader: text fields and one file (tests only). */
function parseMultipart(
  request: IncomingMessage,
  raw: Buffer
): { fields: Record<string, string>; file: Buffer | null } {
  const boundary = /boundary=([^;]+)/i.exec(request.headers['content-type'] ?? '')?.[1]
  const fields: Record<string, string> = {}
  let file: Buffer | null = null
  if (!boundary) return { fields, file }
  const marker = Buffer.from(`--${boundary}`)
  let start = raw.indexOf(marker)
  while (start !== -1) {
    const next = raw.indexOf(marker, start + marker.byteLength)
    if (next === -1) break
    const part = raw.subarray(start + marker.byteLength + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8')
      const content = part.subarray(split + 4)
      const name = /name="([^"]+)"/.exec(head)?.[1]
      if (head.includes('filename="')) file = Buffer.from(content)
      else if (name) fields[name] = content.toString('utf8')
    }
    start = next
  }
  return { fields, file }
}

/** A 0.6 s, 440 Hz tone at 16 kHz: clearly a test sound, never speech. */
function testTone(): Buffer {
  const rate = 16_000
  const samples = new Int16Array(Math.round(rate * 0.6))
  for (let index = 0; index < samples.length; index++)
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8_000)
  return toWav(samples, rate)
}

function parseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
