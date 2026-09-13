import { createServer } from 'node:http'

/**
 * A local OpenAI-compatible endpoint, two static web pages and a downloadable
 * file, used by the acceptance suite.
 *
 * It exercises Thursday's real provider adapter, real HTTP and real SSE
 * parsing. It is NOT a substitute for testing against a vendor API — it proves
 * Thursday's side of the contract, nothing about OpenAI's servers.
 *
 * The model's behaviour is *scripted*, not intelligent: the suite puts a
 * directive in the prompt and the mock obeys it. That is deliberate. A real
 * model chooses whether to call a tool, so it can never be asserted on
 * reliably; scripting the decision makes the test about the thing actually
 * under test — Thursday's handling of a tool call once one arrives.
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

          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })

          const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
          const finish = (reason) => {
            send({ choices: [{ delta: {}, finish_reason: reason }] })
            res.write('data: [DONE]\n\n')
            res.end()
          }

          const messages = request.messages ?? []
          const last = [...messages].reverse().find((m) => m.role === 'user')
          const prompt = last?.content ?? ''
          const system = messages.find((m) => m.role === 'system')?.content ?? ''

          /* --- scripted tool call --------------------------------------- */
          // The suite writes [[call:<tool> <json>]] into the prompt when it
          // wants the model to request a tool. Anything else is a plain reply,
          // which is how the second round of a tool conversation ends.
          const directive = /\[\[call:([\w.\-]+)\s*(\{.*?\})?\]\]/s.exec(prompt)
          if (directive && Array.isArray(request.tools) && request.tools.length > 0) {
            const name = directive[1]
            const args = directive[2] ?? '{}'
            // Fragmented exactly as OpenAI streams them, so the client's
            // reassembly-by-index path is the one under test.
            send({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_mock_1', function: { name, arguments: '' } }
                    ]
                  }
                }
              ]
            })
            const halfway = Math.ceil(args.length / 2)
            send({
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, halfway) } }] } }
              ]
            })
            send({
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(halfway) } }] } }
              ]
            })
            finish('tool_calls')
            return
          }

          /* --- scripted plan -------------------------------------------- */
          // planMission() identifies itself in the system prompt and lists the
          // registered skills as "- <id>: ...". The mock reads that list back,
          // so the plan it returns can only ever name skills that really exist.
          if (/planning component/i.test(system)) {
            const ids = [...prompt.matchAll(/^- ([\w.\-]+):/gm)].map((m) => m[1])

            // [[badplan]] in the goal makes the model name a skill that does
            // not exist, so the planner's validation can be tested directly.
            if (prompt.includes('[[badplan]]')) {
              const bad = JSON.stringify({
                steps: [{ title: 'Impossible step', skillId: 'ghost-plugin.no_such_skill', input: {} }]
              })
              send({ choices: [{ delta: { content: bad } }] })
              finish('stop')
              return
            }

            const plan = {
              steps: ids.slice(0, 2).map((id, index) => ({
                title: `Scripted step ${index + 1}`,
                skillId: id,
                input: id.endsWith('echo_text') ? { text: 'planned by the model' } : {},
                requiresApproval: false
              }))
            }
            if (plan.steps.length === 0) {
              plan.steps = [{ title: 'Scripted checkpoint', skillId: null, input: {}, requiresApproval: false }]
            }
            // Wrapped in a code fence on purpose: real models do this, and the
            // parser is supposed to cope.
            const text = '```json\n' + JSON.stringify(plan) + '\n```'
            for (const piece of text.match(/.{1,20}/gs) ?? []) {
              send({ choices: [{ delta: { content: piece } }] })
            }
            finish('stop')
            return
          }

          /* --- plain echo ------------------------------------------------ */
          const reply = `Echo from ${request.model}: ${prompt || '(nothing)'}`
          const words = reply.split(' ')
          let index = 0
          const tick = setInterval(() => {
            if (index >= words.length) {
              clearInterval(tick)
              finish('stop')
              return
            }
            const text = (index === 0 ? '' : ' ') + words[index++]
            send({ choices: [{ delta: { content: text } }] })
          }, 12)
        })
        return
      }

      // A real attachment, so Electron's download pipeline actually engages.
      if (url.pathname === '/download/sample.txt') {
        const body = 'downloaded by the acceptance suite\n'
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="sample.txt"',
          'content-length': Buffer.byteLength(body)
        })
        res.end(body)
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
