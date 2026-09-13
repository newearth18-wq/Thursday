import { randomUUID } from 'node:crypto'
import type { ChatChunk, ChatMessage, Conversation, StoredMessage } from '@shared/schemas.js'
import type { ChatSendAck } from '@shared/ipc.js'
import { all, get, run } from '../core/db.js'
import { emit } from '../core/events.js'
import { describeError, log } from '../core/logger.js'
import { setActiveModel, setActiveSkill, setBrainState } from '../core/app-state.js'
import { invokeSkill, listSkills } from '../skills/registry.js'
import { getProviderConfig, resolveProvider } from './router.js'
import type { ToolSpec } from './providers/index.js'

/**
 * Thursday AI Core.
 *
 * Owns conversations and the streaming loop. It discovers what it can do
 * purely through the Skill Registry — no plugin is named anywhere in here.
 */

const MAX_TOOL_ROUNDS = 3
const SYSTEM_PROMPT =
  'You are Thursday, an assistant built into a desktop web browser. ' +
  'Be concise and concrete. When a skill is available that answers the request, call it rather than guessing.'

interface ActiveStream {
  controller: AbortController
  conversationId: string
  messageId: string
}

const streams = new Map<string, ActiveStream>()

/* --------------------------- conversations --------------------------- */

export function listConversations(): Conversation[] {
  return all('SELECT * FROM conversations ORDER BY updated_at DESC').map(rowToConversation)
}

export function createConversation(title?: string): Conversation {
  const now = Date.now()
  const conversation: Conversation = {
    id: randomUUID(),
    title: title?.trim() || 'New conversation',
    createdAt: now,
    updatedAt: now
  }
  run(
    'INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    conversation.id,
    conversation.title,
    now,
    now
  )
  return conversation
}

export function deleteConversation(id: string): void {
  if (!get('SELECT 1 AS present FROM conversations WHERE id = ?', id)) {
    throw new Error(`No conversation with id ${id}`)
  }
  run('DELETE FROM messages WHERE conversation_id = ?', id)
  run('DELETE FROM conversations WHERE id = ?', id)
}

export function listMessages(conversationId: string): StoredMessage[] {
  return all(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
    conversationId
  ).map((row) => ({
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as StoredMessage['role'],
    content: String(row.content),
    createdAt: Number(row.created_at)
  }))
}

function appendMessage(
  conversationId: string,
  role: StoredMessage['role'],
  content: string
): StoredMessage {
  const message: StoredMessage = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    createdAt: Date.now()
  }
  run(
    'INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    message.id,
    message.conversationId,
    message.role,
    message.content,
    message.createdAt
  )
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', message.createdAt, conversationId)
  return message
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/* ------------------------------ streaming ---------------------------- */

export function sendChat(input: {
  conversationId: string
  providerId: string
  model: string
  content: string
  useSkills?: boolean
}): ChatSendAck {
  const conversation = get('SELECT * FROM conversations WHERE id = ?', input.conversationId)
  if (!conversation) throw new Error(`No conversation with id ${input.conversationId}`)

  const providerConfig = getProviderConfig(input.providerId)
  if (!providerConfig) {
    throw new Error(`No provider with id ${input.providerId}. Add one in Settings → AI Providers.`)
  }

  const userMessage = appendMessage(input.conversationId, 'user', input.content)
  const assistantMessageId = randomUUID()
  const streamId = randomUUID()
  const controller = new AbortController()
  streams.set(streamId, { controller, conversationId: input.conversationId, messageId: assistantMessageId })

  // First real message names the conversation.
  if (String(conversation.title) === 'New conversation') {
    const title = input.content.trim().slice(0, 60)
    run('UPDATE conversations SET title = ? WHERE id = ?', title, input.conversationId)
  }

  setActiveModel(providerConfig.label, input.model)
  setBrainState('thinking')

  // Runs detached: the renderer follows progress through chat:chunk events.
  void runStream(streamId, input, assistantMessageId, controller.signal)

  return { streamId, userMessageId: userMessage.id, assistantMessageId }
}

export function cancelChat(streamId: string): void {
  const stream = streams.get(streamId)
  if (!stream) return
  stream.controller.abort(new Error('Cancelled by the user'))
  streams.delete(streamId)
  log.info('MODEL', 'Chat stream cancelled by user', { streamId })
  setBrainState('idle')
}

