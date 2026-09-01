// @provenance rule: rule_redact_credential_headers
// @provenance rule: rule_redact_env_values
// @provenance rule: rule_redaction_no_off_switch
//
// Every agent output path (success and error, human and JSON) ends in
// scrubSecrets(), and every credential-bearing header value is replaced
// structurally before rendering. No postui option reaches this module with
// a way to skip either step — there is no off switch.
//
// Scope note: redaction covers credential-bearing HEADERS (structural) and
// every value resolved from the environment at send time (substring scrub),
// wherever the API echoes them. A secret minted server-side inside a
// response body was never known to postui and is out of scope.

/** The one fixed marker that replaces every redacted value. */
export const REDACTED = "[redacted]";

/** Header names that carry credentials by construction (lowercase). */
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api-token",
  "x-auth-token",
  "x-csrf-token",
  "x-session-token",
]);

/**
 * Substrings that make any other header name credential-bearing. The match
 * is deliberately over-broad: a false positive only over-redacts (safe), a
 * false negative leaks a secret.
 */
const CREDENTIAL_MARKERS = [
  "auth",
  "token",
  "secret",
  "password",
  "credential",
  "cookie",
  "session",
  "api-key",
  "apikey",
] as const;

/** True when a header's value must never be shown. */
export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_HEADER_NAMES.has(lower)) return true;
  return CREDENTIAL_MARKERS.some(marker => lower.includes(marker));
}

/**
 * Replace the value of each credential-bearing header with the fixed
 * marker. Applied to request and response headers on every output path.
 */
export function redactHeaders(headers: Array<[string, string]>): Array<[string, string]> {
  return headers.map(([name, value]) => [name, isCredentialHeader(name) ? REDACTED : value]);
}

/**
 * Replace every occurrence of every secret value with the fixed marker.
 * Secrets are matched longest-first so that one value being a prefix of
 * another cannot leave a tail behind; empty values are skipped (there is
 * nothing to find). Idempotent: the marker never contains a secret.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const sorted = [...new Set(secrets)]
    .filter(secret => secret.length > 0)
    .toSorted((a, b) => b.length - a.length);
  let out = text;
  for (const secret of sorted) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
