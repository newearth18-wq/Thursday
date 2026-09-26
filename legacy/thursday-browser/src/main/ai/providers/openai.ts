import type { ChatChunk, ChatRequest, ConnectionResult, ModelInfo } from '@shared/schemas.js'
import { httpJson, httpRequest, joinUrl, readSse } from './http.js'
import { ProviderError, type ModelProvider, type ProviderRuntimeConfig, type ToolSpec } from './types.js'

/**
 * OpenAI Chat Completions.
 *
 * The same wire format is used by "OpenAI-compatible" endpoints and by
 * LM Studio, so those kinds reuse this adapter with a different base URL and
 * a different API-key requirement.
 */
export class OpenAiProvider implements ModelProvider {
  readonly id: string

  constructor(
    private readonly config: ProviderRuntimeConfig,
    readonly kind: string = 'openai',
    readonly requiresApiKey: boolean = true
  ) {
    this.id = config.id
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    return headers
  }

  private assertKey(): void {
    if (this.requiresApiKey && !this.config.apiKey) {
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
      return {
        ok: false,
        message: error.message,
        detail: error.detail,
        latencyMs: Date.now() - started
      }
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.assertKey()
    const url = joinUrl(this.config.baseUrl, 'models')
    const payload = await httpJson<{ data?: { id: string }[] }>(url, {
      headers: this.headers(),
      signal
    })
    const data = payload.data
    if (!Array.isArray(data)) {
      throw new ProviderError(
        `${new URL(url).host} did not return a model list in the expected format`,
        'Expected an object with a "data" array, as used by the OpenAI /models endpoint.'
      )
    }
    return data
      .filter((entry) => typeof entry?.id === 'string')
      .map((entry) => ({ id: entry.id, label: entry.id }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async *chat(request: ChatRequest, tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    this.assertKey()
    const url = joinUrl(this.config.baseUrl, 'chat/completions')

    const response = await httpRequest(url, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: {
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters
                }
              }))
            }
          : {})
      }
    })

    // tool_calls arrive in fragments and must be reassembled by index.
    const partialToolCalls = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: string | undefined

    for await (const data of readSse(response)) {
      if (data === '[DONE]') break
      let event: OpenAiStreamEvent
      try {
        event = JSON.parse(data) as OpenAiStreamEvent
      } catch {
        continue
      }
      if (event.error) {
        yield { type: 'error', message: event.error.message ?? 'The provider reported an error' }
        return
      }

      const choice = event.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason

      const text = choice.delta?.content
      if (typeof text === 'string' && text.length > 0) yield { type: 'text', text }

      for (const fragment of choice.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0
        const existing = partialToolCalls.get(index) ?? { id: '', name: '', args: '' }
        if (fragment.id) existing.id = fragment.id
        if (fragment.function?.name) existing.name = fragment.function.name
        if (fragment.function?.arguments) existing.args += fragment.function.arguments
        partialToolCalls.set(index, existing)
      }
    }

    for (const call of partialToolCalls.values()) {
      if (!call.name) continue
      yield {
        type: 'tool_call',
        id: call.id || `call_${call.name}`,
        name: call.name,
        arguments: parseToolArguments(call.args)
      }
    }

    yield { type: 'done', finishReason }
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    return { __unparsed: raw }
  }
}

interface OpenAiStreamEvent {
  error?: { message?: string }
  choices?: {
    finish_reason?: string | null
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
}
