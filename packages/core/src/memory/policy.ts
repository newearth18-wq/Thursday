import type { MemoryDecision, MemoryType, PolicyReason, SensitiveKind } from '@jupiter/contracts'
import { findSecrets } from '@jupiter/security'

/**
 * The Memory Policy (SET 11): one decision for every candidate, with its
 * reasons, decided from the content itself — never from what the content
 * asks for.
 *
 * - A credential (a password, key, code or token) is never remembered, even
 *   when the person asks: `DO_NOT_SAVE`.
 * - Financial, health, biometric, identity and other people's private details
 *   are sensitive: `ASK_USER`, always, and kept sealed if the person agrees.
 * - A duplicate, or something short or unimportant that nobody asked to
 *   remember, is not saved.
 * - Something the proposer is unsure of is asked about.
 * - Everything else the person asked to remember is saved.
 *
 * Detection is deliberately cautious (it would rather ask than store) and
 * covers English and Thai.
 */

export interface PolicyInput {
  readonly content: string
  readonly explicit: boolean
  readonly confidence: number
  readonly importance: number
  readonly duplicateOf: string | null
}

export interface PolicyOutcome {
  readonly decision: MemoryDecision
  readonly reasons: PolicyReason[]
  readonly sensitiveKinds: SensitiveKind[]
}

const CREDENTIAL_WORDS = [
  /\b(?:password|passcode|passphrase|pass\s*word|pin(?:\s*code)?|otp|one[- ]time\s+(?:code|password)|verification\s+code|2fa\s+code|recovery\s+(?:code|phrase|key)|seed\s+phrase|mnemonic|private\s+key|secret\s+key|api\s*key|access\s+token|security\s+(?:answer|question))\b/i,
  /(?:รหัสผ่าน|พาสเวิร์ด|รหัส\s*pin|รหัสพิน|รหัส\s*otp|รหัสยืนยัน|รหัสลับ|คีย์ลับ|รหัสกู้คืน)/i
]

const FINANCIAL_WORDS = [
  /\b(?:bank\s+account|account\s+number|routing\s+number|sort\s+code|iban|swift|credit\s+card|debit\s+card|card\s+number|cvv|cvc|salary|income|net\s+worth|debt|loan|mortgage|credit\s+score|tax\s+(?:id|number|return)|bank\s+balance)\b/i,
  /(?:เลขบัญชี|บัญชีธนาคาร|บัตรเครดิต|บัตรเดบิต|เงินเดือน|รายได้|หนี้|เงินกู้|ผ่อนบ้าน|เครดิตบูโร|ภาษีเงินได้|ยอดเงินในบัญชี)/
]

const HEALTH_WORDS = [
  /\b(?:diagnos(?:is|ed)|medication|medicine|prescription|prescribed|disease|illness|disorder|symptom|therapy|therapist|psychiatr\w*|mental\s+health|depress\w*|anxiety|pregnan\w*|hiv|cancer|diabetes|blood\s+(?:type|pressure)|surgery|allerg(?:y|ic)\s+to|chronic|disabilit\w*)\b/i,
  /(?:วินิจฉัย|ป่วยเป็น|เป็นโรค|กินยา|แพ้ยา|ยารักษา|ซึมเศร้า|วิตกกังวล|ตั้งครรภ์|เบาหวาน|มะเร็ง|ความดันโลหิต|ผ่าตัด|จิตแพทย์|หมอบอกว่า|กรุ๊ปเลือด)/
]

const BIOMETRIC_WORDS = [
  /\b(?:fingerprint|face\s*id|faceprint|facial\s+(?:scan|recognition)|iris|retina|voiceprint|dna|genetic|biometric)\b/i,
  /(?:ลายนิ้วมือ|สแกนใบหน้า|ม่านตา|ดีเอ็นเอ|พันธุกรรม|ข้อมูลชีวมิติ)/
]

