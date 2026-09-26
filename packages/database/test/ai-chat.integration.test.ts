import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ModelInfo } from '@jupiter/contracts'
import type { StoredProvider } from '@jupiter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JUPITER_MIGRATIONS, JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

/**
 * SET 3 tables on real SQLite files: providers and models (no key material,
 * cascade on removal, the person's model choices survive rediscovery) and
 * conversations and messages (ordering, superseding instead of deleting,
 * validation on read).
 */

let dir: string
let cleanup: () => void
const opened: JupiterDatabase[] = []

beforeEach(() => {
  ;({ dir, cleanup } = tempDirectory())
})

afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  cleanup()
})

async function open(
  path = join(dir, 'jupiter.db'),
  migrations = JUPITER_MIGRATIONS
): Promise<JupiterDatabase> {
  const { database } = await JupiterDatabase.open({
    path,
    backupDirectory: join(dir, 'backups'),
    migrations
  })
  opened.push(database)
  return database
}

const NOW = '2026-09-25T10:00:00.000Z'
const LATER = '2026-09-25T10:05:00.000Z'
const PROVIDER = '01a0d82f-22b6-762b-b369-29675d970dfd'
const CONVERSATION = '01a0d82f-22b6-762b-b369-29675d970dfe'

function provider(overrides: Partial<StoredProvider> = {}): StoredProvider {
  return {
    providerId: PROVIDER,
    adapterId: 'openai-compatible',
    displayName: 'Local models',
    baseUrl: 'http://127.0.0.1:11434/v1',
    enabled: true,
    checkState: 'not-checked',
    error: null,
    checkedAt: null,
    credentialId: null,
    credentialFingerprint: null,
    credentialSavedAt: null,
    credentialValidation: 'not-validated',
    credentialValidatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function message(seq: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: `01a0d82f-22b6-762b-b369-29675d97${String(1000 + seq)}`,
    conversationId: CONVERSATION,
    seq,
    role: seq % 2 === 1 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `message ${String(seq)}` }],
    status: 'complete',
    route: null,
    usage: null,
    finishReason: null,
    error: null,
    supersededBy: null,
    editedFrom: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides
  }
}

describe('providers and models', () => {
  it('stores providers without key material and removes their models with them', async () => {
    const database = await open()
    database.providers.insert(
      provider({
        credentialId: '01a0d82f-22b6-762b-b369-29675d970e00',
        credentialFingerprint: '3f9a1c02',
        credentialSavedAt: NOW
      })
    )
    expect(database.providers.get(PROVIDER)).toMatchObject({
      credentialFingerprint: '3f9a1c02',
      checkState: 'not-checked'
    })
    const columns = raw(join(dir, 'jupiter.db'))
      .prepare('PRAGMA table_info(ai_providers)')
      .all()
      .map((column) => String(column.name))
    expect(columns.filter((name) => /secret|key_value|api_key|token/.test(name))).toEqual([])

    database.providers.mergeDiscovered(
      PROVIDER,
      [
        {
          modelId: 'llama3.2:latest',
          displayName: null,
          capabilities: null,
          contextWindow: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null
        }
      ],
      NOW
    )
    expect(database.providers.models(PROVIDER)).toHaveLength(1)
    expect(database.providers.remove(PROVIDER)).toBe(true)
    expect(database.providers.get(PROVIDER)).toBeNull()
    expect(database.providers.models(PROVIDER)).toEqual([])
  })

  it('adds newly discovered models disabled and keeps what the person chose for known ones', async () => {
    const database = await open()
    database.providers.insert(provider())
    const found = (modelId: string, capabilities: ModelInfo['capabilities'] | null = null) => ({
      modelId,
      displayName: null,
      capabilities,
      contextWindow: null,
      inputCostPerMillion: null,
      outputCostPerMillion: null
    })
    expect(
      database.providers.mergeDiscovered(
        PROVIDER,
        [found('chat-model'), found('embedder', ['embeddings'])],
        NOW
      )
    ).toBe(2)
    expect(database.providers.model(PROVIDER, 'chat-model')).toMatchObject({
      enabled: false,
      capabilities: [],
      capabilitySource: 'none',
      discovered: true
    })
    expect(database.providers.model(PROVIDER, 'embedder')).toMatchObject({
      capabilities: ['embeddings'],
      capabilitySource: 'provider'
    })

    const chosen = database.providers.model(PROVIDER, 'chat-model')
    if (!chosen) throw new Error('missing model')
    database.providers.putModel({
      ...chosen,
      enabled: true,
      capabilities: ['chat', 'vision'],
      capabilitySource: 'user',
      updatedAt: LATER
    })
    // Rediscovery (even one that no longer lists the model) keeps the person's choices.
    expect(
      database.providers.mergeDiscovered(PROVIDER, [found('chat-model', ['chat'])], LATER)
    ).toBe(0)
    expect(database.providers.model(PROVIDER, 'chat-model')).toMatchObject({
      enabled: true,
      capabilities: ['chat', 'vision'],
      capabilitySource: 'user'
    })
    database.providers.mergeDiscovered(PROVIDER, [], LATER)
    expect(database.providers.models(PROVIDER).map((model) => model.modelId)).toEqual([
      'chat-model',
      'embedder'
    ])

    database.providers.recordLatency(PROVIDER, 'chat-model', 400, LATER)
    database.providers.recordLatency(PROVIDER, 'chat-model', 800, LATER)
    expect(database.providers.model(PROVIDER, 'chat-model')?.observedLatencyMs).toBeCloseTo(520)
  })
})

