/**
 * The collections pane's scroll window, as pure arithmetic over the pane's
 * flattened row layout: the window start that keeps a request row in view,
 * and which row each of the pane's row slots shows. No renderable touches —
 * everything here is trivially testable.
 *
 * Every row (header or request) is one terminal row (REQUEST_ROW_HEIGHT),
 * so a window start is a row index. Group headers never scroll away from
 * their rows: a window that starts inside a group PINS that group's header
 * in the first slot (the rows under it shift down one), and a window that
 * would start on a group's first request starts on its header instead —
 * both show the same thing, a header over its own rows.
 */

import type { FlatRow } from "./collections-rows.ts";
import { HEADER_ROWS } from "./header.ts";
import { STATUS_BAR_ROWS } from "./status-bar.ts";

/** Terminal rows above and around the pane body: header + status bar + the pane's own frame (2). */
const CHROME_ROWS = HEADER_ROWS + STATUS_BAR_ROWS + 2;

/** How many flattened body rows fit under the chrome at this terminal height. */
export function visibleRowCount(terminalHeight: number): number {
  return Math.max(1, terminalHeight - CHROME_ROWS);
}

/** One slot of the window: the row it shows, and whether it is a pinned header. */
export interface WindowSlot {
  readonly row: FlatRow;
  /** The row's index in the flattened layout. */
  readonly rowIndex: number;
  /** A group header held at the top while its rows scroll under it. */
  readonly pinned: boolean;
}

/** Headers pin only in the grouped tree, and only when a row fits under the pin. */
function pinsHeaders(rows: readonly FlatRow[], visible: number): boolean {
  return visible > 1 && rows.some(row => row.kind === "header");
}

/** The index of the header above `rowIndex` (the group it belongs to), or -1. */
function headerAbove(rows: readonly FlatRow[], rowIndex: number): number {
  for (let index = rowIndex; index >= 0; index -= 1) {
    if (rows[index]?.kind === "header") return index;
  }
  return -1;
}

/** How many layout rows a window starting at `start` shows (a pinned header takes one slot). */
function capacity(rows: readonly FlatRow[], start: number, visible: number): number {
  return pinsHeaders(rows, visible) && rows[start]?.kind === "request" ? visible - 1 : visible;
}

/**
 * The smallest start that still reaches `rowIndex` at the window's bottom.
 * With pinning, a start inside a group loses a slot to the pin, so it moves
 * one row further down.
 */
function startEndingAt(rows: readonly FlatRow[], rowIndex: number, visible: number): number {
  const start = rowIndex - visible + 1;
  if (start <= 0) return 0;
  return capacity(rows, start, visible) === visible ? start : start + 1;
}

/** A group's first request starts the window on its header instead (same view, honest start). */
function normalized(rows: readonly FlatRow[], start: number): number {
  return rows[start]?.kind === "request" && rows[start - 1]?.kind === "header" ? start - 1 : start;
}

/** Clamp a window start to the layout: never past the start that shows the last row. */
export function clampWindow(rows: readonly FlatRow[], start: number, visible: number): number {
  if (rows.length <= visible) return 0;
  const last = startEndingAt(rows, rows.length - 1, visible);
  return normalized(rows, Math.max(0, Math.min(start, last)));
}

/**
 * The window start that keeps the row at `rowIndex` in view within
 * `visible` rows, clamped to the layout. Pure: returns the (clamped) input
 * when nothing needs to move; an unknown row leaves the window unchanged.
 */
export function windowForCursor(
  rows: readonly FlatRow[],
  rowIndex: number,
  visible: number,
  current: number,
): number {
  if (rowIndex < 0 || rowIndex >= rows.length) return current;
  let start = clampWindow(rows, current, visible);
  if (rowIndex < start) start = rowIndex;
  else if (rowIndex >= start + capacity(rows, start, visible)) start = startEndingAt(rows, rowIndex, visible);
  return clampWindow(rows, start, visible);
}

/** What each slot shows for a window starting at `start`: a pinned header first when the window starts mid-group. */
export function windowSlots(rows: readonly FlatRow[], start: number, visible: number): WindowSlot[] {
  const slots: WindowSlot[] = [];
  if (pinsHeaders(rows, visible) && rows[start]?.kind === "request") {
    const header = headerAbove(rows, start);
    const row = rows[header];
    if (row !== undefined) slots.push({ row, rowIndex: header, pinned: true });
  }
  for (let index = start; index < rows.length && slots.length < visible; index += 1) {
    const row = rows[index];
    if (row !== undefined) slots.push({ row, rowIndex: index, pinned: false });
  }
  return slots;
}
