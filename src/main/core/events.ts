import type { IpcEvents } from '@shared/ipc.js'

/**
 * One-way main -> renderer event bus.
 *
 * Modules publish here without knowing anything about windows or webContents;
 * `src/main/index.ts` installs the transport once the UI window exists. That
 * keeps every feature module free of Electron window plumbing.
 */

type Transport = <E extends keyof IpcEvents>(event: E, payload: IpcEvents[E]) => void

let transport: Transport | null = null

/** Buffered until the UI window is ready, so early boot events are not lost. */
const pending: { event: keyof IpcEvents; payload: unknown }[] = []
const MAX_PENDING = 200

export function setEventTransport(next: Transport | null): void {
  transport = next
  if (!transport) return
  const queued = pending.splice(0, pending.length)
  for (const item of queued) {
    transport(item.event as keyof IpcEvents, item.payload as never)
  }
}

export function emit<E extends keyof IpcEvents>(event: E, payload: IpcEvents[E]): void {
  if (transport) {
    try {
      transport(event, payload)
    } catch {
      // A destroyed window must never break the emitting module.
    }
    return
  }
  if (pending.length < MAX_PENDING) pending.push({ event, payload })
}
