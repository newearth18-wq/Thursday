import { z } from 'zod'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * AI providers, models and routing (SET 3).
 *
 * A *provider adapter* is code that speaks one provider protocol (for
 * example the OpenAI-compatible chat API). A *provider* is an endpoint the
 * person configured with one of the installed adapters. Jupiter Core only
 * knows adapters through their description here and the adapter port in
 * `@jupiter/core`; which adapters exist is decided where Core is assembled.
 *
 * Nothing in this file names a commercial provider: availability comes only
 * from what the person configured.
 */

export const ProviderId = Uuidv7
export type ProviderId = z.infer<typeof ProviderId>

/** Adapter identifier, e.g. `openai-compatible`. */
export const AdapterId = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Expected a kebab-case adapter id')
export type AdapterId = z.infer<typeof AdapterId>

/** A model identifier as the provider names it (`llama3.2:latest`, `org/model-7b`, …). */
export const ModelId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\x21-\x7e]+$/, 'Expected a model id without spaces')
export type ModelId = z.infer<typeof ModelId>

/** What a model can do, as far as Jupiter routes requests. */
export const ModelCapability = z.enum([
  'chat',
  'reasoning',
  'vision',
  'embeddings',
  'tools',
  'structured-output'
])
export type ModelCapability = z.infer<typeof ModelCapability>

/** Operations an adapter implements. */
export const AdapterOperation = z.enum([
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
])
export type AdapterOperation = z.infer<typeof AdapterOperation>

/**
 * Where an endpoint is. Derived from its address, never from what anyone
 * claims: only loopback addresses (`localhost`, 127.0.0.0/8, `::1`) are on
 * this device. Everything else — including other machines on the local
 * network — is treated as `cloud`, because Jupiter cannot verify where it is.
 */
export const Locality = z.enum(['this-device', 'cloud'])
export type Locality = z.infer<typeof Locality>

export const RoutingMode = z.enum(['AUTO', 'CLOUD', 'HYBRID', 'LOCAL_ONLY'])
export type RoutingMode = z.infer<typeof RoutingMode>

/**
 * What may happen when the chosen model fails before it produced anything:
 * - `never`: fail, and say so;
 * - `same-locality`: try another model at the same locality (never local → cloud);
 * - `allowed-by-mode`: try any model the routing mode allows.
 * Every fallback is recorded and shown with the answer.
 */
export const FallbackPolicy = z.enum(['never', 'same-locality', 'allowed-by-mode'])
export type FallbackPolicy = z.infer<typeof FallbackPolicy>

/** Tie-breaker between suitable models; applies only where cost or measured latency is known. */
export const CostLatencyPreference = z.enum(['balanced', 'lower-cost', 'lower-latency'])
export type CostLatencyPreference = z.infer<typeof CostLatencyPreference>

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/

/** The parts of a WHATWG URL used here. Contracts carry no DOM or Node typings, so it is typed locally. */
interface ParsedUrl {
  readonly protocol: string
  readonly hostname: string
  readonly username: string
  readonly password: string
  readonly search: string
  readonly hash: string
}

function parseUrl(value: string): ParsedUrl | null {
  const Url = (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL
  try {
    return new Url(value)
  } catch {
    return null
  }
}

/** True for addresses that can only reach this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || LOOPBACK_V4.test(host) || host === '[::1]' || host === '::1'
}

export function localityOf(url: string): Locality {
  const parsed = parseUrl(url)
  return parsed && isLoopbackHost(parsed.hostname) ? 'this-device' : 'cloud'
}

/** True when traffic to this address is encrypted (https) or never leaves the computer. */
export function isProtectedTransport(url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed) return false
  return parsed.protocol === 'https:' || isLoopbackHost(parsed.hostname)
}

function isAcceptableBaseUrl(value: string): boolean {
  const url = parseUrl(value)
  return (
    url !== null &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  )
}

/** A provider endpoint: http(s), and never with a user name, password, query or fragment in it. */
export const ProviderBaseUrl = z.string().trim().min(8).max(512).refine(isAcceptableBaseUrl, {
  message: 'Expected an http:// or https:// address without a user name, password or query'
})
export type ProviderBaseUrl = z.infer<typeof ProviderBaseUrl>

/**
 * A reference to one model of one provider, `<providerId>:<modelId>`. Used
 * where a single string is stored (settings, conversation routing).
 */
export const ModelRef = z
  .string()
  .max(200)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[\x21-\x7e]{1,160}$/,
    'Expected <providerId>:<modelId>'
  )
export type ModelRef = z.infer<typeof ModelRef>

export function modelRef(providerId: string, modelId: string): ModelRef {
  return `${providerId}:${modelId}`
}

export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  if (!ModelRef.safeParse(ref).success) return null
  return { providerId: ref.slice(0, 36), modelId: ref.slice(37) }
}