describe('conversations and messages', () => {
  it('keeps messages in order, supersedes instead of deleting, and finds interrupted answers', async () => {
    const database = await open()
    database.chat.insertConversation({
      conversationId: CONVERSATION,
      title: 'Plan the trip',
      routing: { mode: null, model: null },
      createdAt: NOW
    })
    expect(database.chat.nextSeq(CONVERSATION)).toBe(1)
    database.chat.insertMessage(message(1))
    database.chat.insertMessage(message(2, { status: 'streaming', completedAt: null, parts: [] }))
    expect(database.chat.nextSeq(CONVERSATION)).toBe(3)
    expect(database.chat.streaming().map((item) => item.seq)).toEqual([2])

    database.chat.updateMessage(message(2).messageId, {
      status: 'cancelled',
      parts: [{ type: 'text', text: 'Partial answ' }],
      finishReason: 'cancelled',
      completedAt: LATER
    })
    expect(database.chat.streaming()).toEqual([])

    // An edit: the new user message supersedes the old one and its answer; nothing is deleted.
    database.chat.insertMessage(message(3, { editedFrom: message(1).messageId }))
    database.chat.supersede([message(1).messageId, message(2).messageId], message(3).messageId)
    const all = database.chat.messages(CONVERSATION, 50)
    expect(all.map((item) => [item.seq, item.supersededBy])).toEqual([
      [1, message(3).messageId],
      [2, message(3).messageId],
      [3, null]
    ])
    expect(database.chat.conversation(CONVERSATION)?.messageCount).toBe(1)
    expect(database.chat.messages(CONVERSATION, 2).map((item) => item.seq)).toEqual([2, 3])

    database.chat.updateConversation(CONVERSATION, {
      routing: { mode: 'LOCAL_ONLY', model: null },
      updatedAt: LATER
    })
    expect(database.chat.listConversations(10)).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION,
        routing: { mode: 'LOCAL_ONLY', model: null },
        updatedAt: LATER
      })
    ])
  })

  it('refuses a second message with the same position and removes messages only with their conversation', async () => {
    const database = await open()
    database.chat.insertConversation({
      conversationId: CONVERSATION,
      title: 'Test',
      routing: { mode: null, model: null },
      createdAt: NOW
    })
    database.chat.insertMessage(message(1))
    expect(() => {
      database.chat.insertMessage(message(1, { messageId: '01a0d82f-22b6-762b-b369-29675d979999' }))
    }).toThrow()
    expect(database.chat.deleteConversation(CONVERSATION)).toBe(true)
    expect(database.chat.message(message(1).messageId)).toBeNull()
  })
})

describe('upgrading a SET 2 database (schema v2)', () => {
  it('backs it up, adds the SET 3 tables and keeps every existing row', async () => {
    const path = join(dir, 'jupiter.db')
    const v2 = await open(path, JUPITER_MIGRATIONS.slice(0, 2))
    v2.settings.put('ui.language', 'th', { type: 'user-interface', id: 'renderer:main' }, NOW)
    v2.close()

    const { database, migration, preMigrationBackup } = await JupiterDatabase.open({
      path,
      backupDirectory: join(dir, 'backups')
    })
    opened.push(database)
    expect(migration.fromVersion).toBe(2)
    expect(migration.applied.map((item) => item.name)).toContain('0003_ai_providers_and_chat')
    expect(preMigrationBackup?.reason).toBe('pre-migration')
    // One self-contained file: no -wal/-shm companions left behind.
    expect(readdirSync(join(dir, 'backups'))).toEqual([preMigrationBackup?.file])
    expect(database.settings.get('ui.language')?.value).toBe('th')
    expect(database.providers.list()).toEqual([])
    expect(database.chat.listConversations(10)).toEqual([])
  })
})
