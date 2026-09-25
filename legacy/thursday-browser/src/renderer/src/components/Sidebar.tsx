import { useCallback, useEffect, useRef, useState } from 'react'
import type { Conversation, StoredMessage } from '@shared/schemas.js'
import { useStore } from '../state/store.js'

/**
 * Thursday sidebar: chat, the active model, the current mission and skill.
 * Collapsible, and entirely optional — the browser works without it.
 */

interface Streaming {
  streamId: string
  messageId: string
  text: string
  error: string | null
}

export function Sidebar(): JSX.Element {
  const { settings, providers, command, patchSettings } = useStore()
  const api = window.thursday

  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [streaming, setStreaming] = useState<Streaming | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const open = settings?.sidebarOpen ?? true
  const providerId = settings?.activeProviderId ?? null
  const model = settings?.activeModel ?? null
  const provider = providers.find((candidate) => candidate.id === providerId) ?? null

  /* Ensure a conversation exists as soon as the sidebar is usable. */
  useEffect(() => {
    if (!open || conversation) return
    void (async () => {
      try {
        const existing = await api['chat:listConversations']()
        const active = existing[0] ?? (await api['chat:createConversation']({}))
        setConversation(active)
        setMessages(await api['chat:messages']({ conversationId: active.id }))
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [open, conversation, api])

  /* Model list for the picker, from the provider's cached/live models. */
  useEffect(() => {
    if (!providerId) {
      setModels([])
      return
    }
    void (async () => {
      try {
        const result = await api['providers:models']({ id: providerId })
        setModels(result.models.map((entry) => entry.id))
      } catch {
        setModels([])
      }
    })()
  }, [providerId, api])

  /* Streaming chunks. */
  useEffect(() => {
    return api.on('chat:chunk', (payload) => {
      setStreaming((current) => {
        if (!current || payload.streamId !== current.streamId) return current
        const chunk = payload.chunk
        if (chunk.type === 'text') return { ...current, text: current.text + chunk.text }
        if (chunk.type === 'error') return { ...current, error: chunk.message }
        if (chunk.type === 'tool_call') {
          return { ...current, text: `${current.text}\n[calling ${chunk.name}…]\n` }
        }
        return current
      })

      if (payload.chunk.type === 'done') {
        void (async () => {
          try {
            setMessages(await api['chat:messages']({ conversationId: payload.conversationId }))
          } finally {
            setStreaming(null)
          }
        })()
      }
    })
  }, [api])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, streaming?.text])

  const send = useCallback(async () => {
    const content = draft.trim()
    if (!content || !conversation) return
    setError(null)

    if (!providerId || !model) {
      setError('Pick a provider and model first — Settings → AI Providers, then choose them below.')
      return
    }

    setDraft('')
    try {
      const ack = await api['chat:send']({
        conversationId: conversation.id,
        providerId,
        model,
        content,
        useSkills: true
      })
      setMessages(await api['chat:messages']({ conversationId: conversation.id }))
      setStreaming({ streamId: ack.streamId, messageId: ack.assistantMessageId, text: '', error: null })
    } catch (err) {
      setError((err as Error).message)
      setDraft(content)
    }
  }, [draft, conversation, providerId, model, api])

  if (!open) return <aside className="sidebar collapsed" />

  const mission = command?.mission ?? null

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">Thursday</span>
        <button
          className="btn sm"
          title="New conversation"
          onClick={() => {
            void (async () => {
              const created = await api['chat:createConversation']({})
              setConversation(created)
              setMessages([])
              setStreaming(null)
            })()
          }}
        >
          New
        </button>
        <button className="btn sm" title="Collapse sidebar" onClick={() => void patchSettings({ sidebarOpen: false })}>
          ⟩
        </button>
      </div>

      <div className="sidebar-meta">
        <div className="meta-row">
          <span className="meta-key">Model</span>
          <span className="meta-val">
            {model ? (provider ? `${provider.label} · ${model}` : model) : 'none selected'}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-key">Mission</span>
          <span className="meta-val">{mission ? `${mission.title} (${mission.status})` : 'none'}</span>
        </div>
        <div className="meta-row">
          <span className="meta-key">Skill</span>
          <span className="meta-val">{command?.activeSkill ?? 'idle'}</span>
        </div>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !streaming ? (
          <div className="empty">Ask Thursday something. Registered skills are offered to the model automatically.</div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className={`msg ${message.role}`}>
            <span className="msg-role">{message.role}</span>
            <div className="msg-body">{message.content}</div>
          </div>
        ))}

        {streaming ? (
          <div className={`msg assistant${streaming.error ? ' msg-error' : ''}`}>
            <span className="msg-role">assistant</span>
            <div className="msg-body">
              {streaming.error ?? (streaming.text || '…')}
            </div>
          </div>
        ) : null}
      </div>

      <div className="chat-compose">
        {error ? <div className="notice err">{error}</div> : null}

        <select
          value={providerId ?? ''}
          onChange={(event) => void patchSettings({ activeProviderId: event.target.value || null, activeModel: null })}
        >
          <option value="">— choose provider —</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>

        <select
          value={model ?? ''}
          disabled={!providerId}
          onChange={(event) => void patchSettings({ activeModel: event.target.value || null })}
        >
          <option value="">{models.length ? '— choose model —' : 'no models fetched yet'}</option>
          {models.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>

        <textarea
          value={draft}
          placeholder="Message Thursday…  (Enter to send, Shift+Enter for a new line)"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />

        <div className="compose-actions">
          <button className="btn primary" disabled={!draft.trim() || !!streaming} onClick={() => void send()}>
            Send
          </button>
          {streaming ? (
            <button
              className="btn"
              onClick={() => {
                void api['chat:cancel']({ streamId: streaming.streamId })
              }}
            >
              Stop
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
