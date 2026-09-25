import { z } from 'zod'

/**
 * Primitive building blocks reused by every contract.
 *
 * Jupiter uses UUIDv7 for every identifier (sortable by creation time) and
 * UTC ISO-8601 timestamps for every point in time. Presentation code localises
 * them; nothing stored or transmitted is ever in local time.
 */

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const Uuidv7 = z.string().regex(UUID_V7_PATTERN, 'Expected a lowercase UUIDv7')
export type Uuidv7 = z.infer<typeof Uuidv7>

/** UTC ISO-8601 timestamp with a trailing `Z`, e.g. `2026-09-25T10:00:00.000Z`. */
export const UtcTimestamp = z.iso.datetime({ offset: false })
export type UtcTimestamp = z.infer<typeof UtcTimestamp>

/** Strict semantic version (2.0.0), including pre-release and build metadata. */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export const SemVer = z.string().regex(SEMVER_PATTERN, 'Expected a semantic version')
export type SemVer = z.infer<typeof SemVer>

/** Stable, lowercase, kebab-case identifier used for services and components. */
export const ServiceId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Expected a kebab-case identifier')
export type ServiceId = z.infer<typeof ServiceId>
