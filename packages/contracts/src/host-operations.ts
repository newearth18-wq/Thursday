import { z } from 'zod'
import { ApiKeyInput } from './ai'
import { Uuidv7 } from './primitives'

/**
 * Host operations Jupiter Core uses internally (SET 3).
 *
 * Unlike the capability catalogue, nothing here can be requested by the
 * interface or any other actor: the dispatcher has no capability with these
 * names, so the only caller is Jupiter Core itself, over the host↔Core port,
 * while it carries out a capability that was already authorized (saving a
 * key) or while it talks to a provider (reading a key for one request).
 *
 * The secret crosses only the host↔Core port. It is never logged, never
 * stored outside the operating system's secure storage, and never sent to
 * the interface.
 */
export const HostOperations = {
  'host.credentials.store': {
    input: z.object({ credentialId: Uuidv7, secret: ApiKeyInput }).strict(),
    /** The fingerprint (first 8 hex characters of the key's SHA-256) tells keys apart and reveals nothing. */
    output: z
      .object({
        stored: z.literal(true),
        fingerprint: z.string().regex(/^[0-9a-f]{8}$/)
      })
      .strict()
  },
  'host.credentials.read': {
    input: z.object({ credentialId: Uuidv7 }).strict(),
    output: z.object({ secret: z.string().min(1).max(512) }).strict()
  },
  'host.credentials.delete': {
    input: z.object({ credentialId: Uuidv7 }).strict(),
    output: z.object({ deleted: z.boolean() }).strict()
  }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

export type HostOperationName = keyof typeof HostOperations
export type HostOperationInput<O extends HostOperationName> = z.infer<
  (typeof HostOperations)[O]['input']
>
export type HostOperationOutput<O extends HostOperationName> = z.infer<
  (typeof HostOperations)[O]['output']
>

export const HOST_OPERATION_NAMES = Object.keys(HostOperations) as HostOperationName[]
