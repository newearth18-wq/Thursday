import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SettingDefaults,
  SettingDefinitions,
  type AdapterInfo,
  type ChatMessage,
  type Conversation,
  type DomainEvent,
  type EventFilter,
  type ModelCapability,
  type ProviderInfo,
  type RoutePreview,
  type SecureStorageStatus,
  type SettingKey,
  type SettingRecord,
  type SettingValue
} from '@jupiter/contracts'
import { request } from './api'
import { envelopeOf, type Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * Data for the AI Models and Chat screens (SET 3). Everything shown comes
 * from Jupiter Core — providers, models, routing, conversations — and is read
 * again whenever Core reports a change, so the screens never guess.
 */

export const AI_SETTING_KEYS = [
  'ai.routingMode',
  'ai.fallbackPolicy',
  'ai.costLatency',
  'ai.preferredProvider',
  'ai.preferredChatModel',
  'ai.preferredReasoningModel',
  'ai.preferredVisionModel',
  'ai.preferredEmbeddingModel'
] as const satisfies readonly SettingKey[]

export type AiSettingKey = (typeof AI_SETTING_KEYS)[number]
export type AiSettings = { readonly [K in AiSettingKey]: SettingValue<K> }

export function aiSettingsFrom(records: readonly SettingRecord[]): AiSettings {
  const values: Record<string, unknown> = {}
  for (const key of AI_SETTING_KEYS) {
    const record = records.find((item) => item.key === key)
    const parsed = SettingDefinitions[key].safeParse(record?.value)
    values[key] = parsed.success ? parsed.data : SettingDefaults[key]
  }
  return values as AiSettings
}

function filter(types: EventFilter['types'], streams: EventFilter['streams'] = null): EventFilter {
  return { types, streams, missionId: null }
}

const PROVIDER_EVENTS = filter(['ai.provider.changed', 'ai.route.blocked', 'settings.changed'])
const SETTINGS_EVENTS = filter(['settings.changed'])
const ROUTE_EVENTS = filter([
  'ai.provider.changed',
  'settings.changed',
  'chat.conversation.changed'
])
const CONVERSATION_LIST_EVENTS = filter(['chat.conversation.changed', 'chat.message.changed'])

/** A counter that goes up (at most once per `delayMs`) whenever `bump` is called. */
export function useBump(delayMs: number): [number, () => void] {
  const [version, setVersion] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const bump = useCallback(() => {
    timer.current ??= setTimeout(() => {
      timer.current = null
      setVersion((value) => value + 1)
    }, delayMs)
  }, [delayMs])
  return [version, bump]
}

/**
 * Runs `load` whenever `key` changes (null: not now). A reload keeps showing
 * the previous result until the new one arrives.
 */
export function useQuery<T>(
  key: string | null,
  load: () => Promise<T>
): [Loadable<T>, (change: (previous: T) => T) => void] {
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  }, [load])
  const [state, setState] = useState<Loadable<T>>({ state: 'loading' })
  useEffect(() => {
    if (key === null) return
    let active = true
    loader.current().then(
      (value) => {
        if (active) setState({ state: 'ready', value })
      },
      (error: unknown) => {
        if (active) setState({ state: 'error', error: envelopeOf(error) })
      }
    )
    return () => {
      active = false
    }
  }, [key])
  const update = useCallback((change: (previous: T) => T) => {
    setState((previous) =>
      previous.state === 'ready' ? { state: 'ready', value: change(previous.value) } : previous
    )
  }, [])
  return [state, update]
}

export function keyOf(
  coreSession: string | null,
  ...parts: (string | number | null)[]
): string | null {
  return coreSession === null ? null : [coreSession, ...parts.map(String)].join('|')
}

export function useAdapters(coreSession: string | null): Loadable<AdapterInfo[]> {
  const load = useCallback(async () => (await request('ai.adapters.list', {})).adapters, [])
  return useQuery(keyOf(coreSession), load)[0]
}

