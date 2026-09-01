import type { RequestSpec } from "../types.ts";

/**
 * Headers whose value is a credential by construction. A literal value here
 * is never persisted; reference an environment variable with $NAME instead.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization"]);

/** Matches `$NAME` and `${NAME}` environment references in a value. */
const ENV_REF = /\$([A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/;

/** Global variant that finds every reference in a text. */
const ENV_REF_GLOBAL = /\$([A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g;

export function hasEnvRef(value: string): boolean {
  return ENV_REF.test(value);
}

/**
 * Every environment name referenced in a text, in first-occurrence order,
 * deduplicated. This is the single source of the `$NAME` reference syntax;
 * `postui send` uses it to know which names must resolve before a send.
 */
export function extractEnvRefs(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(ENV_REF_GLOBAL)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const name = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Replace every `$NAME` / `${NAME}` reference using resolve(name). A name
 * resolve cannot answer should stay untouched — callers that need all names
 * present must verify that first (send does, via fail-fast resolution).
 */
export function substituteEnvRefs(
  text: string,
  resolve: (name: string) => string | undefined,
): string {
  return text.replace(ENV_REF_GLOBAL, match => {
    const raw = match.slice(1);
    const name = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
    return resolve(name) ?? match;
  });
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
