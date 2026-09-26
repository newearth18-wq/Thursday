import { REDACTED, redactString } from '@jupiter/security'

/**
 * Make text that came from a provider safe to log, store or show.
 *
 * Providers sometimes echo the key they were given ("Incorrect API key
 * provided: sk-…"), sometimes a masked version of it. Three layers:
 *  1. the exact secrets are removed;
 *  2. any long token that shares 8 or more consecutive characters with a
 *     secret is removed (partially masked echoes);
 *  3. known credential formats are redacted (@jupiter/security).
 * The result is short, single-line text.
 */
export function sanitizeProviderText(
  text: string,
  secrets: readonly (string | null | undefined)[],
  maxLength = 300
): string {
  let result = text.slice(0, 4000)
  const known = secrets.filter((secret): secret is string => !!secret && secret.length >= 8)
  for (const secret of known) result = result.split(secret).join(REDACTED)
  if (known.length > 0) {
    result = result.replace(/[A-Za-z0-9_\-.*+/=]{8,}/g, (token) =>
      known.some((secret) => sharesRun(token, secret, 8)) ? REDACTED : token
    )
  }
  result = redactString(result, 4000).replace(/\s+/g, ' ').trim()
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result
}

/** True when `a` and `b` have a common substring of at least `run` characters. */
function sharesRun(a: string, b: string, run: number): boolean {
  if (a.length < run || b.length < run) return false
  for (let start = 0; start + run <= a.length; start++) {
    if (b.includes(a.slice(start, start + run))) return true
  }
  return false
}
