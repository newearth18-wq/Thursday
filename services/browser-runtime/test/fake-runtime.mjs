// A stand-in process that speaks the browser runtime's protocol over the IPC
// channel, to test the transport (start, replies, errors, hangs, crashes)
// without a browser.
const config = JSON.parse(process.env.JUPITER_BROWSER_CONFIG ?? '{}')
if (typeof config.executablePath !== 'string') process.exit(2)

const send = (value) => process.send?.(value)

send({ id: 0, ok: true, result: { pid: process.pid } })
process.on('disconnect', () => process.exit(0))
process.on('message', (request) => {
  switch (request.op) {
    case 'ping':
      send({
        id: request.id,
        ok: true,
        result:
          process.env.FAKE_BAD_PING === '1'
            ? { pid: 'not a number', version: null, sessions: 0 }
            : { pid: process.pid, version: 'fake 1.0', sessions: 0 }
      })
      break
    case 'echo':
      send({ id: request.id, ok: true, result: request.params })
      break
    case 'fail':
      send({
        id: request.id,
        ok: false,
        error: { code: 'ELEMENT_NOT_FOUND', message: 'Nothing on the page matches.' }
      })
      break
    case 'hang':
      break
    case 'crash':
      process.stderr.write('fake runtime: crashing on purpose\n')
      process.exit(3)
      break
    case 'exit-after-reply':
      send({ id: request.id, ok: true, result: {} })
      setTimeout(() => process.exit(4), 50)
      break
  }
})