export function useSecureStorage(coreSession: string | null): Loadable<SecureStorageStatus> {
  const load = useCallback(() => request('host.credentials.status', {}), [])
  return useQuery(keyOf(coreSession), load)[0]
}

export interface ProvidersData {
  readonly providers: Loadable<ProviderInfo[]>
  /** Show a provider as a command returned it, before the change event arrives. */
  readonly replace: (provider: ProviderInfo) => void
}

export function useProviders(coreSession: string | null): ProvidersData {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(PROVIDER_EVENTS, bump, coreSession)
  const load = useCallback(async () => (await request('ai.providers.list', {})).providers, [])
  const [providers, update] = useQuery(keyOf(coreSession, opened, version), load)
  const replace = useCallback(
    (provider: ProviderInfo) => {
      update((previous) => {
        const index = previous.findIndex((item) => item.providerId === provider.providerId)
        if (index === -1) return [...previous, provider]
        const next = [...previous]
        next[index] = provider
        return next
      })
    },
    [update]
  )
  return { providers, replace }
}

export interface AiSettingsData {
  readonly settings: Loadable<AiSettings>
  update<K extends AiSettingKey>(key: K, value: SettingValue<K>): Promise<void>
}

export function useAiSettings(coreSession: string | null): AiSettingsData {
  const [version, bump] = useBump(50)
  const onEvent = useCallback(
    (event: DomainEvent) => {
      if (event.type === 'settings.changed' && event.payload.key.startsWith('ai.')) bump()
    },
    [bump]
  )
  const { opened } = useLiveEvents(SETTINGS_EVENTS, onEvent, coreSession)
  const load = useCallback(
    async () => aiSettingsFrom((await request('settings.list', {})).settings),
    []
  )
  const [settings, set] = useQuery(keyOf(coreSession, opened, version), load)
  const update = useCallback(
    async <K extends AiSettingKey>(key: K, value: SettingValue<K>) => {
      const record = await request('settings.update', { key, value } as never)
      set((previous) => ({ ...previous, [key]: record.value }))
    },
    [set]
  )
  return { settings, update }
}

/** Which model a request would use now, or why none can. */
export function useRoutePreview(
  capability: ModelCapability,
  conversationId: string | null,
  coreSession: string | null
): Loadable<RoutePreview> {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(ROUTE_EVENTS, bump, coreSession)
  const load = useCallback(
    () => request('ai.route.preview', { capability, conversationId }),
    [capability, conversationId]
  )
  return useQuery(keyOf(coreSession, capability, conversationId, opened, version), load)[0]
}

export function useConversations(coreSession: string | null): Loadable<Conversation[]> {
  const [version, bump] = useBump(150)
  const { opened } = useLiveEvents(CONVERSATION_LIST_EVENTS, bump, coreSession)
  const load = useCallback(
    async () => (await request('chat.conversations.list', { limit: 200 })).conversations,
    []
  )
  return useQuery(keyOf(coreSession, opened, version), load)[0]
}

// ---- one conversation, with streamed answers ---------------------------------------------

export interface ConversationData {
  readonly conversation: Conversation
  readonly messages: readonly ChatMessage[]
}

interface Delta {
  readonly messageId: string
  readonly offset: number
  readonly text: string
}

export function textOf(message: Pick<ChatMessage, 'parts'>): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/**
 * Add streamed text to the answer it belongs to. Text is placed by its
 * offset, so a piece that was already included (for example in the answer
 * as it was loaded) is never shown twice. Returns null when the piece does
 * not fit — text is missing before it — and the conversation must be read
 * again.
 */
export function applyDelta(messages: readonly ChatMessage[], delta: Delta): ChatMessage[] | null {
  const index = messages.findIndex((message) => message.messageId === delta.messageId)
  const message = messages[index]
  if (message?.status !== 'streaming') return [...messages]
  const text = textOf(message)
  if (delta.offset > text.length) return null
  const end = delta.offset + delta.text.length
  if (end <= text.length) return [...messages]
  const next = text + delta.text.slice(text.length - delta.offset)
  const others = message.parts.filter((part) => part.type !== 'text')
  const updated = [...messages]
  updated[index] = { ...message, parts: [{ type: 'text', text: next }, ...others] }
  return updated
}

