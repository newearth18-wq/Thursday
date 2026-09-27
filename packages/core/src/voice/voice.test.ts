import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, pcmFromBytes, rms, wavDuration, wavFromPcm } from './audio'
import { isStopRequest, languageOf, matchWakeWord, spokenLanguage } from './phrases'
import { VoiceActivityDetector } from './vad'

const RATE = 16_000

function tone(ms: number, amplitude: number): Int16Array {
  const samples = new Int16Array(Math.round((RATE * ms) / 1000))
  for (let index = 0; index < samples.length; index++)
    samples[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / RATE) * amplitude * 32767)
  return samples
}

function silence(ms: number, noise = 0): Int16Array {
  const samples = new Int16Array(Math.round((RATE * ms) / 1000))
  for (let index = 0; index < samples.length; index++)
    samples[index] = noise ? Math.round((((index * 7919) % 200) / 100 - 1) * noise * 32767) : 0
  return samples
}

describe('voice audio helpers', () => {
  it('round-trips base64 and PCM exactly', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234, -4321])
    const bytes = new Uint8Array(samples.buffer)
    for (const length of [0, 1, 2, 3, bytes.length]) {
      const part = bytes.subarray(0, length)
      expect([...base64ToBytes(bytesToBase64(part))]).toEqual([...part])
      expect(bytesToBase64(part)).toBe(Buffer.from(part).toString('base64'))
    }
    expect([...pcmFromBytes(bytes)]).toEqual([...samples])
  })

  it('writes a WAV whose header gives its real length', () => {
    const wav = wavFromPcm(tone(500, 0.3))
    expect(Buffer.from(wav.subarray(0, 4)).toString('ascii')).toBe('RIFF')
    expect(wavDuration(wav)).toBe(500)
    expect(rms(tone(100, 0.5))).toBeGreaterThan(0.3)
    expect(rms(silence(100))).toBe(0)
  })
})

describe('voice activity detection', () => {
  it('finds one stretch of speech between silences, with its length', () => {
    const vad = new VoiceActivityDetector('medium')
    const events = [
      ...vad.push(silence(600, 0.002)),
      ...vad.push(tone(900, 0.3)),
      ...vad.push(silence(1000, 0.002))
    ]
    expect(events.map((event) => event.type)).toEqual(['speech-start', 'speech-end'])
    const end = events[1]
    if (end?.type !== 'speech-end') throw new Error('no end')
    // The speech, a little lead-in and the trailing silence that ended it.
    expect(end.durationMs).toBeGreaterThanOrEqual(900)
    expect(end.durationMs).toBeLessThan(2000)
    expect(vad.speechDetected).toBe(true)
  })

  it('does not treat steady quiet noise as speech', () => {
    const vad = new VoiceActivityDetector('high')
    expect(vad.push(silence(3000, 0.004))).toEqual([])
    expect(vad.speechDetected).toBe(false)
  })

  it('needs louder speech at low sensitivity', () => {
    const quiet = tone(800, 0.025)
    expect(new VoiceActivityDetector('high').push(quiet).map((event) => event.type)).toContain(
      'speech-start'
    )
    expect(new VoiceActivityDetector('low').push(quiet)).toEqual([])
  })
})

describe('voice phrases', () => {
  it('finds the wake word in English and Thai, and what followed it', () => {
    expect(matchWakeWord('Jupiter, what is the largest planet?', 'Jupiter')).toEqual({
      matched: true,
      rest: 'what is the largest planet'
    })
    expect(matchWakeWord('จูปิเตอร์ ดาวเคราะห์ดวงใหญ่ที่สุดคืออะไร', 'Jupiter').matched).toBe(true)
    expect(matchWakeWord('I like the planet Saturn', 'Jupiter').matched).toBe(false)
    expect(matchWakeWord('hey computer', 'Computer')).toEqual({ matched: true, rest: '' })
    expect(matchWakeWord('supercomputer', 'Computer').matched).toBe(false)
  })

  it('recognizes requests to stop, and nothing else', () => {
    for (const text of ['Stop.', 'stop please', 'Be quiet!', 'หยุด', 'พอแล้วครับ', 'Jupiter, stop'])
      expect(isStopRequest(text), text).toBe(true)
    for (const text of ['Stop the music in the next room', 'What is a bus stop?', 'ดาวอังคาร'])
      expect(isStopRequest(text), text).toBe(false)
  })

  it('tells Thai from English', () => {
    expect(languageOf('ดาวเคราะห์ดวงใหญ่ที่สุดคืออะไร', 'en')).toBe('th')
    expect(languageOf('What is the largest planet?', 'th')).toBe('en')
    expect(languageOf('123', 'th')).toBe('th')
    expect(spokenLanguage('english')).toBe('en')
    expect(spokenLanguage('th')).toBe('th')
    expect(spokenLanguage('fr')).toBeNull()
  })
})
