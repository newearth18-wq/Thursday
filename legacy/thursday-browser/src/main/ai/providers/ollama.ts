import type { ChatChunk, ChatRequest, ConnectionResult, ModelInfo } from '@shared/schemas.js'
import { httpJson, httpRequest, joinUrl, readNdJson } from './http.js'
import { ProviderError, type ModelProvider, type ProviderRuntimeConfig, type ToolSpec } from './types.js'

/**
 * Ollama. Runs locally, needs no API key, and streams newline-delimited JSON
 * rather than SSE.
 */
export class OllamaProvider implements ModelProvider {
  readonly id: string
  readonly kind = 'ollama'
  readonly requiresApiKey = false

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.id = config.id
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionResult> {
    const started = Date.now()
    try {
      const models = await this.listModels(signal)
      return {
        ok: true,
        message:
          models.length > 0
            ? `Connected — ${models.length} model${models.length === 1 ? '' : 's'} installed`
            : 'Connected, but no models are installed. Run `ollama pull llama3.2` to add one.',
        latencyMs: Date.now() - started
      }
    } catch (err) {
      const error = err as ProviderError
      return { ok: false, message: error.message, detail: error.detail, latencyMs: Date.now() - started }
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const url = joinUrl(this.config.baseUrl, 'api/tags')
    const payload = await httpJson<{ models?: { name: string; details?: { parameter_size?: string } }[] }>(
      url,
      { signal, timeoutMs: 10_000 }
    )
    if (!Array.isArray(payload.models)) {
      throw new ProviderError(
        'Ollama did not return a model list in the expected format',
        'Expected an object with a "models" array from /api/tags.'
      )
    }
    return payload.models.map((model) => ({
      id: model.name,
      label: model.details?.parameter_size ? `${model.name} (${model.details.parameter_size})` : model.name
    }))
  }

  async *chat(request: ChatRequest, tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const url = joinUrl(this.config.baseUrl, 'api/chat')
    const response = await httpRequest(url, {
      method: 'POST',
      signal,
      body: {
        model: request.model,
        stream: true,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        options: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {})
        },
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

    let callIndex = 0
    let finishReason: string | undefined

    for await (const line of readNdJson(response)) {
      let event: OllamaStreamEvent
      try {
        event = JSON.parse(line) as OllamaStreamEvent
      } catch {
        continue
      }
      if (event.error) {
        yield { type: 'error', message: `Ollama: ${event.error}` }
        return
      }

      const text = event.message?.content
      if (typeof text === 'string' && text.length > 0) yield { type: 'text', text }

      for (const call of event.message?.tool_calls ?? []) {
        if (!call.function?.name) continue
        yield {
          type: 'tool_call',
          id: `call_${call.function.name}_${callIndex++}`,
          name: call.function.name,
          arguments: (call.function.arguments ?? {}) as Record<string, unknown>
        }
      }

      if (event.done) {
        finishReason = event.done_reason ?? 'stop'
        yield {
          type: 'done',
          finishReason,
          usage: {
            inputTokens: event.prompt_eval_count ?? 0,
            outputTokens: event.eval_count ?? 0
          }
        }
        return
      }
    }

    yield { type: 'done', finishReason }
  }
}

interface OllamaStreamEvent {
  error?: string
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  message?: {
    content?: string
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[]
  }
}
