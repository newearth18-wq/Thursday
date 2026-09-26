/**
 * A Server-Sent Events reader for provider streams.
 *
 * Reads the response body as it arrives and yields one message per blank-line
 * terminated event. Guards against a misbehaving server: a single line longer
 * than `maxLineLength` ends the stream with an error instead of growing
 * memory without bound. Cancelling (breaking out of the loop, or the request's
 * AbortSignal) cancels the body, which closes the connection.
 */

export interface SseMessage {
  readonly event: string
  readonly data: string
}

export class SseLineTooLong extends Error {
  constructor() {
    super('The provider sent an event line that is too long.')
    this.name = 'SseLineTooLong'
  }
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  maxLineLength = 1_048_576
): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let event = ''
  let data: string[] = []
  const take = (line: string): SseMessage | null => {
    if (line === '') {
      if (data.length === 0) {
        event = ''
        return null
      }
      const message = { event: event || 'message', data: data.join('\n') }
      event = ''
      data = []
      return message
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    return null
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline = buffer.search(/\r\n|\r|\n/)
      while (newline !== -1) {
        // A lone \r at the very end may be the first half of \r\n split across chunks.
        if (!done && newline === buffer.length - 1 && buffer.endsWith('\r')) break
        const line = buffer.slice(0, newline)
        const length = buffer.startsWith('\r\n', newline) ? 2 : 1
        buffer = buffer.slice(newline + length)
        const message = take(line)
        if (message) yield message
        newline = buffer.search(/\r\n|\r|\n/)
      }
      if (buffer.length > maxLineLength) throw new SseLineTooLong()
      if (done) {
        if (buffer) {
          const message = take(buffer)
          if (message) yield message
        }
        const last = take('')
        if (last) yield last
        return
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
