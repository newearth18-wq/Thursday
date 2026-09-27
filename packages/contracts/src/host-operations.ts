import { z } from 'zod'
import { ApiKeyInput } from './ai'
import { BrowserCall } from './browser'
import { AutomationCall } from './computer'
import { FileCall } from './files'
import { NoteCall } from './notes'
import { Uuidv7 } from './primitives'
import { MicrophoneGateInput, SystemSpeech, SystemSpeechInput, SystemVoices } from './voice'

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
  },
  /**
   * The Windows Computer Agent's calls (SET 8). The result is checked by
   * Core against the operation's own result schema (`AutomationOps`).
   */
  'host.computer.call': { input: AutomationCall, output: z.unknown() },
  /**
   * The Browser Agent's calls (SET 9). The result is checked by Core
   * against the operation's own result schema (`BrowserOps`).
   */
  'host.browser.call': { input: BrowserCall, output: z.unknown() },
  /**
   * The File Agent's and Artifact Manager's calls (SET 10). The result is
   * checked by Core against the operation's own result schema (`FileOps`).
   */
  'host.files.call': { input: FileCall, output: z.unknown() },
  /**
   * Seals text with the operating system's secure storage (SET 11), for
   * sensitive memories the person chose to keep. The sealed form is
   * meaningless without this user account on this computer.
   */
  /**
   * SET 12: the operating system's voice (Windows SAPI; espeak-ng where it is
   * installed), and the microphone gate. The host refuses the microphone to
   * the interface unless Core has opened the gate for a session the person
   * started, and closes it when the session ends or its time runs out.
   */
  'host.speech.voices': { input: z.object({}).strict(), output: SystemVoices },
  'host.speech.synthesize': { input: SystemSpeechInput, output: SystemSpeech },
  'host.microphone.gate': {
    input: MicrophoneGateInput,
    output: z.object({ open: z.boolean() }).strict()
  },
  'host.vault.status': {
    input: z.object({}).strict(),
    output: z.object({ available: z.boolean(), reason: z.string().max(500).nullable() }).strict()
  },
  'host.vault.seal': {
    input: z.object({ text: z.string().min(1).max(8_000) }).strict(),
    output: z.object({ sealed: z.string().min(1).max(20_000) }).strict()
  },
  'host.vault.unseal': {
    input: z.object({ sealed: z.string().min(1).max(20_000) }).strict(),
    output: z.object({ text: z.string().max(8_000) }).strict()
  },
  /**
   * Obsidian notes (SET 11). The result is checked by Core against the
   * operation's own result schema (`NoteOps`).
   */
  'host.notes.call': { input: NoteCall, output: z.unknown() }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

export type HostOperationName = keyof typeof HostOperations
export type HostOperationInput<O extends HostOperationName> = z.infer<
  (typeof HostOperations)[O]['input']
>
export type HostOperationOutput<O extends HostOperationName> = z.infer<
  (typeof HostOperations)[O]['output']
>

export const HOST_OPERATION_NAMES = Object.keys(HostOperations) as HostOperationName[]
