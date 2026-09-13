import type { ChatChunk, ChatRequest, ConnectionResult, ModelInfo } from '@shared/schemas.js'
import { httpJson, httpRequest, joinUrl, readSse } from './http.js'
import { ProviderError, type ModelProvider, type ProviderRuntimeConfig, type ToolSpec } from './types.js'

/** Google Gemini generateContent / streamGenerateContent. */
export class GeminiProvider implements ModelProvider {
  readonly id: string
  readonly kind = 'gemini'
  readonly requiresApiKey = true

  constructor(private readonly config: ProviderRuntimeConfig) {
    this.id = config.id
  }

  private assertKey(): void {
    if (!this.config.apiKey) {
      throw new ProviderError(
        `No API key is set for "${this.config.label}"`,
        'Add the key in Settings → AI Providers, then test the connection again.'
      )
    }
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.config.apiKey ?? '' }
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
    const url = joinUrl(this.config.baseUrl, 'models?pageSize=200')
    const payload = await httpJson<{
      models?: {
        name: string
        displayName?: string
        inputTokenLimit?: number
        supportedGenerationMethods?: string[]
      }[]
    }>(url, { headers: this.headers(), signal })

    if (!Array.isArray(payload.models)) {
      throw new ProviderError(
        'Gemini did not return a model list in the expected format',
        'Expected an object with a "models" array.'
      )
    }
    return payload.models
      .filter(
        (model) =>
          !model.supportedGenerationMethods ||
          model.supportedGenerationMethods.includes('generateContent')
      )
      .map((model) => ({
        // Gemini ids come back as "models/gemini-..."; strip the prefix.
        id: model.name.replace(/^models\//, ''),
        label: model.displayName ?? model.name.replace(/^models\//, ''),
        contextWindow: model.inputTokenLimit ?? null
      }))
  }

  async *chat(request: ChatRequest, tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    this.assertKey()
    const model = request.model.replace(/^models\//, '')
    const url = joinUrl(this.config.baseUrl, `models/${model}:streamGenerateContent?alt=sse`)

    const systemText = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')

    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        // Gemini calls the assistant "model".
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      }))

    const response = await httpRequest(url, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        generationConfig: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {})
        },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                  }))
                }
              ]
            }
          : {})
      }
    })

    let finishReason: string | undefined
    let callIndex = 0

    for await (const data of readSse(response)) {
      let event: GeminiStreamEvent
      try {
        event = JSON.parse(data) as GeminiStreamEvent
      } catch {
        continue
      }
      if (event.error) {
        yield { type: 'error', message: event.error.message ?? 'Gemini reported an error' }
        return
      }
      const candidate = event.candidates?.[0]
      if (!candidate) continue
      if (candidate.finishReason) finishReason = candidate.finishReason

      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          yield { type: 'text', text: part.text }
        }
        if (part.functionCall?.name) {
          yield {
            type: 'tool_call',
            id: `call_${part.functionCall.name}_${callIndex++}`,
            name: part.functionCall.name,
            arguments: (part.functionCall.args ?? {}) as Record<string, unknown>
          }
        }
      }
    }

    yield { type: 'done', finishReason }
  }
}

interface GeminiStreamEvent {
  error?: { message?: string }
  candidates?: {
    finishReason?: string
    content?: {
      parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[]
    }
  }[]
}