const IDENTITY_WORDS = [
  /\b(?:passport(?:\s+(?:number|no\.?))?|national\s+id|id\s+card\s+number|social\s+security|ssn|driver'?s?\s+licen[cs]e(?:\s+number)?)\b/i,
  /(?:เลขบัตรประชาชน|เลขประจำตัวประชาชน|บัตรประชาชน|หนังสือเดินทาง|เลขพาสปอร์ต|ใบขับขี่)/
]

const THIRD_PERSON = [
  /\b(?:his|her|their|hers|theirs|he|she|they)\b|\b\w+'s\b/i,
  /(?:ของเขา|ของเธอ|ของพวกเขา|เขา|เธอ|คุณ\S+|น้อง\S+|พี่\S+|แม่|พ่อ|เพื่อน)/
]

const CONTACT_WORDS = [
  /\b(?:phone(?:\s+number)?|mobile|address|home\s+address|lives\s+at|email)\b/i,
  /(?:เบอร์โทร|เบอร์มือถือ|ที่อยู่|บ้านเลขที่|อีเมล)/
]

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /\+?\d[\d\s().-]{7,}\d/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/
const THAI_ID = /\b\d[- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d\b/
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/
const CARD = /\b(?:\d[ -]?){13,19}\b/g

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = digits.charCodeAt(index) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(CARD)) {
    const digits = match[0].replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true
  }
  return false
}

function hasPhoneNumber(text: string): boolean {
  for (const match of text.matchAll(PHONE)) {
    const value = match[0].trim()
    // A date or a time is not a phone number.
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(value)) continue
    if (value.replace(/\D/g, '').length >= 9) return true
  }
  return false
}

const any = (patterns: readonly RegExp[], text: string) =>
  patterns.some((pattern) => pattern.test(text))

/** What makes this content sensitive, most serious first. */
export function sensitiveKindsOf(content: string, type: MemoryType | null = null): SensitiveKind[] {
  const text = content.normalize('NFC')
  const kinds: SensitiveKind[] = []
  if (findSecrets(text).length > 0 || any(CREDENTIAL_WORDS, text)) kinds.push('credential')
  if (any(FINANCIAL_WORDS, text) || hasCardNumber(text) || IBAN.test(text)) kinds.push('financial')
  if (any(HEALTH_WORDS, text)) kinds.push('health')
  if (any(BIOMETRIC_WORDS, text)) kinds.push('biometric')
  if (any(IDENTITY_WORDS, text) || SSN.test(text) || THAI_ID.test(text)) kinds.push('identity')
  const contact = any(CONTACT_WORDS, text) || EMAIL.test(text) || hasPhoneNumber(text)
  if (contact && (any(THIRD_PERSON, text) || type === 'people' || type === 'relationships'))
    kinds.push('third-party')
  return kinds
}

const KIND_DETAIL: Readonly<Record<SensitiveKind, string>> = {
  credential: 'It looks like a password, key, code or token. Jupiter never remembers those.',
  financial: 'It looks like financial information.',
  health: 'It looks like health information.',
  biometric: 'It looks like biometric information.',
  identity: 'It looks like an identity number or document.',
  'third-party': "It looks like another person's private contact details."
}

function words(text: string): number {
  // Thai has no spaces between words: count Thai characters as a rough word measure too.
  const latin = text.split(/\s+/).filter(Boolean).length
  const thai = (text.match(/[฀-๿]/g) ?? []).length
  return Math.max(latin, Math.floor(thai / 4))
}

