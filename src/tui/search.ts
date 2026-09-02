import type { LoadedRequest } from "../gen/load.ts";

/**
 * The `/` search: a pure, in-memory fuzzy matcher over the workspace's
 * already-loaded requests. No file reads, no store, no Effect — ranking is
 * a deterministic function of (query, requests) so the collections pane can
 * render the ranked list and the status bar can report a match count from
 * the same call.
 *
 * Matching is a case-insensitive in-order subsequence test over each
 * request's NAME, METHOD, and URL; a request matches when any field does.
 * Scores reward what a human means: matches at word boundaries and runs of
 * consecutive characters beat scattered ones, name matches beat method
 * matches beat URL matches, and between equals the shorter field wins.
 */

/** Points for every matched character (the base a bonus structure sits on). */
const SCORE_MATCH = 1;
/** Points for each matched character that continues the previous match. */
const SCORE_CONSECUTIVE = 4;
/** Points when a match lands at the start or right after a separator. */
const SCORE_BOUNDARY = 6;
/** Extra points when the match starts at index 0 — "users" beats "list-users". */
const SCORE_PREFIX = 4;
/** Field weights: names are what a user searches for first. */
const FIELD_BONUS: Record<SearchField, number> = { name: 8, method: 4, url: 2 };
/** Separators that start a new "word" for boundary bonuses (URL-friendly). */
const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", ":", "?", "&", "=", "~", "@", "#", " ", "+", ";"]);

type SearchField = "name" | "method" | "url";

/** Characters are code points, so astral-plane query text still lines up. */
function codePoints(text: string): string[] {
  return [...text.toLowerCase()];
}

function isBoundary(chars: string[], index: number): boolean {
  return index === 0 || BOUNDARY_CHARS.has(chars[index - 1] ?? "");
}

/**
 * Score `query` against `text`: null when the query's characters do not
 * appear in order, otherwise a positive score (an empty query matches
 * anything with score 0). Among the possible alignments the best-scoring
 * one wins — the matcher tries each occurrence of the query's first
 * character (bounded, URLs can be long) instead of gambling on greedy.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = codePoints(query);
  const t = codePoints(text);
  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  // Candidate alignments: every occurrence of the first query character,
  // capped so a pathological 10k-char URL cannot spin the matcher.
  const MAX_STARTS = 32;
  let best: number | null = null;
  let startsExplored = 0;
  for (let start = 0; start < t.length; start += 1) {
    if (t[start] !== q[0]) continue;
    if (startsExplored >= MAX_STARTS) break;
    startsExplored += 1;
    const score = scoreFrom(q, t, start);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/** Score the alignment of `q` over `t` that consumes `t[from]` as q[0]. */
function scoreFrom(q: string[], t: string[], from: number): number | null {
  let score =
    SCORE_MATCH + (isBoundary(t, from) ? SCORE_BOUNDARY : 0) + (from === 0 ? SCORE_PREFIX : 0);
  let previous = from;
  for (const ch of q.slice(1)) {
    const found = t.indexOf(ch, previous + 1);
    if (found === -1) return null;
    score += SCORE_MATCH;
    if (found === previous + 1) score += SCORE_CONSECUTIVE;
    if (isBoundary(t, found)) score += SCORE_BOUNDARY;
    previous = found;
  }
  // Between near-equal alignments the shorter (more specific) field wins.
  return score - Math.floor(t.length / 16);
}

/** The best score across a request's name, method, and URL; null = no match. */
function requestScore(query: string, request: LoadedRequest): number | null {
  const candidates: Array<[SearchField, string]> = [
    ["name", request.name],
    ["method", request.request.method],
    ["url", request.request.url],
  ];
  let best: number | null = null;
  for (const [field, text] of candidates) {
    const raw = fuzzyScore(query, text);
    if (raw === null) continue;
    const score = raw + FIELD_BONUS[field];
    if (best === null || score > best) best = score;
  }
  return best;
}

/**
 * Rank the requests for `query`: matching requests ordered best first,
 * non-matching dropped. Equal scores keep the workspace's own order (the
 * sort is stable), and an empty query passes the list through unfiltered —
 * the palette's "everything, in workspace order" starting view.
 */
export function rankRequests(query: string, requests: readonly LoadedRequest[]): LoadedRequest[] {
  if (query === "") return [...requests];
  return requests
    .map((request): [LoadedRequest, number] | null => {
      const score = requestScore(query, request);
      return score === null ? null : [request, score];
    })
    .filter((hit): hit is [LoadedRequest, number] => hit !== null)
    .toSorted((a, b) => b[1] - a[1])
    .map(([request]) => request);
}