export type ConversationState =
  Loadable<ConversationData> | { readonly state: 'deleted' } | { readonly state: 'none' }

export interface ConversationHandle {
  readonly data: ConversationState
  /** Show an exchange as the command returned it, before the change events arrive. */
  readonly applyExchange: (exchange: {
    conversation: Conversation
    userMessage: ChatMessage
    assistantMessage: ChatMessage
  }) => void
}

export function useConversation(
  conversationId: string | null,
  coreSession: string | null
): ConversationHandle {
  const [version, bump] = useBump(30)
  // What is shown, and for which conversation: another conversation's state is never shown.
  const [shown, setShown] = useState<{ id: string | null; state: ConversationState }>({
    id: null,
    state: { state: 'none' }
  })
  // The conversation as last shown; streamed text is added to it as it arrives.
  const live = useRef<ConversationData | null>(null)
  // Streamed text that arrived before the conversation was loaded.
  const pending = useRef<Delta[]>([])
  const pendingFor = useRef<string | null>(null)

  const show = useCallback((value: ConversationData) => {
    live.current = value
    setShown({ id: value.conversation.conversationId, state: { state: 'ready', value } })
  }, [])

  const onEvent = useCallback(
    (event: DomainEvent) => {
      if (event.type === 'chat.message.delta') {
        const delta = event.payload
        const current = live.current
        if (current?.conversation.conversationId !== delta.conversationId) {
          if (pendingFor.current !== delta.conversationId) {
            pendingFor.current = delta.conversationId
            pending.current = []
          }
          pending.current.push(delta)
          return
        }
        const messages = applyDelta(current.messages, delta)
        if (messages === null) bump()
        else show({ ...current, messages })
        return
      }
      if (event.type === 'chat.conversation.changed' && event.payload.change === 'deleted') {
        live.current = null
        setShown({ id: event.payload.conversationId, state: { state: 'deleted' } })
        return
      }
      bump()
    },
    [bump, show]
  )

  const streamFilter =
    conversationId === null ? null : filter(null, [{ kind: 'conversation', id: conversationId }])
  const { opened } = useLiveEvents(streamFilter, onEvent, coreSession)

  useEffect(() => {
    if (conversationId === null || coreSession === null) return
    if (live.current?.conversation.conversationId !== conversationId) live.current = null
    let active = true
    request('chat.messages.list', { conversationId }).then(
      (result) => {
        if (!active) return
        let messages: ChatMessage[] = result.messages
        let gap = false
        if (pendingFor.current === conversationId) {
          for (const delta of pending.current) {
            const next = applyDelta(messages, delta)
            if (next === null) gap = true
            else messages = next
          }
        }
        pending.current = []
        pendingFor.current = null
        show({ conversation: result.conversation, messages })
        if (gap) bump()
      },
      (error: unknown) => {
        if (active)
          setShown({ id: conversationId, state: { state: 'error', error: envelopeOf(error) } })
      }
    )
    return () => {
      active = false
    }
  }, [conversationId, coreSession, opened, version, bump, show])

  const data: ConversationState =
    conversationId === null
      ? { state: 'none' }
      : shown.id === conversationId
        ? shown.state
        : { state: 'loading' }

  const applyExchange = useCallback<ConversationHandle['applyExchange']>(
    (exchange) => {
      const current = live.current
      if (current?.conversation.conversationId !== exchange.conversation.conversationId) return
      const known = new Set(current.messages.map((message) => message.messageId))
      const added = [exchange.userMessage, exchange.assistantMessage].filter(
        (message) => !known.has(message.messageId)
      )
      show({
        conversation: exchange.conversation,
        messages: [...current.messages, ...added].sort((a, b) => a.seq - b.seq)
      })
      bump()
    },
    [bump, show]
  )

  return { data, applyExchange }
}