export function decide(input: PolicyInput, type: MemoryType | null = null): PolicyOutcome {
  const kinds = sensitiveKindsOf(input.content, type)
  if (kinds.includes('credential'))
    return {
      decision: 'DO_NOT_SAVE',
      reasons: [{ code: 'credential', detail: KIND_DETAIL.credential }],
      sensitiveKinds: kinds
    }
  if (kinds.length > 0)
    return {
      decision: 'ASK_USER',
      reasons: kinds.map((kind) => ({
        code: kind,
        detail: `${KIND_DETAIL[kind]} It is kept only if you say so, sealed with your system's secure storage.`
      })),
      sensitiveKinds: kinds
    }
  if (input.duplicateOf)
    return {
      decision: 'DO_NOT_SAVE',
      reasons: [{ code: 'duplicate', detail: 'Jupiter already remembers this.' }],
      sensitiveKinds: []
    }
  if (!input.explicit) {
    if (words(input.content) < 3)
      return {
        decision: 'DO_NOT_SAVE',
        reasons: [{ code: 'too-short', detail: 'Too short to be worth remembering.' }],
        sensitiveKinds: []
      }
    if (input.importance < 0.3)
      return {
        decision: 'DO_NOT_SAVE',
        reasons: [
          {
            code: 'low-importance',
            detail: 'Not important enough to remember without being asked.'
          }
        ],
        sensitiveKinds: []
      }
    if (input.confidence < 0.6)
      return {
        decision: 'ASK_USER',
        reasons: [
          { code: 'low-confidence', detail: 'Jupiter is not sure this is right, so it asks first.' }
        ],
        sensitiveKinds: []
      }
    return {
      decision: 'SAVE',
      reasons: [{ code: 'useful', detail: 'Useful, confident and not sensitive.' }],
      sensitiveKinds: []
    }
  }
  return {
    decision: 'SAVE',
    reasons: [{ code: 'explicit-request', detail: 'You asked Jupiter to remember this.' }],
    sensitiveKinds: []
  }
}

/** Normalised content, for finding duplicates: case, spacing and final punctuation do not matter. */
export function normalizeContent(content: string): string {
  return content
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。]+$/u, '')
    .trim()
}

/**
 * A message that asks Jupiter to remember something ("remember that …",
 * "จำไว้ว่า …"). Returns what to remember, or null: a chat turn that does not
 * ask is never a memory candidate.
 */
export function explicitRequest(message: string): { content: string; type: MemoryType } | null {
  const text = message.trim()
  const match =
    /^(?:please\s+|pls\s+)?(?:remember|don'?t\s+forget|note)[\s:：,]+(?:that\s+)?(?<rest>[\s\S]{3,})$/i.exec(
      text
    ) ?? /^(?:ช่วย)?(?:จำไว้|จดไว้|บันทึกไว้)(?:\s*ว่า)?\s*(?<rest>[\s\S]{3,})$/.exec(text)
  const rest = match?.groups?.rest?.trim().replace(/^[:：,，-]\s*/, '')
  if (!rest) return null
  return { content: rest.slice(0, 4_000), type: typeOf(rest) }
}

export function typeOf(content: string): MemoryType {
  if (
    /\b(?:i|we)\s+(?:like|love|prefer|hate|dislike|enjoy|don'?t\s+like)\b|(?:ชอบ|ไม่ชอบ|เกลียด|โปรด)/i.test(
      content
    )
  )
    return 'preferences'
  if (
    /\b(?:every\s+(?:day|morning|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each\s+(?:day|week)|usually|routine)\b|(?:ทุกวัน|ทุกเช้า|ทุกเย็น|ทุกสัปดาห์|เป็นประจำ)/i.test(
      content
    )
  )
    return 'routines'
  if (/\b(?:decided|we\s+chose|decision)\b|(?:ตัดสินใจ|ตกลงว่า)/i.test(content)) return 'decisions'
  if (
    /\b(?:todo|to-do|need\s+to|must|deadline|due\s+(?:on|by))\b|(?:ต้องทำ|ต้องส่ง|กำหนดส่ง|เดดไลน์)/i.test(
      content
    )
  )
    return 'tasks'
  if (/\b(?:project)\b|(?:โปรเจกต์|โครงการ)/i.test(content)) return 'projects'
  if (
    /\b(?:my\s+(?:friend|boss|mother|father|mom|dad|sister|brother|wife|husband|partner|teacher|colleague))\b|(?:เพื่อนของฉัน|แม่ของฉัน|พ่อของฉัน|หัวหน้า|ครูของฉัน)/i.test(
      content
    )
  )
    return 'people'
  if (/\b(?:idea)\b|(?:ไอเดีย|ความคิด)/i.test(content)) return 'ideas'
  return 'facts'
}
