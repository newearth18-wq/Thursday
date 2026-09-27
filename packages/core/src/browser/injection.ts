import type { SuspiciousContent } from '@jupiter/contracts'
import { redactString } from '@jupiter/security'

/**
 * Finds text on a web page that tries to direct the agent (SET 9).
 *
 * Page content is data, never instructions: nothing found here changes what
 * the agent does — its actions come only from the approved task. This only
 * labels such text, so the person (and any model that later reads the page)
 * can see that the page tried, and what it tried. A page that says nothing
 * suspicious is not thereby trusted.
 */

interface Rule {
  readonly kind: SuspiciousContent['kind']
  readonly pattern: RegExp
}

const AI = String.raw`(?:AI|A\.I\.|assistant|agent|model|LLM|chat ?bot|Jupiter|bot)`

const RULES: readonly Rule[] = [
  {
    kind: 'override-instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|system)\b[^.\n]{0,30}\b(?:instructions?|rules|prompts?|directions|guidelines|polic(?:y|ies))\b/i
  },
  {
    kind: 'override-instructions',
    pattern: /\b(?:you are now|from now on,? you|new (?:system )?instructions?:)/i
  },
  {
    kind: 'override-instructions',
    pattern: new RegExp(String.raw`\b(?:attention|note to|dear|hey)\s+${AI}\b`, 'i')
  },
  {
    kind: 'reveal-secrets',
    pattern:
      /\b(?:reveal|show|print|output|send|share|tell|give|paste|leak)\b[^.\n]{0,40}\b(?:api[ _-]?keys?|passwords?|secrets?|tokens?|credentials?|private keys?|system prompt|environment variables)\b/i
  },
  {
    kind: 'exfiltrate-files',
    pattern:
      /\b(?:upload|send|attach|exfiltrate|read|copy|post)\b[^.\n]{0,50}(?:~\/|\.ssh\b|id_rsa|\.env\b|\/etc\/passwd|C:\\Users|private (?:files?|keys?|data|documents?)|local files?|files? (?:from|on) (?:your|the user'?s?|this) (?:computer|disk|desktop|machine))/i
  },
  {
    kind: 'grant-permissions',
    pattern:
      /\b(?:grant|give|allow|enable|approve)\b[^.\n]{0,40}\b(?:permissions?|always[ _-]?allow|admin(?:istrator)? (?:rights|access)|full (?:control|access))\b/i
  },
  { kind: 'grant-permissions', pattern: /\b(?:ALWAYS_ALLOW|ALLOW_SESSION|ALLOW_ONCE)\b/ },
  {
    kind: 'redirect-agent',
    pattern: new RegExp(
      String.raw`\b${AI}\b[^.\n]{0,60}\b(?:navigate|go to|visit|open|click|submit|download|upload|buy|purchase|transfer)\b`,
      'i'
    )
  },
  {
    kind: 'install-software',
    pattern:
      /\b(?:install|download and run|execute|run)\b[^.\n]{0,40}(?:\bsoftware\b|\bprogram\b|\bextension\b|\.exe\b|\.msi\b|\bpowershell\b|\bterminal command\b|\bshell command\b|\bcurl\b[^.\n]{0,20}\|\s*(?:ba)?sh)/i
  },
  {
    kind: 'impersonate-user',
    pattern:
      /\b(?:the user (?:has )?(?:said|wants|asked|approved|authori[sz]ed|allowed)|on behalf of the user|(?:as|i am) (?:the|your) (?:user|owner|administrator))\b/i
  }
]

/** Labels text that tries to direct the agent: at most one finding per kind, with a redacted excerpt. */
export function findSuspiciousInstructions(text: string): SuspiciousContent[] {
  const found = new Map<SuspiciousContent['kind'], SuspiciousContent>()
  for (const rule of RULES) {
    if (found.has(rule.kind)) continue
    const match = rule.pattern.exec(text)
    if (!match) continue
    const start = Math.max(0, match.index - 60)
    const end = Math.min(text.length, match.index + match[0].length + 60)
    const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim()
    found.set(rule.kind, {
      kind: rule.kind,
      excerpt: redactString(`${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`, 300)
    })
  }
  return [...found.values()]
}
