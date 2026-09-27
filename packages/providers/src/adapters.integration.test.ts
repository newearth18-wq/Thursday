import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RoutingMode } from '@jupiter/contracts'
import {
  createTransport,
  type AdapterContext,
  type ChatChunk,
  type ProviderAdapter
} from '@jupiter/core'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import {
  nonLoopbackAddress,
  startAnthropicServer,
  startOpenAiCompatibleServer,
  toWav,
  wavStats,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import { anthropicAdapter, toAnthropicMessages } from './anthropic'
import { openAiCompatibleAdapter } from './openai-compatible'

/**
 * The adapters against real HTTP servers that speak each protocol, through
 * Core's guarded transport — the same path Jupiter uses.
 */

const key = fakeCredentials().find((item) => item.patternId === 'openai-api-key')?.value ?? ''
const antKey = fakeCredentials().find((item) => item.patternId === 'anthropic-api-key')?.value ?? ''

let openai: ProtocolServer
let anthropic: ProtocolServer

beforeAll(async () => {
  openai = await startOpenAiCompatibleServer()
  anthropic = await startAnthropicServer()
})

afterAll(async () => {
  await openai.close()
  await anthropic.close()
})

function context(
  baseUrl: string,
  apiKey: string | null,
  options: { mode?: RoutingMode; signal?: AbortSignal } = {}
): AdapterContext {
  return {
    providerName: 'Test provider',
    baseUrl: new URL(baseUrl),
    apiKey,
    signal: options.signal ?? new AbortController().signal,
    transport: createTransport({
      fetch: (input, init) => fetch(input, init),
      mode: options.mode ?? 'AUTO',
      providerName: 'Test provider',
      onBlocked: () => undefined
    })
  }
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const question = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }]

describe.each([
  ['OpenAI-compatible', () => openai, openAiCompatibleAdapter(), key],
  ['Anthropic', () => anthropic, anthropicAdapter(), antKey]
] as [string, () => ProtocolServer, ProviderAdapter, string][])(
  '%s adapter',
  (_name, server, adapter, apiKey) => {
    it('lists the models the provider reports, sending the key', async () => {
      server().reset()
      server().requireKey(apiKey)
      server().setModels([{ id: 'model-a', name: 'Model A' }, { id: 'org/model-b:7b' }])
      const models = await adapter.listModels(context(server().baseUrl, apiKey))
      expect(models.map((model) => model.modelId)).toEqual(['model-a', 'org/model-b:7b'])
      expect(models[0]?.capabilities).toBeNull()
      const headers = server().requests[0]?.headers ?? {}
      expect(headers.authorization ?? headers['x-api-key']).toContain(apiKey)
    })

    it('reports a rejected key clearly, without ever repeating the key', async () => {
      server().reset()
      server().requireKey(apiKey)
      const wrong = `${apiKey.slice(0, -6)}WRONG1`
      const failure = await adapter
        .listModels(context(server().baseUrl, wrong))
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'PROVIDER_KEY_REJECTED', category: 'configuration' })
      const text = JSON.stringify(failure) + (failure as Error).message
      expect(text).not.toContain(wrong)
      expect(text).not.toContain(apiKey)
      expect((failure as Error).message).toContain('rejected the API key (HTTP 401)')
    })

    it('streams text, reports tool calls and usage, and drops hidden reasoning', async () => {
      server().reset()
      server().requireKey(null)
      server().enqueue({
        reasoning: ['secret chain of thought'],
        chunks: ['Hel', 'lo'],
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"q":"weather"}' }],
        usage: { input: 5, output: 2, reasoning: 7 }
      })
      const chunks = await collect(
        adapter.streamChat(context(server().baseUrl, apiKey), { model: 'm', messages: question })
      )
      expect(chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []))).toEqual([
        'Hel',
        'lo'
      ])
      expect(chunks).toContainEqual({
        type: 'tool-call',
        callId: 'call_1',
        name: 'lookup',
        arguments: '{"q":"weather"}'
      })
      expect(chunks).toContainEqual({ type: 'finish', reason: 'tool-calls' })
      expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({
        usage: { inputTokens: 5, outputTokens: 2 }
      })
      expect(JSON.stringify(chunks)).not.toContain('chain of thought')
    })

    it('stops the provider request when the signal aborts', async () => {
      server().reset()
      server().requireKey(null)
      server().enqueue({ chunks: ['one', 'two', 'three'], gated: true })
      const controller = new AbortController()
      const stream = adapter.streamChat(
        context(server().baseUrl, null, { signal: controller.signal }),
        {
          model: 'm',
          messages: question
        }
      )
      const iterator = stream[Symbol.asyncIterator]()
      const first = iterator.next()
      server().advance()
      expect(await first).toMatchObject({ value: { type: 'text', text: 'one' } })
      controller.abort()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' })
      await expect
        .poll(() => server().requests[0]?.abortedAt ?? null, { timeout: 5_000 })
        .not.toBeNull()
    })

    it('turns an outage into a retryable provider error', async () => {
      server().reset()
      server().failAll(503)
      const failure = await collect(
        adapter.streamChat(context(server().baseUrl, apiKey), { model: 'm', messages: question })
      ).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'PROVIDER_SERVER_ERROR', retryable: true })
      server().failAll(null)
    })
  }
)

