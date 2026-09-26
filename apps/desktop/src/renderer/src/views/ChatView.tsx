import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  RoutingMode,
  modelRef,
  type ChatExchange,
  type ChatMessage,
  type Conversation,
  type ErrorEnvelope,
  type MessagePart,
  type ProviderInfo
} from '@jupiter/contracts'
import { Icon } from '@jupiter/ui'
import type { ViewId } from '../../../shared/views'
import { request } from '../api'
import { ChatComposer } from '../components/ChatComposer'
import { Select, Switch } from '../components/FormControls'
import { ConfirmDialog } from '../components/InfoDialogs'
import { RouteBadge } from '../components/RouteBadge'
import { StateMessage } from '../components/StateMessage'
import { formatBytes } from '../format'
import { intlLocale, useI18n } from '../i18n'
import { useConversationRoute } from '../router'
import {
  textOf,
  useConversation,
  useConversations,
  useProviders,
  type ConversationData
} from '../useAi'
import { coreSessionOf, envelopeOf, useRuntimeContext, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import { ViewHeader } from './ViewHeader'

/**
 * Chat (SET 3): conversations with streamed answers, Stop, asking again,
 * editing a sent message, the model that answered, and a per-conversation
 * routing override. Every message shown is stored by Jupiter Core; nothing
 * is added or completed by the interface. Hidden model reasoning is never
 * shown (Core does not keep it); only its token count, when reported.
 */

export function ChatView({ onNavigate }: { readonly onNavigate: (view: ViewId) => void }) {
  const { t } = useI18n()
  const { status } = useRuntimeContext()
  const coreSession = coreSessionOf(status)
  const { conversationId, openConversation } = useConversationRoute()
  const conversations = useConversations(coreSession)
  const { data, applyExchange } = useConversation(conversationId, coreSession)
  const busy =
    data.state === 'ready' &&
    data.value.messages.some(
      (message) => message.status === 'streaming' && message.supersededBy === null
    )

  const onSent = (exchange: ChatExchange) => {
    if (exchange.conversation.conversationId === conversationId) applyExchange(exchange)
    else openConversation(exchange.conversation.conversationId)
  }

  return (
    <section className="view view-chat" aria-labelledby="chat-title">
      <ViewHeader id="chat-title" title={t('nav.chat')}>
        <button
          type="button"
          className="button"
          data-testid="chat-new"
          onClick={() => {
            openConversation(null)
          }}
        >
          <Icon name="add" size={18} />
          <span>{t('chat.new')}</span>
        </button>
      </ViewHeader>
      {coreSession === null ? (
        <StateMessage kind="unavailable" title={t('chat.coreDown')} testId="chat-core-down" />
      ) : null}
      <div className="chat-layout">
        <ConversationList
          conversations={conversations}
          selected={conversationId}
          onSelect={openConversation}
        />
        <div className="chat-main">
          <ConversationPanel
            conversationId={conversationId}
            data={data}
            coreSession={coreSession}
            onExchange={applyExchange}
            onNavigate={onNavigate}
            onClosed={() => {
              openConversation(null)
            }}
          />
          <ChatComposer
            testId="chat-view-composer"
            conversationId={conversationId}
            busy={busy}
            onSent={onSent}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </section>
  )
}

function ConversationList({
  conversations,
  selected,
  onSelect
}: {
  readonly conversations: Loadable<Conversation[]>
  readonly selected: string | null
  readonly onSelect: (conversationId: string) => void
}) {
  const { t, locale } = useI18n()
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  return (
    <nav className="conversation-list" aria-label={t('chat.conversations')}>
      {conversations.state === 'loading' ? (
        <p className="muted small">{t('load.loading')}</p>
      ) : null}
      {conversations.state === 'error' ? (
        <LoadFailure title={t('chat.listFailed')} error={conversations.error} />
      ) : null}
      {conversations.state === 'ready' && conversations.value.length === 0 ? (
        <p className="muted small" data-testid="conversations-empty">
          {t('chat.noConversations')}
        </p>
      ) : null}
      {conversations.state === 'ready' && conversations.value.length > 0 ? (
        <ul data-testid="conversations">
          {conversations.value.map((conversation) => (
            <li key={conversation.conversationId}>
              <button
                type="button"
                className="conversation-item"
                aria-current={conversation.conversationId === selected ? 'page' : undefined}
                data-testid="conversation-item"
                data-conversation-id={conversation.conversationId}
                onClick={() => {
                  onSelect(conversation.conversationId)
                }}
              >
                <span className="conversation-title">{conversation.title}</span>
                <span className="muted small">
                  {t('chat.conversationMeta', {
                    time: format.format(new Date(conversation.updatedAt)),
                    count: conversation.messageCount
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  )
}

function ConversationPanel({
  conversationId,
  data,
  coreSession,
  onExchange,
  onNavigate,
  onClosed
}: {
  readonly conversationId: string | null
  readonly data: ReturnType<typeof useConversation>['data']
  readonly coreSession: string | null
  readonly onExchange: (exchange: ChatExchange) => void
  readonly onNavigate: (view: ViewId) => void
  readonly onClosed: () => void
}) {
  const { t } = useI18n()
  switch (data.state) {
    case 'none':
      return (
        <div className="chat-empty" data-testid="chat-start">
          <StateMessage kind="empty" title={t('chat.startTitle')}>
            <p>{t('feature.chat')}</p>
            <p>{t('chat.startHint')}</p>
          </StateMessage>
        </div>
      )
    case 'loading':
      return <StateMessage kind="loading" title={t('load.loading')} />
    case 'deleted':
      return (
        <StateMessage
          kind="empty"
          title={t('chat.deleted')}
          testId="chat-deleted"
          action={{ label: t('chat.new'), onClick: onClosed }}
        />
      )
    case 'error':
      return (
        <LoadFailure title={t('chat.loadFailed')} error={data.error} testId="chat-load-failure">
          <button type="button" className="button" onClick={onClosed}>
            {t('chat.new')}
          </button>
        </LoadFailure>
      )
    case 'ready':
      return (
        <OpenConversation
          key={conversationId}
          data={data.value}
          coreSession={coreSession}
          onExchange={onExchange}
          onNavigate={onNavigate}
          onClosed={onClosed}
        />
      )
  }
}

type ModeChoice = 'default' | RoutingMode

function OpenConversation({
  data,
  coreSession,
  onExchange,
  onNavigate,
  onClosed
}: {
  readonly data: ConversationData
  readonly coreSession: string | null
  readonly onExchange: (exchange: ChatExchange) => void
  readonly onNavigate: (view: ViewId) => void
  readonly onClosed: () => void
}) {
  const { t } = useI18n()
  const { conversation, messages } = data
  const { providers } = useProviders(coreSession)
  const [showReplaced, setShowReplaced] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [actionError, setActionError] = useState<ErrorEnvelope | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  const current = messages.filter((message) => message.supersededBy === null)
  const visible = showReplaced ? messages : current
  const replacedCount = messages.length - current.length
  const busy = current.some((message) => message.status === 'streaming')
  const last = current.at(-1)

  const run = (key: string, action: () => Promise<unknown>) => {
    setPendingAction(key)
    setActionError(null)
    action()
      .catch((error: unknown) => {
        setActionError(envelopeOf(error))
      })
      .finally(() => {
        setPendingAction(null)
      })
  }

  const setRouting = (routing: Conversation['routing']) => {
    run('routing', () =>
      request('chat.conversations.update', {
        conversationId: conversation.conversationId,
        routing
      })
    )
  }

  const chatModels = chatModelsOf(providers)
  const modelChoices = [
    { value: 'auto', label: t('chat.modelAutomatic') },
    ...chatModels.map((model) => ({
      value: model.ref,
      label: t('chat.modelChoice', { model: model.name, provider: model.provider })
    }))
  ]
  // A pinned model that is no longer offered is still shown, so the setting is never hidden.
  if (conversation.routing.model && !chatModels.some((m) => m.ref === conversation.routing.model))
    modelChoices.push({
      value: conversation.routing.model,
      label: t('chat.modelUnavailable', { model: conversation.routing.model })
    })

  return (
    <div className="conversation" data-testid="conversation">
      <div className="conversation-toolbar">
        <h2 className="conversation-heading" data-testid="conversation-title">
          {conversation.title}
        </h2>
        <details className="conversation-options" data-testid="conversation-options">
          <summary>{t('chat.options')}</summary>
          <div className="conversation-options-body">
            <p className="muted small">{t('chat.routingHint')}</p>
            <Select<ModeChoice>
              label={t('chat.routingMode')}
              testId="conversation-mode"
              value={conversation.routing.mode ?? 'default'}
              onChange={(value) => {
                setRouting({
                  ...conversation.routing,
                  mode: value === 'default' ? null : value
                })
              }}
              choices={[
                { value: 'default', label: t('chat.modeDefault') },
                ...RoutingMode.options.map((mode) => ({
                  value: mode,
                  label: t(`routing.mode.${mode}`)
                }))
              ]}
            />
            <Select<string>
              label={t('chat.model')}
              testId="conversation-model"
              value={conversation.routing.model ?? 'auto'}
              onChange={(value) => {
                setRouting({ ...conversation.routing, model: value === 'auto' ? null : value })
              }}
              choices={modelChoices}
            />
            <Switch
              label={t('chat.showReplaced', { count: replacedCount })}
              testId="show-replaced"
              checked={showReplaced}
              onChange={setShowReplaced}
              description={t('chat.showReplacedHint')}
            />
            <button
              type="button"
              className="button button-danger"
              data-testid="conversation-delete"
              onClick={() => {
                setConfirmDelete(true)
              }}
            >
              <Icon name="remove" size={18} />
              <span>{t('chat.delete')}</span>
            </button>
          </div>
        </details>
      </div>
      <MessageList
        messages={visible}
        lastId={last?.messageId ?? null}
        busy={busy}
        pendingAction={pendingAction}
        onStop={(message) => {
          run(`stop:${message.messageId}`, () =>
            request('chat.stop', { messageId: message.messageId })
          )
        }}
        onRetry={(message) => {
          run(`retry:${message.messageId}`, async () => {
            onExchange(await request('chat.retry', { messageId: message.messageId }))
          })
        }}
        onEdit={(message, text) =>
          request('chat.edit', { messageId: message.messageId, text }).then(onExchange)
        }
        onNavigate={onNavigate}
      />
      {actionError ? (
        <LoadFailure title={t('chat.actionFailed')} error={actionError} testId="chat-action-error">
          {actionError.category === 'configuration' ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                onNavigate('models')
              }}
            >
              {t('composer.openModels')}
            </button>
          ) : null}
        </LoadFailure>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title={t('chat.deleteTitle')}
        description={t('chat.deleteConfirm', { title: conversation.title })}
        confirmLabel={t('chat.delete')}
        testId="conversation-delete-dialog"
        onCancel={() => {
          setConfirmDelete(false)
        }}
        onConfirm={() => {
          setConfirmDelete(false)
          run('delete', async () => {
            await request('chat.conversations.delete', {
              conversationId: conversation.conversationId
            })
            onClosed()
          })
        }}
      />
    </div>
  )
}

interface ChatModelChoice {
  readonly ref: string
  readonly name: string
  readonly provider: string
}

function chatModelsOf(providers: Loadable<ProviderInfo[]>): ChatModelChoice[] {
  if (providers.state !== 'ready') return []
  return providers.value.flatMap((provider) =>
    provider.enabled
      ? provider.models
          .filter((model) => model.enabled && model.capabilities.includes('chat'))
          .map((model) => ({
            ref: modelRef(provider.providerId, model.modelId),
            name: model.displayName ?? model.modelId,
            provider: provider.displayName
          }))
      : []
  )
}

function MessageList({
  messages,
  lastId,
  busy,
  pendingAction,
  onStop,
  onRetry,
  onEdit,
  onNavigate
}: {
  readonly messages: readonly ChatMessage[]
  readonly lastId: string | null
  readonly busy: boolean
  readonly pendingAction: string | null
  readonly onStop: (message: ChatMessage) => void
  readonly onRetry: (message: ChatMessage) => void
  readonly onEdit: (message: ChatMessage, text: string) => Promise<void>
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t } = useI18n()
  const list = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  const announcement = useAnnouncement(messages)

  // Follow the answer as it streams, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const element = list.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [messages])

  if (messages.length === 0)
    return (
      <p className="muted" data-testid="messages-empty">
        {t('chat.noMessages')}
      </p>
    )

  return (
    <>
      <ol
        ref={list}
        className="messages"
        aria-label={t('chat.messages')}
        data-testid="messages"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}
      >
        {messages.map((message) => (
          <MessageItem
            key={message.messageId}
            message={message}
            isLast={message.messageId === lastId}
            busy={busy}
            pendingAction={pendingAction}
            onStop={onStop}
            onRetry={onRetry}
            onEdit={onEdit}
            onNavigate={onNavigate}
          />
        ))}
      </ol>
      <p className="visually-hidden" role="status" data-testid="chat-announcement">
        {announcement}
      </p>
    </>
  )
}

/** Screen readers hear when an answer ends — not every streamed word. */
function useAnnouncement(messages: readonly ChatMessage[]): string {
  const { t } = useI18n()
  const previous = useRef(new Map<string, ChatMessage['status']>())
  const [text, setText] = useState('')
  useEffect(() => {
    for (const message of messages) {
      const before = previous.current.get(message.messageId)
      if (before === 'streaming' && message.status !== 'streaming')
        setText(t(`chat.announce.${message.status}`))
      previous.current.set(message.messageId, message.status)
    }
  }, [messages, t])
  return text
}

function MessageItem({
  message,
  isLast,
  busy,
  pendingAction,
  onStop,
  onRetry,
  onEdit,
  onNavigate
}: {
  readonly message: ChatMessage
  readonly isLast: boolean
  readonly busy: boolean
  readonly pendingAction: string | null
  readonly onStop: (message: ChatMessage) => void
  readonly onRetry: (message: ChatMessage) => void
  readonly onEdit: (message: ChatMessage, text: string) => Promise<void>
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t, locale } = useI18n()
  const [editing, setEditing] = useState(false)
  const text = textOf(message)
  const replaced = message.supersededBy !== null
  const streaming = message.status === 'streaming'
  const time = new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: 'short' }).format(
    new Date(message.createdAt)
  )
  const author = message.role === 'user' ? t('chat.you') : t(`chat.role.${message.role}`)

  return (
    <li
      className={`message message-${message.role}`}
      data-testid="chat-message"
      data-role={message.role}
      data-status={message.status}
      data-message-id={message.messageId}
      data-replaced={replaced}
    >
      <div className="message-meta">
        <span className="message-author">{author}</span>
        <time dateTime={message.createdAt} className="muted small">
          {time}
        </time>
        {message.editedFrom ? <span className="badge badge-muted">{t('chat.edited')}</span> : null}
        {replaced ? <span className="badge badge-muted">{t('chat.replaced')}</span> : null}
        {streaming ? (
          <span className="badge badge-info" data-testid="message-writing">
            {t('chat.writing')}
          </span>
        ) : null}
        {message.status === 'cancelled' ? (
          <span className="badge badge-warning" data-testid="message-stopped">
            {t('chat.stopped')}
          </span>
        ) : null}
      </div>

      {editing ? (
        <EditForm
          initial={text}
          onCancel={() => {
            setEditing(false)
          }}
          onSubmit={async (next) => {
            await onEdit(message, next)
            setEditing(false)
          }}
        />
      ) : (
        <>
          {text ? (
            <div className="message-text" data-testid="message-text">
              {text}
            </div>
          ) : null}
          {streaming && !text ? (
            <p className="muted small" data-testid="message-waiting">
              {t('chat.waiting', {
                model: message.route?.modelName ?? message.route?.modelId ?? '—'
              })}
            </p>
          ) : null}
          {message.parts.map((part, index) => (
            <PartView key={index} part={part} />
          ))}
        </>
      )}

      {message.role === 'assistant' && message.route ? (
        <div className="message-route small">
          <RouteBadge route={message.route} testId="message-route" />
          <UsageLine message={message} />
        </div>
      ) : null}
      <FinishNote message={message} />

      {message.error ? (
        <LoadFailure
          title={message.status === 'failed' ? t('chat.answerFailed') : t('chat.answerInterrupted')}
          error={message.error}
          testId="message-error"
        >
          {message.error.category === 'configuration' ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                onNavigate('models')
              }}
            >
              {t('composer.openModels')}
            </button>
          ) : null}
        </LoadFailure>
      ) : null}

      {replaced || editing ? null : (
        <div className="message-actions">
          {streaming ? (
            <button
              type="button"
              className="button"
              data-testid="message-stop"
              disabled={pendingAction === `stop:${message.messageId}`}
              onClick={() => {
                onStop(message)
              }}
            >
              <Icon name="stop" size={16} />
              <span>{t('chat.stop')}</span>
            </button>
          ) : null}
          {message.role === 'assistant' && isLast && !streaming ? (
            <button
              type="button"
              className="button"
              data-testid="message-retry"
              disabled={busy || pendingAction !== null}
              onClick={() => {
                onRetry(message)
              }}
            >
              <Icon name="retry" size={16} />
              <span>{t('chat.retry')}</span>
            </button>
          ) : null}
          {message.role === 'user' ? (
            <button
              type="button"
              className="button"
              data-testid="message-edit"
              disabled={busy || pendingAction !== null}
              onClick={() => {
                setEditing(true)
              }}
            >
              <Icon name="edit" size={16} />
              <span>{t('chat.edit')}</span>
            </button>
          ) : null}
        </div>
      )}
    </li>
  )
}

function EditForm({
  initial,
  onCancel,
  onSubmit
}: {
  readonly initial: string
  readonly onCancel: () => void
  readonly onSubmit: (text: string) => Promise<void>
}) {
  const { t } = useI18n()
  const inputId = useId()
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const trimmed = text.trim()
  return (
    <form
      className="edit-form"
      data-testid="message-edit-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed || saving) return
        setSaving(true)
        setFailure(null)
        onSubmit(trimmed).catch((error: unknown) => {
          setSaving(false)
          setFailure(envelopeOf(error))
        })
      }}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        {t('chat.editLabel')}
      </label>
      <textarea
        id={inputId}
        className="composer-input"
        rows={3}
        value={text}
        data-testid="message-edit-input"
        onChange={(event) => {
          setText(event.target.value)
        }}
      />
      <p className="muted small">{t('chat.editHint')}</p>
      <div className="actions">
        <button type="button" className="button" onClick={onCancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="submit"
          className="button button-primary"
          disabled={!trimmed || saving}
          data-testid="message-edit-send"
        >
          <Icon name="send" size={16} />
          <span>{t('chat.editSend')}</span>
        </button>
      </div>
      {failure ? <LoadFailure title={t('chat.actionFailed')} error={failure} /> : null}
    </form>
  )
}

function PartView({ part }: { readonly part: MessagePart }) {
  const { t } = useI18n()
  switch (part.type) {
    case 'text':
      return null
    case 'tool-call':
      return (
        <details className="tool-call" data-testid="tool-call" data-tool={part.name}>
          <summary>
            <Icon name="tool" size={16} />
            <span>{t('chat.toolCall', { name: part.name })}</span>
          </summary>
          <pre className="tool-arguments">
            <code>{prettyJson(part.arguments)}</code>
          </pre>
          <p className="muted small">{t('chat.toolNotRun')}</p>
        </details>
      )
    case 'tool-result':
      return (
        <details className="tool-call" data-testid="tool-result">
          <summary>
            <Icon name="tool" size={16} />
            <span>{t(part.isError ? 'chat.toolResultError' : 'chat.toolResult')}</span>
          </summary>
          <pre className="tool-arguments">
            <code>{part.content}</code>
          </pre>
        </details>
      )
    case 'attachment':
      return <AttachmentView part={part} />
  }
}

function AttachmentView({ part }: { readonly part: Extract<MessagePart, { type: 'attachment' }> }) {
  const { t } = useI18n()
  return (
    <p className="attachment" data-testid="attachment">
      <Icon name="attach" size={16} />
      <span>
        {t('chat.attachment', {
          name: part.name,
          type: part.mediaType,
          size: formatBytes(t, part.bytes)
        })}
      </span>
    </p>
  )
}

function UsageLine({ message }: { readonly message: ChatMessage }) {
  const { t } = useI18n()
  const usage = message.usage
  if (!usage || (usage.inputTokens === null && usage.outputTokens === null)) return null
  return (
    <span className="muted" data-testid="message-usage">
      {t('chat.usage', {
        input: usage.inputTokens ?? '—',
        output: usage.outputTokens ?? '—'
      })}
      {usage.reasoningTokens
        ? ` ${t('chat.reasoningTokens', { count: usage.reasoningTokens })}`
        : ''}
    </span>
  )
}

function FinishNote({ message }: { readonly message: ChatMessage }) {
  const { t } = useI18n()
  if (message.status !== 'complete') return null
  switch (message.finishReason) {
    case 'length':
      return <p className="muted small">{t('chat.finish.length')}</p>
    case 'content-filter':
      return <p className="muted small">{t('chat.finish.contentFilter')}</p>
    case 'tool-calls':
      return <p className="muted small">{t('chat.finish.toolCalls')}</p>
    default:
      return null
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
