import type { ChatChunk, ChatRequest, ConnectionResult, ModelInfo } from '@shared/schemas.js'
import { httpJson, httpRequest, joinUrl, readSse } from './http.js'
import { ProviderError, type ModelProvider, type ProviderRuntimeConfig, type ToolSpec } from './types.js'

const API_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

/** Anthropic Messages API. */
export class AnthropicProvider implements ModelProvider {
  readonly id: string
  readonly kind = 'anthropic'
  readonly requiresApiKey = true

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.id = config.id
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.config.apiKey ?? '',
      'anthropic-version': API_VERSION,
      // Without this the API rejects browser-origin requests from Electron.
      'anthropic-dangerous-direct-browser-access': 'true'
    }
  }

  private assertKey(): void {
    if (!this.config.apiKey) {
      throw new ProviderError(
        `No API key is set for "${this.config.label}"`,
        'Add the key in Settings → AI Providers, then test the connection again.'
      )
    }
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionResult> {
    const started = Date.now()
    try {
      this.assertKey()
      const models = await this.listModels(signal)
      return {
        ok: true,
        message: `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available`,
        latencyMs: Date.now() - started
      }
    } catch (err) {
      const error = err as ProviderError
      return { ok: false, message: error.message, detail: error.detail, latencyMs: Date.now() - started }
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.assertKey()
    const url = joinUrl(this.config.baseUrl, 'models?limit=100')
    const payload = await httpJson<{ data?: { id: string; display_name?: string }[] }>(url, {
      headers: this.headers(),
      signal
    })
    if (!Array.isArray(payload.data)) {
      throw new ProviderError(
        'Anthropic did not return a model list in the expected format',
        'Expected an object with a "data" array from /v1/models.'
      )
    }
    return payload.data.map((entry) => ({ id: entry.id, label: entry.display_name ?? entry.id }))
  }

  async *chat(request: ChatRequest, tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    this.assertKey()
    const url = joinUrl(this.config.baseUrl, 'messages')

    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const conversation = request.messages.filter((message) => message.role !== 'system')

    const response = await httpRequest(url, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: {
        model: request.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        ...(system ? { system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        messages: conversation.map((message) => ({
          role: message.role,
          content: message.content
        })),
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters
              }))
            }
          : {})
      }
    })

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
    let finishReason: string | undefined
    let usage: { inputTokens?: number; outputTokens?: number } | undefined

    for await (const data of readSse(response)) {
      let event: AnthropicStreamEvent
      try {
        event = JSON.parse(data) as AnthropicStreamEvent
      } catch {
        continue
      }

      switch (event.type) {
        case 'error':
          yield {
            type: 'error',
            message: event.error?.message ?? 'Anthropic reported an error',
            detail: event.error?.type
          }
          return
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            toolBlocks.set(event.index ?? 0, {
              id: event.content_block.id ?? '',
              name: event.content_block.name ?? '',
              json: ''
            })
          }
          break
        case 'content_block_delta': {
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text', text: delta.text }
          } else if (delta?.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index ?? 0)
            if (block) block.json += delta.partial_json ?? ''
          }
          break
        }
        case 'message_delta':
          if (event.delta?.stop_reason) finishReason = event.delta.stop_reason
          if (event.usage?.output_tokens !== undefined) {
            usage = { ...usage, outputTokens: event.usage.output_tokens }
          }
          break
        case 'message_start':
          if (event.message?.usage?.input_tokens !== undefined) {
            usage = { ...usage, inputTokens: event.message.usage.input_tokens }
          }
          break
        default:
          break
      }
    }

    for (const block of toolBlocks.values()) {
      if (!block.name) continue
      let args: Record<string, unknown> = {}
      if (block.json.trim()) {
        try {
          args = JSON.parse(block.json) as Record<string, unknown>
        } catch {
          args = { __unparsed: block.json }
        }
      }
      yield { type: 'tool_call', id: block.id || `call_${block.name}`, name: block.name, arguments: args }
    }

    yield { type: 'done', finishReason, usage }
  }
}

interface AnthropicStreamEvent {
  type: string
  index?: number
  error?: { message?: string; type?: string }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
  message?: { usage?: { input_tokens?: number } }
}
