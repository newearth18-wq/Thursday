import type { ChatChunk, ChatRequest, ConnectionResult, ModelInfo } from '@shared/schemas.js'

/** A tool offered to the model for a turn, derived from the Skill Registry. */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool's input object. */
  parameters: Record<string, unknown>
}

export interface ProviderRuntimeConfig {
  id: string
  label: string
  baseUrl: string
  apiKey: string | null
}

/**
 * Every provider implements exactly this. The rest of Thursday talks to
 * providers only through this interface, so adding a provider never touches
 * the AI core, the chat layer or the UI.
 */
export interface ModelProvider {
  readonly id: string
  readonly kind: string
  /** Whether this provider needs an API key to work at all. */
  readonly requiresApiKey: boolean
  testConnection(signal?: AbortSignal): Promise<ConnectionResult>
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  chat(request: ChatRequest, tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ChatChunk>
}

/** Raised for any provider-side failure; the message is always actionable. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
