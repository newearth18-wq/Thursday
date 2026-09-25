import { z } from 'zod'

/**
 * Who is asking. The actor is always assigned by the trusted side that
 * received the request (for example the host gateway assigns
 * `user-interface` to the main window) and is never taken from the request
 * payload, so a sender cannot claim to be someone else.
 */
export const ActorType = z.enum([
  /** The Jupiter window (renderer), after sender and origin validation. */
  'user-interface',
  /** The Electron main process (host gateway). */
  'host',
  /** Jupiter Core itself. */
  'core',
  /** Future isolated runtimes (SET 8, 9). */
  'runtime',
  /** Future plugins (SET 15). */
  'plugin',
  /** Future automations (SET 18). */
  'automation',
  /** A sender that failed sender/origin validation. Only ever appears in audit records. */
  'unverified'
])
export type ActorType = z.infer<typeof ActorType>

export const Actor = z
  .object({
    type: ActorType,
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
  })
  .strict()
export type Actor = z.infer<typeof Actor>

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
export type RiskLevel = z.infer<typeof RiskLevel>
