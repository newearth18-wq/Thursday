import { describe, expect, it } from 'vitest'
import { decide, explicitRequest, normalizeContent, sensitiveKindsOf, typeOf } from './policy'

const base = { explicit: true, confidence: 0.9, importance: 0.5, duplicateOf: null }

describe('the Memory Policy', () => {
  it('never saves a credential, even when asked', () => {
    for (const content of [
      'My password is correct-horse-battery',
      'the wifi pass word: saturn-rings',
      'PIN code 4821 for the bank card',
      'รหัสผ่านอีเมลคือ jupiter99',
      'Recovery phrase: apple banana cherry'
    ])
      expect(decide({ ...base, content }).decision, content).toBe('DO_NOT_SAVE')
  })

  it('asks before saving sensitive information, in English and Thai', () => {
    const cases: [string, string][] = [
      ['My salary is 50,000 baht a month.', 'financial'],
      ['Card 4111 1111 1111 1111 expires next year.', 'financial'],
      ['I was diagnosed with asthma.', 'health'],
      ['ฉันแพ้ยาเพนิซิลลิน', 'health'],
      ['My fingerprint unlocks the laptop.', 'biometric'],
      ['My passport number is AB1234567.', 'identity'],
      ['เลขบัตรประชาชนของฉันคือ 1-2345-67890-12-3', 'identity'],
      ["Tom's phone number is 081 234 5678.", 'third-party']
    ]
    for (const [content, kind] of cases) {
      const outcome = decide({ ...base, content })
      expect(outcome.decision, content).toBe('ASK_USER')
      expect(outcome.sensitiveKinds, content).toContain(kind)
    }
  })

  it('does not mistake dates or ordinary text for sensitive details', () => {
    for (const content of [
      'The launch is on 2026-10-15 at 09:30.',
      'He likes astronomy and chess.',
      'I prefer green tea in the morning.'
    ])
      expect(sensitiveKindsOf(content), content).toEqual([])
  })

  it('does not save duplicates, trivia or unimportant things nobody asked for, and asks when unsure', () => {
    expect(
      decide({ ...base, content: 'The telescope is in the garage.', duplicateOf: 'x' }).decision
    ).toBe('DO_NOT_SAVE')
    expect(decide({ ...base, explicit: false, content: 'ok' }).reasons[0]?.code).toBe('too-short')
    expect(
      decide({
        ...base,
        explicit: false,
        importance: 0.1,
        content: 'It was a bit cloudy today afternoon.'
      }).reasons[0]?.code
    ).toBe('low-importance')
    expect(
      decide({
        ...base,
        explicit: false,
        confidence: 0.3,
        content: 'Maybe the club moved to Thursday.'
      }).decision
    ).toBe('ASK_USER')
    expect(decide({ ...base, content: 'The club meets on Thursdays.' }).decision).toBe('SAVE')
  })

  it('treats only messages that ask to remember as candidates', () => {
    expect(explicitRequest('What is the largest planet?')).toBeNull()
    expect(explicitRequest('Remember that I like tea.')).toEqual({
      content: 'I like tea.',
      type: 'preferences'
    })
    expect(explicitRequest('please remember: the meeting is every Monday')?.type).toBe('routines')
    expect(explicitRequest('จำไว้ว่าฉันชอบกาแฟ')).toEqual({
      content: 'ฉันชอบกาแฟ',
      type: 'preferences'
    })
    expect(typeOf('We decided to use SQLite.')).toBe('decisions')
    expect(normalizeContent('  The Telescope  is here. ')).toBe('the telescope is here')
  })
})

describe('sha256Hex', () => {
  it('matches Node.js for empty, ASCII, Thai and multi-block input', async () => {
    const { createHash } = await import('node:crypto')
    const { sha256Hex } = await import('./digest')
    for (const text of ['', 'abc', 'ดาวพฤหัสบดี', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56)])
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
  })
})
