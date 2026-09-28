/**
 * The URL's query string as editable PARAMS rows, and back.
 *
 * The split is textual, never URLSearchParams: that API percent-encodes on
 * the way out, which would turn a `$TOKEN` reference into `%24TOKEN` and
 * break env resolution at send time. Rows hold the raw text between the
 * separators; only the characters that would re-split the query are escaped
 * when a row is written back.
 */

export type ParamRow = readonly [name: string, value: string];

interface QuerySplit {
  /** Everything before `?` (scheme, host, path). */
  readonly base: string;
  readonly rows: ParamRow[];
  /** The `#fragment`, including the `#`, or "". */
  readonly hash: string;
}

export function splitQuery(url: string): QuerySplit {
  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return { base: beforeHash, rows: [], hash };
  const query = beforeHash.slice(queryAt + 1);
  const rows = query === "" ? [] : query.split("&").map(parseParam);
  return { base: beforeHash.slice(0, queryAt), rows, hash };
}

function parseParam(part: string): ParamRow {
  const eq = part.indexOf("=");
  return eq === -1 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
}

/** The URL with its query replaced by `rows` (no `?` when there are none). */
export function withQuery(url: string, rows: readonly ParamRow[]): string {
  const { base, hash } = splitQuery(url);
  if (rows.length === 0) return `${base}${hash}`;
  const query = rows.map(([name, value]) => `${escapePart(name, true)}=${escapePart(value, false)}`);
  return `${base}?${query.join("&")}${hash}`;
}

/**
 * Escape what would re-split the query: `&`, `#`, spaces, and `=` in names.
 * `%` stays as typed so existing escapes survive a rewrite unchanged.
 */
function escapePart(text: string, isName: boolean): string {
  let out = text.replaceAll("&", "%26").replaceAll("#", "%23").replaceAll(" ", "%20");
  if (isName) out = out.replaceAll("=", "%3D");
  return out;
}