describe('OpenAI-compatible specifics', () => {
  it('computes embeddings in input order', async () => {
    openai.reset()
    openai.requireKey(null)
    const adapter = openAiCompatibleAdapter()
    const result = await adapter.embed?.(context(openai.baseUrl, null), {
      model: 'e',
      inputs: ['a', 'b']
    })
    expect(result?.vectors).toEqual([
      [0, 0.5, 1],
      [1, 0.5, 1]
    ])
  })

  it('sends structured-output and tool definitions in the protocol shape', async () => {
    openai.reset()
    await collect(
      openAiCompatibleAdapter().streamChat(context(openai.baseUrl, null), {
        model: 'm',
        messages: question,
        tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
        responseFormat: { name: 'answer', schema: { type: 'object' } }
      })
    )
    expect(openai.requests[0]?.body).toMatchObject({
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } }
    })
  })
})

describe('Anthropic specifics', () => {
  it('moves system text to its own field and merges turns so roles alternate', () => {
    const converted = toAnthropicMessages([
      { role: 'system', text: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'One' }] },
      { role: 'user', content: [{ type: 'text', text: 'Two' }] },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ callId: 't1', name: 'x', arguments: 'not json' }]
      },
      { role: 'tool', callId: 't1', content: 'result' }
    ])
    expect(converted.system).toBe('Be brief.')
    expect(converted.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(converted.messages[0]?.content).toHaveLength(2)
    expect(converted.messages[1]?.content[0]).toMatchObject({ type: 'tool_use', input: {} })
  })
})

describe('Local only, at the network boundary', () => {
  it('sends nothing — not even a connection — to an address that is not on this computer', async () => {
    const address = nonLoopbackAddress()
    if (!address) throw new Error('this test needs a non-loopback network interface')
    const cloud = await startOpenAiCompatibleServer({ host: address })
    try {
      const adapter = openAiCompatibleAdapter()
      const local = context(cloud.baseUrl, null, { mode: 'LOCAL_ONLY' })
      await expect(adapter.listModels(local)).rejects.toMatchObject({
        code: 'PRIVACY_MODE_BLOCKED'
      })
      await expect(
        collect(adapter.streamChat(local, { model: 'm', messages: question }))
      ).rejects.toMatchObject({
        code: 'PRIVACY_MODE_BLOCKED'
      })
      expect(cloud.connections()).toBe(0)
      expect(cloud.requests).toEqual([])
      // The same server is reachable when the mode allows it.
      expect(await adapter.listModels(context(cloud.baseUrl, null, { mode: 'AUTO' }))).toHaveLength(
        1
      )
      expect(cloud.connections()).toBe(1)
    } finally {
      await cloud.close()
    }
  })
})

describe('OpenAI-compatible speech (SET 12)', () => {
  const tone = () => {
    const samples = new Int16Array(16_000)
    for (let index = 0; index < samples.length; index++)
      samples[index] = Math.round(Math.sin((2 * Math.PI * 300 * index) / 16_000) * 6_000)
    return toWav(samples, 16_000)
  }

  it('uploads the recording as multipart and returns the transcript', async () => {
    openai.reset()
    openai.requireKey(key)
    openai.transcribe({ text: '  What is the largest planet?  ', language: 'english' })
    const adapter = openAiCompatibleAdapter()
    const result = await adapter.transcribe?.(context(openai.baseUrl, key), {
      model: 'stt-model',
      audio: tone(),
      language: 'en'
    })
    expect(result).toEqual({ text: 'What is the largest planet?', language: 'english' })
    expect(openai.audio).toEqual([
      {
        model: 'stt-model',
        language: 'en',
        bytes: 32_044,
        wav: expect.objectContaining({ sampleRate: 16_000, durationMs: 1_000 }) as unknown
      }
    ])
    openai.requireKey(null)
  })

  it('returns synthesized speech as WAV bytes, and refuses a reply that is not audio', async () => {
    openai.reset()
    openai.setSpeech(tone())
    const adapter = openAiCompatibleAdapter()
    const speech = await adapter.synthesize?.(context(openai.baseUrl, null), {
      model: 'tts-model',
      text: 'Hello',
      voice: null,
      speed: 1.25
    })
    expect(speech?.mediaType).toBe('audio/wav')
    expect(wavStats(speech?.audio ?? new Uint8Array())?.durationMs).toBe(1_000)
    const request = openai.requests.find((item) => item.path === '/v1/audio/speech')
    expect(request?.body).toEqual({
      model: 'tts-model',
      input: 'Hello',
      voice: 'alloy',
      speed: 1.25,
      response_format: 'wav'
    })
    openai.setSpeech(new TextEncoder().encode('not audio at all, just text'))
    await expect(
      adapter.synthesize?.(context(openai.baseUrl, null), {
        model: 'tts-model',
        text: 'Hello',
        voice: null,
        speed: 1
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' })
  })

  it('never sends audio to the cloud under Local only', async () => {
    const address = nonLoopbackAddress()
    if (!address) throw new Error('This test needs a non-loopback network interface')
    const cloud = await startOpenAiCompatibleServer({ host: address })
    try {
      const adapter = openAiCompatibleAdapter()
      await expect(
        adapter.transcribe?.(context(cloud.baseUrl, null, { mode: 'LOCAL_ONLY' }), {
          model: 'stt-model',
          audio: tone(),
          language: null
        })
      ).rejects.toMatchObject({ code: 'PRIVACY_MODE_BLOCKED' })
      expect(cloud.connections()).toBe(0)
    } finally {
      await cloud.close()
    }
  })
})
