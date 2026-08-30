import type { RequestSpec } from "../types.ts";

/**
 * Headers whose value is a credential by construction. A literal value here
 * is never persisted; reference an environment variable with $NAME instead.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization"]);

/** Matches `$NAME` and `${NAME}` environment references in a value. */
const ENV_REF = /\$([A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/;

export function hasEnvRef(value: string): boolean {
  return ENV_REF.test(value);
}

/**
 * Drop credential-like literal values from a parsed request: any value in an
 * authorization-style header without an $NAME reference, and URL userinfo
 * without an $NAME reference, are treated as secrets and removed. Header
 * names are kept with empty values; userinfo is stripped from a copy of the
 * URL. Returns a new spec plus labels for each removal, for the caller to
 * report as warnings. The input is untouched.
 */
export function redactCredentialLiterals(
  spec: RequestSpec,
): { spec: RequestSpec; redacted: string[] } {
  const redacted: string[] = [];
  const headers = spec.headers.map(([name, value]) => {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase()) && !hasEnvRef(value)) {
      redacted.push(`${name} header`);
      return [name, ""] as [string, string];
    }
    return [name, value] as [string, string];
  });
  return { spec: { ...spec, headers, url: redactUserinfo(spec.url, redacted) }, redacted };
}

/** Strip literal userinfo (user:password) from the URL when it holds no $NAME. */
function redactUserinfo(url: URL, redacted: string[]): URL {
  if (url.username === "" && url.password === "") return url;
  if (hasEnvRef(url.username) || hasEnvRef(url.password)) return url;
  const clean = new URL(url.href);
  clean.username = "";
  clean.password = "";
  redacted.push("URL userinfo");
  return clean;
}
