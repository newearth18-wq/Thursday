import { z } from 'zod'
import type { AdapterInfo, FinishReason } from '@jupiter/contracts'
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
  type ProviderAdapter
} from '@jupiter/core'
import { endpoint, interrupted, readJson, send } from './http'
import { readSse } from './sse'

/**
 * Adapter for the Anthropic Messages API.
 *
 * Differences from the OpenAI-compatible protocol that stay inside this file:
 * the system prompt is a separate field, roles must alternate, tool calls and
 * results are content blocks, and the stream is a sequence of typed events.
 * Extended-thinking blocks are dropped: hidden reasoning never reaches Jupiter.
 */

const API_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

export const ANTHROPIC_INFO: AdapterInfo = {
  adapterId: 'anthropic',
  displayName: 'Anthropic Messages API',
  description: 'Models served through the Anthropic Messages API. Needs an API key.',
  operations: [
    'chat',
    'streaming',
    'reasoning',
    'vision',
    'tool-calling',
    'cancellation',
    'usage',
    'model-discovery'
  ],
  keyRequirement: 'required',
  defaultBaseUrl: 'https://api.anthropic.com',
  exampleBaseUrl: null
}

const ModelList = z.object({
  data: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(160),
        display_name: z.string().max(120).optional()
      })
    )
    .max(1000)
})

const Event = z.looseObject({
  type: z.string(),
  index: z.number().int().nonnegative().optional(),
  message: z
    .looseObject({ usage: z.looseObject({ input_tokens: z.number().int().optional() }).optional() })
    .optional(),
  content_block: z
    .looseObject({ type: z.string(), id: z.string().optional(), name: z.string().optional() })
    .optional(),
  delta: z
    .looseObject({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
      stop_reason: z.string().nullish()
    })
    .optional(),
  usage: z.looseObject({ output_tokens: z.number().int().optional() }).optional(),
  error: z.unknown().optional()
})

function finishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool-calls'
    case 'refusal':
      return 'content-filter'
    default:
      return 'unknown'
  }
}

function headers(context: AdapterContext): Record<string, string> {
  return {
    'anthropic-version': API_VERSION,
    ...(context.apiKey ? { 'x-api-key': context.apiKey } : {})
  }
}

type Block = Record<string, unknown>

/** Tool arguments as an object; arguments that are not valid JSON become `{}`. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || '{}') as unknown
  } catch {
    return {}
  }
}

/** Messages API needs a separate system prompt and strictly alternating user/assistant turns. */
export function toAnthropicMessages(messages: readonly AdapterMessage[]): {
  system: string | null
  messages: { role: 'user' | 'assistant'; content: Block[] }[]
} {
  const system: string[] = []
  const turns: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (blocks.length === 0) return
    const last = turns.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system.push(message.text)
        break
      case 'user':
        push(
          'user',
          message.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image',
                  source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 }
                }
          )
        )
        break
      case 'assistant': {
        const blocks: Block[] = message.text ? [{ type: 'text', text: message.text }] : []
        for (const call of message.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: call.callId,
            name: call.name,
            input: parseArguments(call.arguments)
          })
        }
        push('assistant', blocks)
        break
      }
      case 'tool':
        push('user', [
          { type: 'tool_result', tool_use_id: message.callId, content: message.content }
        ])
        break
    }
  }
  return { system: system.length > 0 ? system.join('\n\n') : null, messages: turns }
}

export function anthropicAdapter(): ProviderAdapter {
  return {
    info: ANTHROPIC_INFO,

    async listModels(context: AdapterContext): Promise<DiscoveredModel[]> {
      const url = endpoint(context.baseUrl, 'v1/models')
      url.searchParams.set('limit', '100')
      const response = await send(context, {
        method: 'GET',
        url,
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
        displayName: model.display_name ?? null,
        capabilities: null,
        contextWindow: null,
        inputCostPerMillion: null,
        outputCostPerMillion: null
      }))
    },

    async *streamChat(context: AdapterContext, request: ChatRequest): AsyncGenerator<ChatChunk> {
      if (request.responseFormat)
        throw new JupiterError(
          'UNSUPPORTED_OPERATION',
          `${context.providerName} (Anthropic Messages API) does not offer structured output through this adapter.`,
          { category: 'unsupported', userAction: 'Use a model from another provider for this.' }
        )
      const { system, messages } = toAnthropicMessages(request.messages)
      const response = await send(context, {
        method: 'POST',
        url: endpoint(context.baseUrl, 'v1/messages'),
        headers: headers(context),
        accept: 'text/event-stream',
        providerName: context.providerName,
        body: {
          model: request.model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
          messages,
          ...(system ? { system } : {}),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters
                }))
              }
            : {}),
          stream: true
        }
      })
      const body = response.body
      if (!body) throw invalidResponse(context.providerName, 'the answer has no body')

      const blocks = new Map<number, { type: string; id: string; name: string; json: string }>()
      let inputTokens: number | null = null
      let outputTokens: number | null = null
      let reason: FinishReason | null = null
      try {
        for await (const message of readSse(body)) {
          let json: unknown
          try {
            json = JSON.parse(message.data)
          } catch {
            throw invalidResponse(context.providerName, 'a streamed event is not JSON')
          }
          const event = Event.safeParse(json)
          if (!event.success)
            throw invalidResponse(context.providerName, 'a streamed event has an unexpected shape')
          const data = event.data
          switch (data.type) {
            case 'message_start':
              inputTokens = data.message?.usage?.input_tokens ?? inputTokens
              break
            case 'content_block_start':
              if (data.index !== undefined && data.content_block)
                blocks.set(data.index, {
                  type: data.content_block.type,
                  id: data.content_block.id ?? '',
                  name: data.content_block.name ?? '',
                  json: ''
                })
              break
            case 'content_block_delta': {
              const block = data.index === undefined ? undefined : blocks.get(data.index)
              if (data.delta?.type === 'text_delta' && data.delta.text)
                yield { type: 'text', text: data.delta.text }
              else if (data.delta?.type === 'input_json_delta' && block)
                block.json += data.delta.partial_json ?? ''
              // thinking_delta / signature_delta: hidden reasoning, dropped on purpose.
              break
            }
            case 'content_block_stop': {
              const block = data.index === undefined ? undefined : blocks.get(data.index)
              if (block?.type === 'tool_use')
                yield {
                  type: 'tool-call',
                  callId: block.id || `call_${String(data.index)}`,
                  name: block.name,
                  arguments: block.json || '{}'
                }
              break
            }
            case 'message_delta':
              if (data.delta?.stop_reason) reason = finishReason(data.delta.stop_reason)
              outputTokens = data.usage?.output_tokens ?? outputTokens
              break
            case 'error': {
              const text = JSON.stringify(data.error ?? {}).slice(0, 2000)
              throw new ProviderError(
                'PROVIDER_SERVER_ERROR',
                `${context.providerName} reported an error while answering: ${sanitizeProviderText(text, [context.apiKey])}`
              )
            }
            default:
              // message_stop, ping and future event types carry nothing Jupiter needs.
              break
          }
        }
      } catch (error) {
        if (error instanceof JupiterError) throw error
        throw interrupted(context.providerName, context.signal, error)
      }
      if (inputTokens !== null || outputTokens !== null)
        yield { type: 'usage', usage: { inputTokens, outputTokens, reasoningTokens: null } }
      yield { type: 'finish', reason: reason ?? 'unknown' }
    }
  }
}
