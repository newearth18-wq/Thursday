// A stand-in process that speaks the agent runtime's wire protocol, to test
// the transport (start, replies, errors, hangs, crashes) on any platform.
import { createInterface } from 'node:readline'

const send = (value) =>
  process.stdout.write(`${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}\n`)

send({ id: 0, ok: true, result: { ready: true, pid: process.pid } })
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
  switch (request.op) {
    case 'ping':
      send({
        id: request.id,
        ok: true,
        result: { pid: process.pid, psVersion: 'fake', screen: { width: 1024, height: 768 } }
      })
      break
    case 'echo':
      send({ id: request.id, ok: true, result: request.params })
      break
    case 'fail':
      send({
        id: request.id,
        ok: false,
        error: { code: 'ELEMENT_NOT_FOUND', message: 'No control matches.' }
      })
      break
    case 'bad-reply':
      send({ id: request.id, ok: true, result: { pid: 'not a number' } })
      break
    case 'hang':
      break
    case 'crash':
      process.stderr.write('fake runtime: crashing on purpose\n')
      process.exit(3)
  }
})
