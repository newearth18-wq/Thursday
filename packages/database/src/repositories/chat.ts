import type { DatabaseSync } from 'node:sqlite'
import { ChatMessage, Conversation, type ConversationRouting } from '@jupiter/contracts'
import type { ChatStore, MessageChanges, NewConversation } from '@jupiter/core'
import { integer, json, nullableText, text } from '../rows'

/** Conversations and their messages. Rows are validated against the contract when read. */
export class SqliteChatStore implements ChatStore {
  constructor(private readonly db: DatabaseSync) {}

  listConversations(limit: number): Conversation[] {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT count(*) FROM chat_messages m
                       WHERE m.conversation_id = c.conversation_id AND m.superseded_by IS NULL) AS message_count
         FROM chat_conversations c ORDER BY c.updated_at DESC, c.conversation_id DESC LIMIT ?`
      )
      .all(limit)
      .map(toConversation)
  }

  conversation(conversationId: string): Conversation | null {
    const row = this.db
      .prepare(
        `SELECT c.*, (SELECT count(*) FROM chat_messages m
                       WHERE m.conversation_id = c.conversation_id AND m.superseded_by IS NULL) AS message_count
         FROM chat_conversations c WHERE c.conversation_id = ?`
      )
      .get(conversationId)
    return row ? toConversation(row) : null
  }

  insertConversation(conversation: NewConversation): void {
    this.db
      .prepare(
        `INSERT INTO chat_conversations (conversation_id, title, routing_mode, routing_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        conversation.conversationId,
        conversation.title,
        conversation.routing.mode,
        conversation.routing.model,
        conversation.createdAt,
        conversation.createdAt
      )
  }

  updateConversation(
    conversationId: string,
    changes: { title?: string; routing?: ConversationRouting; updatedAt: string }
  ): void {
    const current = this.conversation(conversationId)
    if (!current) throw new Error(`No conversation ${conversationId}`)
    const routing = changes.routing ?? current.routing
    this.db
      .prepare(
        `UPDATE chat_conversations SET title = ?, routing_mode = ?, routing_model = ?, updated_at = ?
         WHERE conversation_id = ?`
      )
      .run(
        changes.title ?? current.title,
        routing.mode,
        routing.model,
        changes.updatedAt,
        conversationId
      )
  }

  deleteConversation(conversationId: string): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM chat_conversations WHERE conversation_id = ?')
          .run(conversationId).changes
      ) > 0
    )
  }

  messages(conversationId: string, limit: number): ChatMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`
      )
      .all(conversationId, limit)
      .map(toMessage)
  }

  message(messageId: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE message_id = ?').get(messageId)
    return row ? toMessage(row) : null
  }

  nextSeq(conversationId: string): number {
    const row = this.db
      .prepare(
        'SELECT coalesce(max(seq), 0) + 1 AS next FROM chat_messages WHERE conversation_id = ?'
      )
      .get(conversationId)
    return row ? integer(row, 'next') : 1
  }

  insertMessage(message: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (
           message_id, conversation_id, seq, role, status, parts_json, route_json, usage_json,
           finish_reason, error_json, superseded_by, edited_from, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.messageId,
        message.conversationId,
        message.seq,
        message.role,
        message.status,
        JSON.stringify(message.parts),
        message.route ? JSON.stringify(message.route) : null,
        message.usage ? JSON.stringify(message.usage) : null,
        message.finishReason,
        message.error ? JSON.stringify(message.error) : null,
        message.supersededBy,
        message.editedFrom,
        message.createdAt,
        message.completedAt
      )
  }

  updateMessage(messageId: string, changes: MessageChanges): void {
    const current = this.message(messageId)
    if (!current) throw new Error(`No message ${messageId}`)
    const next = ChatMessage.parse({ ...current, ...changes })
    this.db
      .prepare(
        `UPDATE chat_messages SET status = ?, parts_json = ?, route_json = ?, usage_json = ?,
           finish_reason = ?, error_json = ?, completed_at = ?
         WHERE message_id = ?`
      )
      .run(
        next.status,
        JSON.stringify(next.parts),
        next.route ? JSON.stringify(next.route) : null,
        next.usage ? JSON.stringify(next.usage) : null,
        next.finishReason,
        next.error ? JSON.stringify(next.error) : null,
        next.completedAt,
        messageId
      )
  }

  supersede(messageIds: readonly string[], by: string): void {
    const statement = this.db.prepare(
      'UPDATE chat_messages SET superseded_by = ? WHERE message_id = ? AND superseded_by IS NULL'
    )
    for (const id of messageIds) statement.run(by, id)
  }

  streaming(): ChatMessage[] {
    return this.db
      .prepare("SELECT * FROM chat_messages WHERE status = 'streaming' ORDER BY created_at")
      .all()
      .map(toMessage)
  }
}

function toConversation(row: Record<string, unknown>): Conversation {
  return Conversation.parse({
    conversationId: text(row, 'conversation_id'),
    title: text(row, 'title'),
    routing: {
      mode: nullableText(row, 'routing_mode'),
      model: nullableText(row, 'routing_model')
    },
    messageCount: integer(row, 'message_count'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at')
  })
}

function parseNullable(row: Record<string, unknown>, key: string): unknown {
  const value = nullableText(row, key)
  return value === null ? null : (JSON.parse(value) as unknown)
}

function toMessage(row: Record<string, unknown>): ChatMessage {
  return ChatMessage.parse({
    messageId: text(row, 'message_id'),
    conversationId: text(row, 'conversation_id'),
    seq: integer(row, 'seq'),
    role: text(row, 'role'),
    parts: json(row, 'parts_json'),
    status: text(row, 'status'),
    route: parseNullable(row, 'route_json'),
    usage: parseNullable(row, 'usage_json'),
    finishReason: nullableText(row, 'finish_reason'),
    error: parseNullable(row, 'error_json'),
    supersededBy: nullableText(row, 'superseded_by'),
    editedFrom: nullableText(row, 'edited_from'),
    createdAt: text(row, 'created_at'),
    completedAt: nullableText(row, 'completed_at')
  })
}
