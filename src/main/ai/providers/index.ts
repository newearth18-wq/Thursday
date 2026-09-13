import type { ProviderKind } from '@shared/schemas.js'
import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'
import { OllamaProvider } from './ollama.js'
import { OpenAiProvider } from './openai.js'
import type { ModelProvider, ProviderRuntimeConfig } from './types.js'

export interface ProviderKindInfo {
  kind: ProviderKind
  label: string
  defaultBaseUrl: string
  requiresApiKey: boolean
  /** True when the provider runs on the user's own machine. */
  local: boolean
  hint: string
}

export const PROVIDER_KINDS: ProviderKindInfo[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    local: false,
    hint: 'Uses the Chat Completions API. Models are discovered from /models.'
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
    local: false,
    hint: 'Uses the Messages API. Models are discovered from /models.'
  },
  {
    kind: 'gemini',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
    local: false,
    hint: 'Uses streamGenerateContent. Models are discovered from /models.'
  },
  {
    kind: 'openai-compat',
    label: 'OpenAI-compatible',
    defaultBaseUrl: '',
    requiresApiKey: false,
    local: false,
    hint: 'Any endpoint that implements /chat/completions and /models. Set the full base URL including /v1.'
  },
  {
    kind: 'ollama',
    label: 'Ollama (local)',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    requiresApiKey: false,
    local: true,
    hint: 'Detected automatically when the Ollama server is running.'
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio (local)',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    requiresApiKey: false,
    local: true,
    hint: 'Start the LM Studio local server, then fetch models.'
  }
]

export function providerKindInfo(kind: ProviderKind): ProviderKindInfo {
  const info = PROVIDER_KINDS.find((entry) => entry.kind === kind)
  if (!info) throw new Error(`Unknown provider kind "${kind}"`)
  return info
}

/** Build the adapter for a stored provider row. */
export function createProvider(kind: ProviderKind, config: ProviderRuntimeConfig): ModelProvider {
  switch (kind) {
    case 'openai':
      return new OpenAiProvider(config, 'openai', true)
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'gemini':
      return new GeminiProvider(config)
    case 'openai-compat':
      // Some compatible servers want a key, some do not; never block on it.
      return new OpenAiProvider(config, 'openai-compat', false)
    case 'lmstudio':
      return new OpenAiProvider(config, 'lmstudio', false)
    case 'ollama':
      return new OllamaProvider(config)
    default: {
      const exhaustive: never = kind
      throw new Error(`Unhandled provider kind "${String(exhaustive)}"`)
    }
  }
}

export type { ModelProvider, ProviderRuntimeConfig, ToolSpec } from './types.js'
export { ProviderError } from './types.js'
