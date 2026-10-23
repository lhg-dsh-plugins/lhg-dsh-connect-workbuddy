/**
 * Scrubbing CLI output before it can reach a conversation.
 *
 * WHY THIS IS NOT `redactUpstreamText`. That helper lives in `src/probe.ts` and
 * ends with `.slice(0, PROBE_MESSAGE_LIMIT)` — 300 characters, enough for a
 * probe failure body and far too little for a CodeBuddy reply. Reusing it here
 * would silently truncate every review to its first paragraph, so this module
 * carries its own implementation of the same two patterns plus the one thing
 * the probe route does not have: an explicit secret list.
 *
 * WHY THE SECRET LIST MATTERS MORE THAN THE PATTERNS. The bridge hands the CLI
 * its credential through `CODEBUDDY_AUTH_TOKEN`, which means the token is in
 * that child's environment and the child is capable of echoing it back (a stack
 * trace, a debug line, an error body). No regex knows what a WorkBuddy token
 * looks like from the outside; the only definition that cannot be wrong is
 * "replace the exact string I put in the environment". The patterns stay as a
 * second net for tokens this process never held (a nested service's token, an
 * `Authorization` header copied into an error).
 *
 * @module dsh-connect-workbuddy/cli-bridge/redact
 */

/** Longest a redacted block may stay before it is treated as one blob. */
const MAX_SECRET_LENGTH = 4096

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // JWT-shaped: three base64url segments. This is what a WorkBuddy access token
  // looks like, and also what the gateway's own bearer tokens look like.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu, '[redacted token]'],
  // `Bearer <anything long enough to be one>`.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [redacted]'],
  // Vendor-prefixed keys: sk-…, ak-…, pk-… .
  [/\b(?:sk|ak|pk)-[A-Za-z0-9_-]{12,}\b/gu, '[redacted key]'],
  // `token=…` / `access_token=…` / `"api_key":"…"` style assignments.
  [/(\b(?:access_token|refresh_token|api_key|apikey|auth_token|token|authorization)\b["']?\s*[=:]\s*["']?)[^"'\s,}&]{8,}/giu, '$1[redacted]'],
]

/**
 * Remove token-shaped content from CLI text.
 *
 * `secrets` are exact strings to scrub first (case-sensitive, literal): the
 * credential this turn handed the child. Empty strings are ignored because
 * `String.prototype.split('')` would explode the text into characters.
 *
 * Never throws, never shortens the text. Length is the caller's business — a
 * reply that is still too long is truncated by the caller with a marker, not
 * here where the reason would be lost.
 */
export function redactCliText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue
    if (secret.length < 8 || secret.length > MAX_SECRET_LENGTH) continue
    out = out.split(secret).join('[redacted credential]')
  }
  for (const [pattern, replacement] of PATTERNS) {
    // `lastIndex` is stateful on /g regexes; reset so a shared constant cannot
    // make results depend on how many times this function ran before.
    pattern.lastIndex = 0
    out = out.replace(pattern, replacement)
  }
  return out
}