/** Installed adapter, as the interface may show it. */
export const AdapterInfo = z
  .object({
    adapterId: AdapterId,
    displayName: z.string().min(1).max(80),
    description: z.string().max(400),
    operations: z.array(AdapterOperation).max(16),
    /** Whether a provider of this kind needs an API key. */
    keyRequirement: z.enum(['required', 'optional', 'none']),
    /** Suggested address, if the protocol has a usual one; the person can change it. */
    defaultBaseUrl: ProviderBaseUrl.nullable(),
    /** Address the person is shown as an example when there is no default. */
    exampleBaseUrl: z.string().max(200).nullable()
  })
  .strict()
export type AdapterInfo = z.infer<typeof AdapterInfo>

/** An API key as the interface may know it: never the key itself. */
export const CredentialInfo = z
  .object({
    saved: z.boolean(),
    /** First 8 hex characters of the key's SHA-256: tells keys apart, reveals nothing. */
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .nullable(),
    savedAt: UtcTimestamp.nullable(),
    validation: z.enum(['not-validated', 'valid', 'rejected', 'unknown']),
    lastValidatedAt: UtcTimestamp.nullable()
  })
  .strict()
export type CredentialInfo = z.infer<typeof CredentialInfo>

export const ModelInfo = z
  .object({
    providerId: ProviderId,
    modelId: ModelId,
    displayName: z.string().max(120).nullable(),
    capabilities: z.array(ModelCapability).max(6),
    /** `provider`: reported by the provider; `user`: chosen by the person; `none`: not known yet. */
    capabilitySource: z.enum(['provider', 'user', 'none']),
    enabled: z.boolean(),
    /** Found through the provider's model list (true) or added by hand (false). */
    discovered: z.boolean(),
    contextWindow: z.number().int().positive().nullable(),
    /** Price per million tokens in USD, only when the provider reports it. */
    inputCostPerMillion: z.number().nonnegative().nullable(),
    outputCostPerMillion: z.number().nonnegative().nullable(),
    /** Measured time to the first streamed token, averaged over recent replies. */
    observedLatencyMs: z.number().nonnegative().nullable(),
    updatedAt: UtcTimestamp
  })
  .strict()
export type ModelInfo = z.infer<typeof ModelInfo>

/**
 * Provider state, established only by real checks:
 * - `not-checked`: nothing was tried yet;
 * - `ready`: the last check reached the provider (and it accepted the key, if one is needed);
 * - `needs-key`: the adapter needs an API key and none is saved;
 * - `failed`: the last check failed (see `error`);
 * - `blocked`: the routing mode does not allow this provider (Local only and a cloud endpoint);
 * - `adapter-missing`: the adapter this provider was set up with is not installed in this build.
 */
export const ProviderState = z.enum([
  'not-checked',
  'ready',
  'needs-key',
  'failed',
  'blocked',
  'adapter-missing'
])
export type ProviderState = z.infer<typeof ProviderState>

export const ProviderInfo = z
  .object({
    providerId: ProviderId,
    adapterId: AdapterId,
    displayName: z.string().min(1).max(80),
    baseUrl: ProviderBaseUrl,
    locality: Locality,
    /** False when the address is not loopback and not https: keys and prompts would travel unencrypted. */
    encrypted: z.boolean(),
    enabled: z.boolean(),
    state: ProviderState,
    error: ErrorEnvelope.nullable(),
    checkedAt: UtcTimestamp.nullable(),
    credential: CredentialInfo,
    models: z.array(ModelInfo).max(500),
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp
  })
  .strict()
export type ProviderInfo = z.infer<typeof ProviderInfo>

/** An API key on its way to secure storage. Printable characters only; it never comes back. */
export const ApiKeyInput = z
  .string()
  .trim()
  .min(8)
  .max(512)
  .regex(/^[\x21-\x7e]+$/, 'An API key has no spaces or special characters')

export const RouteReason = z.enum([
  /** The conversation is pinned to this model. */
  'conversation-model',
  /** The person's preferred model for this capability. */
  'preferred-model',
  /** A model of the person's preferred provider. */
  'preferred-provider',
  /** The best remaining model that can do it. */
  'best-available'
])
export type RouteReason = z.infer<typeof RouteReason>

export const RouteDecision = z
  .object({
    providerId: ProviderId,
    providerName: z.string().max(80),
    modelId: ModelId,
    modelName: z.string().max(120).nullable(),
    locality: Locality,
    capability: ModelCapability,
    mode: RoutingMode,
    reason: RouteReason,
    /** Set when this model was used because another one failed. */
    fallbackFrom: z
      .object({
        providerId: ProviderId,
        providerName: z.string().max(80),
        modelId: ModelId,
        errorCode: z.string().max(64)
      })
      .strict()
      .nullable()
  })
  .strict()
export type RouteDecision = z.infer<typeof RouteDecision>

/** Where secrets are kept on this computer. */
export const SecureStorageStatus = z
  .object({
    available: z.boolean(),
    /** e.g. `dpapi` (Windows), `keychain`, `gnome-libsecret`, `kwallet`; `unavailable` when none. */
    backend: z.string().max(40),
    /** Why it is unavailable, in plain language. Null when available. */
    reason: z.string().max(400).nullable()
  })
  .strict()
export type SecureStorageStatus = z.infer<typeof SecureStorageStatus>
