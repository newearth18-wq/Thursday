/**
 * Credential patterns shared by log redaction and the repository secret scan.
 *
 * This file must stay dependency-free (no imports): `scripts/check-secrets.mjs`
 * loads it directly with Node's type stripping, without a build step.
 *
 * Patterns target well-known credential formats rather than "anything random
 * looking", so the scan stays quiet on hashes and lockfile integrity strings
 * and loud on things that are actually credentials.
 */

export interface SecretPattern {
  readonly id: string
  readonly description: string
  /** Always global; callers use `matchAll`/`replace`, which never share lastIndex state. */
  readonly regex: RegExp
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private-key',
    description: 'PEM private key block',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?/g
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI-style secret key',
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}/g
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret or restricted key',
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g
  },
  {
    id: 'huggingface-token',
    description: 'Hugging Face token',
    regex: /\bhf_[A-Za-z0-9]{30,}/g
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
  },
  {
    id: 'bearer-token',
    description: 'HTTP bearer credential',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g
  },
  {
    id: 'url-credentials',
    description: 'Credentials embedded in a URL',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s:/@'"`]+@/gi
  }
]

/**
 * A literal assigned to a credential-named key, e.g. `apiKey: "abc123..."`.
 * Group `prefix` keeps the key so redaction can show which field was hidden.
 */
export const CREDENTIAL_ASSIGNMENT: SecretPattern = {
  id: 'credential-assignment',
  description: 'Literal value assigned to a credential-named field',
  regex:
    /(?<prefix>["']?[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(?<quote>["'`])(?<value>[^"'`\s]{8,})\k<quote>/gi
}

/** Values that are obviously not real credentials (documentation, fixtures, templates). */
const PLACEHOLDER_VALUE =
  /^(?:\$\{|<|\{\{|%)|not[-_]?a[-_]?real|example|placeholder|dummy|fake|redacted|changeme|your[-_]|x{4,}|\*{3,}|\.{3,}/i

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUE.test(value)
}

/** Field names whose values are always hidden in structured data, whatever they contain. */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'bearer'
] as const

export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[\s_.-]/g, '')
  if (normalised === 'token' || normalised.endsWith('token')) return true
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment))
}

export interface SecretFinding {
  readonly patternId: string
  readonly description: string
  /** 1-based line and column of the match start. */
  readonly line: number
  readonly column: number
  /** Never the secret itself: a short prefix plus the match length. */
  readonly preview: string
}

function maskedPreview(match: string): string {
  return `${match.slice(0, 4)}… (${String(match.length)} chars)`
}

function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: index - lineStart + 1 }
}

/** Find every credential-looking string in `text`. Placeholder assignments are ignored. */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      findings.push({
        patternId: pattern.id,
        description: pattern.description,
        ...positionOf(text, match.index),
        preview: maskedPreview(match[0])
      })
    }
  }
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT.regex)) {
    const value = match.groups?.value ?? ''
    if (isPlaceholderValue(value)) continue
    findings.push({
      patternId: CREDENTIAL_ASSIGNMENT.id,
      description: CREDENTIAL_ASSIGNMENT.description,
      ...positionOf(text, match.index),
      preview: maskedPreview(value)
    })
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column)
}
