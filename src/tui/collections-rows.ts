import type { LoadedRequest } from "../gen/load.ts";
import type { CollectionGroup } from "./collection-groups.ts";

/** One flattened, renderable row of the collections pane: a group header or a request. */
export type FlatRow =
  | { readonly kind: "header"; readonly title: string }
  | { readonly kind: "request"; readonly request: LoadedRequest; readonly index: number };

/** A flattened row that is a request. */
export type RequestRow = Extract<FlatRow, { kind: "request" }>;

/**
 * The pane's flattened row layout: `matches` null renders the grouped tree
 * (browse mode); otherwise the ranked match list renders flat, because
 * group headers would scramble the ranking. Request rows carry their index
 * into `items` — the one index space the cursor reasons in — not their
 * display position, which the group sort reorders.
 */
export function flattenRows(
  items: readonly LoadedRequest[],
  groups: readonly CollectionGroup[],
  matches: readonly LoadedRequest[] | null,
): FlatRow[] {
  const rows: FlatRow[] = [];
  if (matches !== null) {
    matches.forEach((request, index) => rows.push({ kind: "request", request, index }));
    return rows;
  }
  const itemsIndex = new Map(items.map((request, index) => [request, index]));
  for (const group of groups) {
    rows.push({ kind: "header", title: group.title });
    for (const request of group.requests) {
      rows.push({ kind: "request", request, index: itemsIndex.get(request) ?? 0 });
    }
  }
  return rows;
}

/**
 * The displayed request row the cursor lands on when moving `delta` rows
 * through the pane's DISPLAYED order (j/k walk what is on screen, never
 * jumping visually across groups). From no highlight (or a cursor its rows
 * no longer carry) j picks the first displayed request and k the last;
 * otherwise it steps with wrap-around at both ends. Returns the row, or
 * null for an empty list.
 */
export function steppedRequestRow(
  rows: readonly FlatRow[],
  currentItemIndex: number | null,
  delta: 1 | -1,
): RequestRow | null {
  const requests = rows.filter((row): row is RequestRow => row.kind === "request");
  if (requests.length === 0) return null;
  const at =
    currentItemIndex === null
      ? -1
      : requests.findIndex(row => row.index === currentItemIndex);
  let next: number;
  if (at === -1) next = delta === 1 ? 0 : requests.length - 1;
  else next = (at + delta + requests.length) % requests.length;
  return requests[next] ?? null;
}
