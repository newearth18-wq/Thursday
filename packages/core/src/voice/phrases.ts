import type { SpokenLanguage } from '@jupiter/contracts'

/**
 * Words the voice pipeline listens for (SET 12), in English and Thai:
 * the wake word, and requests to stop speaking (barge-in).
 */

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Thai spellings of the default wake word, as speech-to-text engines write it. */
const JUPITER_THAI = ['จูปิเตอร์', 'จูปีเตอร์', 'จูปิเตอ', 'ยูปิเตอร์']

/**
 * Whether the transcript starts with (or contains) the wake word, and what
 * was said after it (which may already be the request).
 */
export function matchWakeWord(
  transcript: string,
  phrase: string
): { matched: boolean; rest: string } {
  const text = normalizeSpeech(transcript)
  const wanted = normalizeSpeech(phrase)
  const variants = wanted === 'jupiter' ? [wanted, ...JUPITER_THAI] : [wanted]
  for (const variant of variants) {
    const at = text.indexOf(variant)
    if (at === -1) continue
    // A whole word, or a Thai word (Thai has no spaces between words).
    const before = at === 0 || text[at - 1] === ' ' || /[฀-๿]/.test(variant)
    if (!before) continue
    return { matched: true, rest: text.slice(at + variant.length).trim() }
  }
  return { matched: false, rest: '' }
}

const STOP_WORDS = [
  'stop',
  'stop it',
  'stop talking',
  'be quiet',
  'quiet',
  'cancel',
  'that is enough',
  "that's enough",
  'enough',
  'หยุด',
  'หยุดพูด',
  'พอแล้ว',
  'พอ',
  'เงียบ',
  'ยกเลิก'
]

/** Whether the whole utterance is a request to stop ("stop", "หยุด", …). */
export function isStopRequest(transcript: string): boolean {
  const text = normalizeSpeech(transcript)
    .replace(/\b(please|jupiter)\b/g, '')
    .replace(/(ครับ|ค่ะ|คะ|นะ)/g, '')
    .trim()
  return STOP_WORDS.includes(text)
}

/** Thai if the text is written in Thai script, otherwise English. */
export function languageOf(text: string, fallback: SpokenLanguage): SpokenLanguage {
  if (/[฀-๿]/.test(text)) return 'th'
  if (/[a-z]/i.test(text)) return 'en'
  return fallback
}

/** A provider's language name (`en`, `english`, `th`, `thai`) as a spoken language. */
export function spokenLanguage(value: string | null): SpokenLanguage | null {
  if (!value) return null
  const text = value.toLowerCase()
  if (text.startsWith('th')) return 'th'
  if (text.startsWith('en')) return 'en'
  return null
}
