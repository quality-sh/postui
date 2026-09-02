import type { LoadedRequest } from "../gen/load.ts";

/**
 * Grouping decision (per the mockup, design/postui-opentui-concept.png,
 * which shows https://api.dev/users under a "Users" header): the collection
 * a request sits under is its URL's FIRST PATH SEGMENT with the first
 * letter uppercased — "users" -> "Users". Hostname without TLD would give
 * "api" here, which matches nothing a user typed; when the path has no
 * segments at all ("https://api.dev") the hostname is the only honest
 * title, used verbatim. A URL that does not parse (hand-edited modules may
 * hold anything) groups under "(invalid url)" instead of crashing.
 */
export function collectionTitle(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(invalid url)";
  }
  const segment = parsed.pathname.split("/").find(part => part.length > 0);
  if (segment === undefined) return parsed.hostname;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * Method coloring per the mockup: POST is painted in the accent red/pink,
 * GET muted. Every mutating method gets the accent treatment; safe methods
 * stay muted. Comparison is case-insensitive because hand-edited modules
 * may hold lowercase methods.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** Requests grouped under their collection title, groups sorted by title. */
export interface CollectionGroup {
  readonly title: string;
  readonly requests: readonly LoadedRequest[];
}

/** Group saved requests by collection; within a group the loader's order (filename order) stands. */
export function groupByCollection(requests: readonly LoadedRequest[]): CollectionGroup[] {
  const groups = new Map<string, LoadedRequest[]>();
  for (const request of requests) {
    const title = collectionTitle(request.request.url);
    const bucket = groups.get(title);
    if (bucket === undefined) groups.set(title, [request]);
    else bucket.push(request);
  }
  return [...groups.entries()]
    .map(([title, groupRequests]) => ({ title, requests: groupRequests }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
}
