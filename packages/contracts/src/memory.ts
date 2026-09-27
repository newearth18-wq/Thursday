import { z } from 'zod'
import { Locality, ModelId, ProviderId } from './ai'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The Memory System (SET 11): what Jupiter remembers, why, and how the
 * person sees, corrects, exports, forgets and deletes it.
 *
 * Memory is selective. Every candidate gets one policy decision — `SAVE`,
 * `DO_NOT_SAVE` or `ASK_USER` — and the reasons for it; a chat turn is never
 * saved just because it happened. Credentials are never remembered.
 * Financial, health, biometric, identity and other people's private details
 * are sensitive: they are saved only after the person says so, their content
 * is sealed with the operating system's secure storage, and it never
 * appears in events, logs, exports or model requests.
 *
 * Layers:
 * - working memory: what a single request or Mission step recalls (not stored);
 * - session memory: kept only while Jupiter Core runs;
 * - long-term memory: stored in Jupiter's database;
 * - knowledge base: the person's notes in an approved Obsidian vault.
 */

export const MEMORY_TYPES = [
  'preferences',
  'people',
  'projects',
  'documents',
  'decisions',
  'tasks',
  'routines',
  'facts',
  'ideas',
  'relationships'
] as const
export const MemoryType = z.enum(MEMORY_TYPES)
export type MemoryType = z.infer<typeof MemoryType>

export const MEMORY_LAYERS = ['working', 'session', 'long-term', 'knowledge-base'] as const
export const MemoryLayer = z.enum(MEMORY_LAYERS)
export type MemoryLayer = z.infer<typeof MemoryLayer>

export const MemorySensitivity = z.enum(['normal', 'sensitive'])
export type MemorySensitivity = z.infer<typeof MemorySensitivity>

/** What made content sensitive. `credential` is never stored at all. */
export const SENSITIVE_KINDS = [
  'credential',
  'financial',
  'health',
  'biometric',
  'identity',
  'third-party'
] as const
export const SensitiveKind = z.enum(SENSITIVE_KINDS)
export type SensitiveKind = z.infer<typeof SensitiveKind>

export const MemoryRetention = z.discriminatedUnion('kind', [
  /** Kept only while Jupiter Core runs (session memory). */
  z.object({ kind: z.literal('session') }).strict(),
  /** Kept until the person forgets or deletes it (long-term memory). */
  z.object({ kind: z.literal('long-term') }).strict(),
  /** Kept until a date, then removed. */
  z.object({ kind: z.literal('until'), expiresAt: UtcTimestamp }).strict()
])
export type MemoryRetention = z.infer<typeof MemoryRetention>

export const MemorySourceKind = z.enum(['user', 'chat', 'mission', 'note'])
export type MemorySourceKind = z.infer<typeof MemorySourceKind>

/** Where a memory came from: shown next to it, so the person can check it. */
export const MemorySource = z
  .object({
    kind: MemorySourceKind,
    label: z.string().trim().min(1).max(200),
    /** A link back: `chat:<conversationId>`, `mission:<missionId>` or `note:<path>`. */
    ref: z
      .string()
      .max(400)
      .regex(/^(chat|mission|note):[^\r\n]+$/)
      .nullable()
  })
  .strict()
export type MemorySource = z.infer<typeof MemorySource>

export const RELATIONSHIP_KINDS = [
  'related',
  'about',
  'part-of',
  'depends-on',
  'supersedes'
] as const
export const MemoryRelationship = z
  .object({ kind: z.enum(RELATIONSHIP_KINDS), memoryId: Uuidv7 })
  .strict()
export type MemoryRelationship = z.infer<typeof MemoryRelationship>

export const MEMORY_CONTENT_MAX = 4_000
export const MemoryContent = z.string().trim().min(1).max(MEMORY_CONTENT_MAX)

