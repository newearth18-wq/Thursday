// Regenerates packages/testing/fixtures/voice/*.wav with espeak-ng (tests only).
// Each recording is real synthesized speech with silence before and after, so
// voice activity detection sees a clear start and end.
//   node packages/testing/scripts/make-voice-fixtures.mjs
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'fixtures', 'voice')

export const VOICE_FIXTURES = {
  'en-question': { voice: 'en-us', text: 'What is the largest planet?' },
  'en-wake': { voice: 'en-us', text: 'Jupiter. What is the largest planet?' },
  'en-stop': { voice: 'en-us', text: 'Stop.' },
  'th-question': { voice: 'th', text: 'ดาวเคราะห์ดวงใหญ่ที่สุดคืออะไร' }
}

function pad(wav, beforeMs, afterMs) {
  const rate = wav.readUInt32LE(24)
  const dataAt = wav.indexOf('data', 12, 'ascii')
  const data = wav.subarray(dataAt + 8)
  const silence = (ms) => Buffer.alloc(Math.round((rate * ms) / 1000) * 2)
  const body = Buffer.concat([silence(beforeMs), data, silence(afterMs)])
  const header = Buffer.from(wav.subarray(0, 44))
  header.writeUInt32LE(36 + body.byteLength, 4)
  header.writeUInt32LE(body.byteLength, 40)
  return Buffer.concat([header, body])
}

for (const [name, { voice, text }] of Object.entries(VOICE_FIXTURES)) {
  const result = spawnSync('espeak-ng', ['--stdin', '--stdout', '-v', voice, '-s', '160'], {
    input: text
  })
  if (result.status !== 0) throw new Error(`espeak-ng failed for ${name}: ${String(result.stderr)}`)
  writeFileSync(join(out, `${name}.wav`), pad(result.stdout, 1000, 1500))
  console.log(`${name}.wav: ${text}`)
}