async function runStream(
  streamId: string,
  input: { conversationId: string; providerId: string; model: string; useSkills?: boolean },
  assistantMessageId: string,
  signal: AbortSignal
): Promise<void> {
  const emitChunk = (chunk: ChatChunk): void =>
    emit('chat:chunk', {
      streamId,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      chunk
    })

  let assembled = ''

  try {
    const provider = resolveProvider(input.providerId)
    const tools: ToolSpec[] = input.useSkills === false ? [] : buildToolSpecs()

    const history: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...listMessages(input.conversationId).map((message) => ({
        role: message.role,
        content: message.content
      }))
    ]

    log.info('MODEL', `Chat request to ${input.model}`, {
      providerId: input.providerId,
      messages: history.length,
      tools: tools.length
    })

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []
      let roundText = ''
      let failed = false

      for await (const chunk of provider.chat(
        { providerId: input.providerId, model: input.model, messages: history, tools: tools.map((t) => t.name) },
        tools,
        signal
      )) {
        if (chunk.type === 'text') {
          roundText += chunk.text
          assembled += chunk.text
          emitChunk(chunk)
        } else if (chunk.type === 'tool_call') {
          toolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments })
          emitChunk(chunk)
        } else if (chunk.type === 'error') {
          failed = true
          emitChunk(chunk)
          log.error('MODEL', `Provider error: ${chunk.message}`, { providerId: input.providerId })
        }
      }

      if (failed) break

      if (toolCalls.length === 0 || round === MAX_TOOL_ROUNDS) {
        if (toolCalls.length > 0) {
          const notice = `\n\n[Stopped after ${MAX_TOOL_ROUNDS} rounds of skill calls.]`
          assembled += notice
          emitChunk({ type: 'text', text: notice })
        }
        break
      }

      // Record the turn that asked for the tools, then feed results back.
      if (roundText.trim()) history.push({ role: 'assistant', content: roundText })

      for (const call of toolCalls) {
        setActiveSkill(call.name)
        setBrainState('executing')
        const result = await invokeSkill(call.name, call.arguments)
        setActiveSkill(null)

        const rendered = result.ok
          ? JSON.stringify(result.output)
          : `ERROR: ${result.error} (${result.code})`
        const summary = `Result of skill ${call.name}: ${rendered}`

        // Tool results are fed back as plain messages rather than native
        // tool-result blocks. It is the one representation every provider in
        // the router understands identically, which matters more here than
        // squeezing out the last few percent of fidelity.
        history.push({ role: 'user', content: summary })

        const line = result.ok
          ? `\n\n\`${call.name}\` → ${rendered}\n`
          : `\n\n\`${call.name}\` failed: ${result.error}\n`
        assembled += line
        emitChunk({ type: 'text', text: line })
      }
      setBrainState('thinking')
    }

    if (assembled.trim().length > 0) {
      persistAssistant(input.conversationId, assistantMessageId, assembled)
    }
    emitChunk({ type: 'done' })
  } catch (err) {
    const aborted = signal.aborted
    const message = aborted ? 'Response cancelled' : describeError(err)
    if (!aborted) log.error('MODEL', `Chat stream failed: ${message}`, { streamId })
    if (assembled.trim().length > 0) {
      persistAssistant(input.conversationId, assistantMessageId, assembled)
    }
    emitChunk(
      aborted ? { type: 'done', finishReason: 'cancelled' } : { type: 'error', message }
    )
  } finally {
    streams.delete(streamId)
    setActiveSkill(null)
    setBrainState('idle')
  }
}

function persistAssistant(conversationId: string, messageId: string, content: string): void {
  run(
    'INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    messageId,
    conversationId,
    'assistant',
    content,
    Date.now()
  )
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now(), conversationId)
}

/** Skills become tools by way of the registry — never by name from here. */
function buildToolSpecs(): ToolSpec[] {
  return listSkills().map((skill) => ({
    name: skill.id,
    description: skill.description || skill.name,
    parameters:
      Object.keys(skill.inputSchema).length > 0
        ? skill.inputSchema
        : { type: 'object', properties: {} }
  }))
}