export const MemoryTag = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[^\s,#][^,#\r\n]*$/, 'A tag is one short word or phrase, without commas or #')
export type MemoryTag = z.infer<typeof MemoryTag>

const Score = z.number().min(0).max(1)

/** One remembered thing. Sensitive content is sealed and shown only when the person asks. */
export const MemoryEntry = z
  .object({
    memoryId: Uuidv7,
    type: MemoryType,
    /** Null when the content is hidden (sensitive, not revealed). */
    content: MemoryContent.nullable(),
    contentHidden: z.boolean(),
    source: MemorySource,
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    confidence: Score,
    importance: Score,
    tags: z.array(MemoryTag).max(20),
    relationships: z.array(MemoryRelationship).max(50),
    sensitivity: MemorySensitivity,
    sensitiveKinds: z.array(SensitiveKind).max(6),
    retention: MemoryRetention,
    layer: z.enum(['session', 'long-term']),
    /** A forgotten memory is kept but never recalled, until the person restores it. */
    state: z.enum(['active', 'forgotten']),
    /** How many times the person corrected it. */
    corrections: z.number().int().nonnegative()
  })
  .strict()
export type MemoryEntry = z.infer<typeof MemoryEntry>

// ---- Policy --------------------------------------------------------------------------------

export const MemoryDecision = z.enum(['SAVE', 'DO_NOT_SAVE', 'ASK_USER'])
export type MemoryDecision = z.infer<typeof MemoryDecision>

export const POLICY_REASON_CODES = [
  'explicit-request',
  'useful',
  'credential',
  'financial',
  'health',
  'biometric',
  'identity',
  'third-party',
  'duplicate',
  'low-importance',
  'low-confidence',
  'too-short',
  'person-saved',
  'person-declined',
  'expired'
] as const
export const PolicyReasonCode = z.enum(POLICY_REASON_CODES)
export type PolicyReasonCode = z.infer<typeof PolicyReasonCode>

export const PolicyReason = z
  .object({ code: PolicyReasonCode, detail: z.string().max(300) })
  .strict()
export type PolicyReason = z.infer<typeof PolicyReason>

/** Something that might be remembered, and what the proposer knows about it. */
export const MemoryCandidateInput = z
  .object({
    content: MemoryContent,
    type: MemoryType,
    source: MemorySource,
    tags: z.array(MemoryTag).max(20).default([]),
    relationships: z.array(MemoryRelationship).max(50).default([]),
    confidence: Score.default(0.9),
    importance: Score.default(0.5),
    retention: MemoryRetention.default({ kind: 'long-term' }),
    /** The person asked for this to be remembered (typed it, or said "remember that…"). */
    explicit: z.boolean()
  })
  .strict()
export type MemoryCandidateInput = z.input<typeof MemoryCandidateInput>

/** A candidate waiting for the person (`ASK_USER`). It is held in memory only, never stored. */
export const MemoryCandidate = z
  .object({
    candidateId: Uuidv7,
    type: MemoryType,
    content: MemoryContent,
    source: MemorySource,
    tags: z.array(MemoryTag).max(20),
    sensitivity: MemorySensitivity,
    sensitiveKinds: z.array(SensitiveKind).max(6),
    retention: MemoryRetention,
    reasons: z.array(PolicyReason).min(1).max(10),
    proposedAt: UtcTimestamp,
    /** Unanswered candidates are dropped, not saved, at this time. */
    expiresAt: UtcTimestamp
  })
  .strict()
export type MemoryCandidate = z.infer<typeof MemoryCandidate>

export const MemoryProposalResult = z
  .object({
    decision: MemoryDecision,
    reasons: z.array(PolicyReason).min(1).max(10),
    /** The saved memory (SAVE). */
    memory: MemoryEntry.nullable(),
    /** The candidate waiting for the person (ASK_USER). */
    candidate: MemoryCandidate.nullable(),
    /** The memory this repeats, when it is a duplicate. */
    duplicateOf: Uuidv7.nullable()
  })
  .strict()
export type MemoryProposalResult = z.infer<typeof MemoryProposalResult>

/** A record of a policy decision. It never holds the content. */
export const MemoryDecisionRecord = z
  .object({
    decisionId: Uuidv7,
    decidedAt: UtcTimestamp,
    decision: MemoryDecision,
    decidedBy: z.enum(['policy', 'person']),
    reasons: z.array(PolicyReasonCode).min(1).max(10),
    type: MemoryType,
    sourceKind: MemorySourceKind,
    sensitivity: MemorySensitivity,
    sensitiveKinds: z.array(SensitiveKind).max(6),
    memoryId: Uuidv7.nullable(),
    candidateId: Uuidv7.nullable()
  })
  .strict()
export type MemoryDecisionRecord = z.infer<typeof MemoryDecisionRecord>

// ---- Search --------------------------------------------------------------------------------

export const MemorySearchMode = z.enum(['metadata', 'keyword', 'relationship', 'semantic'])
export type MemorySearchMode = z.infer<typeof MemorySearchMode>

export const MemoryQuery = z
  .object({
    mode: MemorySearchMode,
    text: z.string().max(500),
    types: z.array(MemoryType).max(10),
    tags: z.array(MemoryTag).max(10),
    sensitivity: MemorySensitivity.nullable(),
    /** For `relationship`: the memory whose relations to follow. */
    relatedTo: Uuidv7.nullable(),
    includeForgotten: z.boolean(),
    minConfidence: Score,
    limit: z.number().int().min(1).max(200)
  })
  .strict()
export type MemoryQuery = z.infer<typeof MemoryQuery>

/** How semantic search went: which model on which computer, or why it was not used. */
export const SemanticSearchInfo = z
  .object({
    requested: z.boolean(),
    used: z.boolean(),
    providerId: ProviderId.nullable(),
    providerName: z.string().max(200).nullable(),
    modelId: ModelId.nullable(),
    locality: Locality.nullable(),
    reason: z.string().max(500).nullable()
  })
  .strict()
export type SemanticSearchInfo = z.infer<typeof SemanticSearchInfo>

export const MemorySearchHit = z
  .object({
    memory: MemoryEntry,
    matched: MemorySearchMode,
    /** Similarity or match strength, 0–1; null for metadata filters. */
    score: Score.nullable(),
    relation: z.enum(RELATIONSHIP_KINDS).nullable()
  })
  .strict()
export type MemorySearchHit = z.infer<typeof MemorySearchHit>

export const MemorySearchResult = z
  .object({
    hits: z.array(MemorySearchHit).max(200),
    total: z.number().int().nonnegative(),
    semantic: SemanticSearchInfo
  })
  .strict()
export type MemorySearchResult = z.infer<typeof MemorySearchResult>

export const MemoryStatus = z
  .object({
    longTerm: z.number().int().nonnegative(),
    session: z.number().int().nonnegative(),
    forgotten: z.number().int().nonnegative(),
    sensitive: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    /** Sensitive memories can be kept only when the operating system's secure storage works. */
    secureStorage: z.object({ available: z.boolean(), reason: z.string().max(500).nullable() }),
    semantic: z
      .object({
        enabled: z.boolean(),
        available: z.boolean(),
        reason: z.string().max(500).nullable(),
        providerName: z.string().max(200).nullable(),
        modelId: ModelId.nullable(),
        locality: Locality.nullable()
      })
      .strict()
  })
  .strict()
export type MemoryStatus = z.infer<typeof MemoryStatus>

/** A correction: every field that is present replaces the stored one. */
export const MemoryCorrection = z
  .object({
    memoryId: Uuidv7,
    content: MemoryContent.optional(),
    type: MemoryType.optional(),
    tags: z.array(MemoryTag).max(20).optional(),
    relationships: z.array(MemoryRelationship).max(50).optional(),
    importance: Score.optional(),
    confidence: Score.optional(),
    retention: MemoryRetention.optional()
  })
  .strict()
export type MemoryCorrection = z.infer<typeof MemoryCorrection>
