import { createServer } from 'node:http'

/**
 * A local OpenAI-compatible endpoint plus two static web pages, used by the
 * acceptance suite.
 *
 * It exercises Thursday's real provider adapter, real HTTP and real SSE
 * parsing. It is NOT a substitute for testing against a vendor API — it proves
 * Thursday's side of the contract, nothing about OpenAI's servers.
 */

const MODELS = [
  { id: 'mock-small', object: 'model' },
  { id: 'mock-large', object: 'model' }
]

const PAGE = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui;background:#0b1020;color:#dfe8ff;padding:40px">` +
  `<h1>${title}</h1><p>${body}</p></body></html>`

export function startMockProvider() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      if (url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: MODELS }))
        return
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          let request = {}
          try {
            request = JSON.parse(raw)
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'body was not JSON' } }))
            return
          }

          const last = [...(request.messages ?? [])].reverse().find((m) => m.role === 'user')
          const reply = `Echo from ${request.model}: ${last?.content ?? '(nothing)'}`
          const words = reply.split(' ')

          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })

          // Emit one SSE event per word so the client genuinely streams.
          let index = 0
          const tick = setInterval(() => {
            if (index >= words.length) {
              clearInterval(tick)
              res.write(
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
              )
              res.write('data: [DONE]\n\n')
              res.end()
              return
            }
            const text = (index === 0 ? '' : ' ') + words[index++]
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
          }, 12)
        })
        return
      }

      if (url.pathname === '/page1') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(PAGE('Page One', 'First page of the navigation test.'))
        return
      }
      if (url.pathname === '/page2') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(PAGE('Page Two', 'Second page of the navigation test.'))
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}
