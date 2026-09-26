import { z } from 'zod'
import { ActorType, RiskLevel } from './actor'
import { PermissionName, SkillId } from './plans'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The Permission Engine (SET 7).
 *
 * Every action with an effect is a capability. Nothing may use one without a
 * grant that matches its capability, requester, exact target, Mission, session
 * and expiry. Anything else is denied by default. Grants come only from the
 * person's answer to a permission request (or from Jupiter's visible default
 * policy, which the person can revoke). Content — a web page, a document,
 * a model's answer — can never create a grant or change policy.
 */

export interface CapabilityInfo {
  readonly risk: RiskLevel
  /** What it does, in plain words. */
  readonly summary: string
  /** What happens if it is allowed. */
  readonly consequence: string
  readonly reversible: boolean
  /** What leaves this computer when it is used, or null. */
  readonly dataLeavesDevice: string | null
}

/** Every capability Jupiter knows. An unknown capability is always denied. */
export const PERMISSION_CATALOGUE = {
  'app.version.read': {
    risk: 'LOW',
    summary: 'Read the version of this Jupiter build',
    consequence: 'The version, channel and commit become part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'system.time.read': {
    risk: 'LOW',
    summary: 'Read the computer clock and time zone',
    consequence: 'The current time and time zone become part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'skills.read': {
    risk: 'LOW',
    summary: 'Read the list of Skills',
    consequence: 'Skill names, versions and health become part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'memory.read': {
    risk: 'MEDIUM',
    summary: 'Read what Jupiter remembers',
    consequence: 'Stored memories become part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'memory.write': {
    risk: 'MEDIUM',
    summary: 'Change what Jupiter remembers',
    consequence: 'A memory is added or changed.',
    reversible: true,
    dataLeavesDevice: null
  },
  'files.read': {
    risk: 'MEDIUM',
    summary: 'Read a file',
    consequence: 'The file content becomes part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'files.write': {
    risk: 'HIGH',
    summary: 'Create or change a file',
    consequence: 'The file is written; an existing file is changed.',
    reversible: false,
    dataLeavesDevice: null
  },
  'network.request': {
    risk: 'MEDIUM',
    summary: 'Send a request over the network',
    consequence: 'A request is sent to the address.',
    reversible: false,
    dataLeavesDevice: 'The request, including anything it contains.'
  },
  'computer.open_app': {
    risk: 'MEDIUM',
    summary: 'Open an application',
    consequence: 'The application starts.',
    reversible: true,
    dataLeavesDevice: null
  },
  'computer.type': {
    risk: 'HIGH',
    summary: 'Type with the keyboard',
    consequence: 'Keystrokes go to the application in front.',
    reversible: false,
    dataLeavesDevice: null
  },
  'computer.read_screen': {
    risk: 'HIGH',
    summary: 'Read what is on the screen',
    consequence: 'An image or text of the screen becomes part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'computer.manage_window': {
    risk: 'LOW',
    summary: 'Move, resize or focus a window',
    consequence: 'The window changes position, size or focus.',
    reversible: true,
    dataLeavesDevice: null
  },
  'computer.click': {
    risk: 'HIGH',
    summary: 'Click, select or scroll controls in an application',
    consequence: 'The control does what it does when you click it.',
    reversible: false,
    dataLeavesDevice: null
  },
  'computer.click_point': {
    risk: 'HIGH',
    summary: 'Click a point in a window (coordinate fallback)',
    consequence:
      'Whatever is at that point in the window is clicked, without knowing which control it is.',
    reversible: false,
    dataLeavesDevice: null
  },
  'computer.delete_file': {
    risk: 'CRITICAL',
    summary: 'Delete a file',
    consequence: 'The file is deleted.',
    reversible: false,
    dataLeavesDevice: null
  },
  'files.delete_bulk': {
    risk: 'CRITICAL',
    summary: 'Delete many files at once',
    consequence: 'All matching files are deleted.',
    reversible: false,
    dataLeavesDevice: null
  },
  'browser.navigate': {
    risk: 'MEDIUM',
    summary: 'Open a web page',
    consequence: 'The page is loaded.',
    reversible: true,
    dataLeavesDevice: 'The address of the page.'
  },
  'browser.download': {
    risk: 'MEDIUM',
    summary: 'Download a file from the web',
    consequence: 'A file is saved on this computer.',
    reversible: true,
    dataLeavesDevice: 'The address of the file.'
  },
  'browser.upload': {
    risk: 'CRITICAL',
    summary: 'Upload a file to a website',
    consequence: 'The file is sent to the website.',
    reversible: false,
    dataLeavesDevice: 'The whole file.'
  },
  'browser.submit_form': {
    risk: 'HIGH',
    summary: 'Submit a form on a website',
    consequence: 'The form is sent, which may create an order, account or message.',
    reversible: false,
    dataLeavesDevice: 'Everything entered in the form.'
  },
  'camera.read': {
    risk: 'HIGH',
    summary: 'Use the camera',
    consequence: 'Images from the camera become part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'microphone.listen': {
    risk: 'HIGH',
    summary: 'Use the microphone',
    consequence: 'Sound from the microphone becomes part of the result.',
    reversible: true,
    dataLeavesDevice: null
  },
  'email.send': {
    risk: 'HIGH',
    summary: 'Send an email',
    consequence: 'The email is delivered to its recipients.',
    reversible: false,
    dataLeavesDevice: 'The email, its recipients and attachments.'
  },
  'plugin.install': {
    risk: 'CRITICAL',
    summary: 'Install a plugin',
    consequence: 'New code is added to Jupiter.',
    reversible: true,
    dataLeavesDevice: null
  },
  'shell.execute': {
    risk: 'CRITICAL',
    summary: 'Run a command in a shell',
    consequence: 'The command runs with your account’s rights.',
    reversible: false,
    dataLeavesDevice: null
  },
  'system.configure': {
    risk: 'CRITICAL',
    summary: 'Change a system setting',
    consequence: 'The setting changes for the whole computer.',
    reversible: false,
    dataLeavesDevice: null
  },
  'credentials.change': {
    risk: 'CRITICAL',
    summary: 'Change a password or key',
    consequence: 'The credential is replaced.',
    reversible: false,
    dataLeavesDevice: null
  },
  'payment.make': {
    risk: 'CRITICAL',
    summary: 'Make a purchase or payment',
    consequence: 'Money is spent.',
    reversible: false,
    dataLeavesDevice: 'Payment details and the order.'
  }
} as const satisfies Record<string, CapabilityInfo>
export type KnownCapability = keyof typeof PERMISSION_CATALOGUE

