import { z } from 'zod'
import type { AdapterInfo, FinishReason, TokenUsage } from '@jupiter/contracts'
import {
  JupiterError,
  ProviderError,
  invalidResponse,
  sanitizeProviderText,
  type AdapterContext,
  type AdapterMessage,
  type ChatChunk,
  type ChatRequest,
  type DiscoveredModel,
  type EmbeddingRequest,
  type EmbeddingResult,
  type ProviderAdapter
} from '@jupiter/core'
import { endpoint, interrupted, isEventStream, readJson, send } from './http'
import { readSse } from './sse'

/**
 * Adapter for the OpenAI-compatible chat-completions protocol.
 *
 * One protocol, many endpoints: servers on this computer (Ollama, LM Studio,
 * llama.cpp, vLLM…) and cloud services that offer the same API. The person
 * gives the base address (e.g. `http://127.0.0.1:11434/v1`); a key is
 * optional because local servers usually need none.
 *
 * Hidden reasoning (`reasoning_content` / `reasoning` in the stream) is
 * dropped here and never reaches Jupiter; only its token count is kept.
 */

export const OPENAI_COMPATIBLE_INFO: AdapterInfo = {
  adapterId: 'openai-compatible',
  displayName: 'OpenAI-compatible API',
  description:
    'Any endpoint that speaks the OpenAI chat-completions protocol: a server on this computer (for example Ollama, LM Studio or llama.cpp) or a cloud service that offers the same API.',
  operations: [
    'chat',
    'streaming',
    'reasoning',
    'vision',
    'embeddings',
    'tool-calling',
    'structured-output',
    'cancellation',
    'usage',
    'model-discovery'
  ],
  keyRequirement: 'optional',
  defaultBaseUrl: null,
  exampleBaseUrl: 'http://127.0.0.1:11434/v1'
}

const ModelList = z.object({
  data: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(160),
        name: z.string().max(120).optional(),
        context_length: z.number().int().positive().optional(),
        context_window: z.number().int().positive().optional(),
        pricing: z
          .looseObject({ prompt: z.string().optional(), completion: z.string().optional() })
          .optional()
      })
    )
    .max(2000)
})

const Usage = z.looseObject({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  completion_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .nullish()
})

const ToolCallDelta = z.looseObject({
  index: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  function: z
    .looseObject({ name: z.string().optional(), arguments: z.string().optional() })
    .optional()
})

const StreamChunk = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            tool_calls: z.array(ToolCallDelta).nullish()
          })
          .nullish(),
        finish_reason: z.string().nullish()
      })
    )
    .optional(),
  usage: Usage.nullish(),
  error: z.unknown().optional()
})

const Completion = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.looseObject({
                id: z.string(),
                function: z.looseObject({ name: z.string(), arguments: z.string() })
              })
            )
            .nullish()
        }),
        finish_reason: z.string().nullish()
      })
    )
    .min(1),
  usage: Usage.nullish()
})

const Embeddings = z.object({
  data: z.array(z.looseObject({ embedding: z.array(z.number()), index: z.number().int() })),
  usage: Usage.nullish()
})

function perMillion(price: string | undefined): number | null {
  if (price === undefined) return null
  const value = Number.parseFloat(price)
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null
}

function finishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'unknown'
  }
}

function usageOf(usage: z.infer<typeof Usage> | null | undefined): TokenUsage | null {
  if (!usage) return null
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null
  }
}

function headers(context: AdapterContext): Record<string, string> {
  return context.apiKey ? { authorization: `Bearer ${context.apiKey}` } : {}
}

function toWire(message: AdapterMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.text }
    case 'user': {
      const texts = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      return {
        role: 'user',
        content:
          texts.length === message.content.length
            ? texts.join('')
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : {
                      type: 'image_url',
                      image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` }
                    }
              )
      }
    }
    case 'assistant':
      return {
        role: 'assistant',
        content: message.text || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: call.arguments }
              }))
            }
          : {})
      }
    case 'tool':
      return { role: 'tool', tool_call_id: message.callId, content: message.content }
  }
}

export function openAiCompatibleAdapter(): ProviderAdapter {
  return {
    info: OPENAI_COMPATIBLE_INFO,

    async listModels(context: AdapterContext): Promise<DiscoveredModel[]> {
      const response = await send(context, {
        method: 'GET',
        url: endpoint(context.baseUrl, 'models'),
        headers: headers(context),
        providerName: context.providerName
      })
      const parsed = ModelList.safeParse(
        await readJson(response, context.providerName, context.signal)
      )
      if (!parsed.success)
        throw invalidResponse(context.providerName, 'the model list has an unexpected shape')
      return parsed.data.data.map((model) => ({
        modelId: model.id,
        displayName: model.name ?? null,
        capabilities: null,
        contextWindow: model.context_length ?? model.context_window ?? null,
        inputCostPerMillion: perMillion(model.pricing?.prompt),
        outputCostPerMillion: perMillion(model.pricing?.completion)
      }))
    },

    async *streamChat(context: AdapterContext, request: ChatRequest): AsyncGenerator<ChatChunk> {
      const response = await send(context, {
        method: 'POST',
        url: endpoint(context.baseUrl, 'chat/completions'),
        headers: headers(context),
        accept: 'text/event-stream, application/json',
        providerName: context.providerName,
        body: {
          model: request.model,
          messages: request.messages.map(toWire),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                  }
                }))
              }
            : {}),
          ...(request.responseFormat
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: request.responseFormat.name,
                    schema: request.responseFormat.schema,
                    strict: true
                  }
                }
              }
            : {}),
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {})
        }
      })

      // Some servers ignore `stream: true` and answer with one JSON body.
      if (!isEventStream(response)) {
        const parsed = Completion.safeParse(
          await readJson(response, context.providerName, context.signal)
        )
        if (!parsed.success)
          throw invalidResponse(context.providerName, 'the answer has an unexpected shape')
        const choice = parsed.data.choices[0]
        if (choice?.message.content) yield { type: 'text', text: choice.message.content }
        for (const call of choice?.message.tool_calls ?? [])
          yield {
            type: 'tool-call',
            callId: call.id,
            name: call.function.name,
            arguments: call.function.arguments
          }
        const usage = usageOf(parsed.data.usage)
        if (usage) yield { type: 'usage', usage }
        yield { type: 'finish', reason: finishReason(choice?.finish_reason) }
        return
      }

      const body = response.body
      if (!body) throw invalidResponse(context.providerName, 'the answer has no body')
      const calls = new Map<number, { callId: string; name: string; arguments: string }>()
      let reason: FinishReason | null = null
      let usage: TokenUsage | null = null
      try {
        for await (const message of readSse(body)) {
          if (message.data === '[DONE]') break
          let json: unknown
          try {
            json = JSON.parse(message.data)
          } catch {
            throw invalidResponse(context.providerName, 'a streamed piece is not JSON')
          }
          const chunk = StreamChunk.safeParse(json)
          if (!chunk.success)
            throw invalidResponse(context.providerName, 'a streamed piece has an unexpected shape')
          if (chunk.data.error !== undefined) {
            const text = JSON.stringify(chunk.data.error).slice(0, 2000)
            throw new ProviderError(
              'PROVIDER_SERVER_ERROR',
              `${context.providerName} reported an error while answering: ${sanitizeProviderText(text, [context.apiKey])}`
            )
          }
          usage = usageOf(chunk.data.usage) ?? usage
          for (const choice of chunk.data.choices ?? []) {
            const content = choice.delta?.content
            if (content) yield { type: 'text', text: content }
            for (const delta of choice.delta?.tool_calls ?? []) {
              const index = delta.index ?? 0
              const call = calls.get(index) ?? { callId: '', name: '', arguments: '' }
              if (delta.id) call.callId = delta.id
              if (delta.function?.name) call.name += delta.function.name
              if (delta.function?.arguments) call.arguments += delta.function.arguments
              calls.set(index, call)
            }
            if (choice.finish_reason) reason = finishReason(choice.finish_reason)
          }
        }
      } catch (error) {
        if (error instanceof JupiterError) throw error
        throw interrupted(context.providerName, context.signal, error)
      }
      for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        if (!call.name) throw invalidResponse(context.providerName, 'a tool call has no name')
        yield {
          type: 'tool-call',
          callId: call.callId || `call_${String(index)}`,
          name: call.name,
          arguments: call.arguments || '{}'
        }
      }
      if (usage) yield { type: 'usage', usage }
      yield { type: 'finish', reason: reason ?? 'unknown' }
    },

    async embed(context: AdapterContext, request: EmbeddingRequest): Promise<EmbeddingResult> {
      const response = await send(context, {
        method: 'POST',
        url: endpoint(context.baseUrl, 'embeddings'),
        headers: headers(context),
        providerName: context.providerName,
        body: { model: request.model, input: request.inputs }
      })
      const parsed = Embeddings.safeParse(
        await readJson(response, context.providerName, context.signal)
      )
      if (!parsed.success || parsed.data.data.length !== request.inputs.length)
        throw invalidResponse(context.providerName, 'the embeddings have an unexpected shape')
      const vectors = [...parsed.data.data]
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding)
      return { vectors, usage: usageOf(parsed.data.usage) }
    }
  }
}