export function capabilityInfo(name: string): CapabilityInfo | null {
  return (PERMISSION_CATALOGUE as Record<string, CapabilityInfo | undefined>)[name] ?? null
}

export const PermissionDecision = z.enum(['ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW', 'DENY'])
export type PermissionDecision = z.infer<typeof PermissionDecision>

/** CRITICAL actions ask every time: only these answers are offered for them. */
export function offeredDecisions(risk: RiskLevel): PermissionDecision[] {
  return risk === 'CRITICAL'
    ? ['ALLOW_ONCE', 'DENY']
    : ['ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW', 'DENY']
}

/** Who wants to use the capability. */
export const PermissionSubject = z
  .object({
    kind: z.enum(['skill', 'plugin', 'automation', 'agent', 'core']),
    id: z.string().min(1).max(64),
    /** Shown to the person, e.g. the Skill's name. */
    name: z.string().min(1).max(120)
  })
  .strict()
export type PermissionSubject = z.infer<typeof PermissionSubject>

export const PermissionRequestStatus = z.enum(['PENDING', 'ALLOWED', 'DENIED', 'EXPIRED'])
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatus>

export const PermissionRequest = z
  .object({
    requestId: Uuidv7,
    capability: PermissionName,
    subject: PermissionSubject,
    /** Who set the work in motion (the person, Core for a Mission, an automation). */
    actor: ActorType,
    /** The exact target, e.g. a file path or `jupiter:app-version`. */
    target: z.string().min(1).max(500),
    /** Why it is needed. Untrusted text, shown as text. */
    reason: z.string().max(500),
    risk: RiskLevel,
    summary: z.string().max(200),
    consequence: z.string().max(300),
    reversible: z.boolean(),
    dataLeavesDevice: z.string().max(300).nullable(),
    missionId: Uuidv7.nullable(),
    missionTitle: z.string().max(120).nullable(),
    stepId: Uuidv7.nullable(),
    stepTitle: z.string().max(200).nullable(),
    skillId: SkillId.nullable(),
    offered: z.array(PermissionDecision).min(2).max(4),
    status: PermissionRequestStatus,
    decision: PermissionDecision.nullable(),
    createdAt: UtcTimestamp,
    decidedAt: UtcTimestamp.nullable()
  })
  .strict()
export type PermissionRequest = z.infer<typeof PermissionRequest>

export const GrantKind = z.enum(['ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW'])
export type GrantKind = z.infer<typeof GrantKind>

export const GrantState = z.enum(['ACTIVE', 'USED', 'EXPIRED', 'REVOKED'])
export type GrantState = z.infer<typeof GrantState>

export const PermissionGrant = z
  .object({
    grantId: Uuidv7,
    capability: PermissionName,
    subject: PermissionSubject,
    /** Exact target; a trailing `*` matches anything that starts with the rest. */
    target: z.string().min(1).max(500),
    /** Only for this Mission, or null for any. */
    missionId: Uuidv7.nullable(),
    kind: GrantKind,
    /** For ALLOW_SESSION: the Core session it belongs to. */
    sessionId: Uuidv7.nullable(),
    state: GrantState,
    /** The person (`user-interface`) or Jupiter's default policy (`core`). */
    createdBy: ActorType,
    requestId: Uuidv7.nullable(),
    reason: z.string().max(300),
    createdAt: UtcTimestamp,
    expiresAt: UtcTimestamp.nullable(),
    usedAt: UtcTimestamp.nullable(),
    endedAt: UtcTimestamp.nullable()
  })
  .strict()
export type PermissionGrant = z.infer<typeof PermissionGrant>

export const PermissionAuditAction = z.enum([
  'evaluated',
  'requested',
  'decided',
  'grant-created',
  'grant-used',
  'grant-revoked',
  'grant-expired',
  'request-expired',
  'refused'
])

/** One entry of the permission audit trail. Targets and reasons are redacted. */
export const PermissionAuditEntry = z
  .object({
    entryId: Uuidv7,
    at: UtcTimestamp,
    action: PermissionAuditAction,
    capability: z.string().max(64),
    subjectKind: z.string().max(16).nullable(),
    subjectId: z.string().max(64).nullable(),
    target: z.string().max(500).nullable(),
    /** ALLOWED, DENIED, ASKED, or the decision the person made. */
    outcome: z.string().max(32),
    detail: z.string().max(300),
    actor: ActorType,
    missionId: Uuidv7.nullable(),
    requestId: Uuidv7.nullable(),
    grantId: Uuidv7.nullable()
  })
  .strict()
export type PermissionAuditEntry = z.infer<typeof PermissionAuditEntry>

export const CapabilityCatalogueEntry = z
  .object({
    capability: PermissionName,
    risk: RiskLevel,
    summary: z.string().max(200),
    consequence: z.string().max(300),
    reversible: z.boolean(),
    dataLeavesDevice: z.string().max(300).nullable()
  })
  .strict()
