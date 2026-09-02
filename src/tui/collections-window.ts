/**
 * The collections pane's scroll window, as pure arithmetic over the pane's
 * flattened row layout: which terminal row a cursor sits at, and the window
 * start that keeps a 3-row request box fully visible. No renderable touches
 * — everything here is trivially testable.
 */

import { REQUEST_ROW_HEIGHT } from "./collections-render.ts";
import type { FlatRow } from "./collections-rows.ts";

/** Terminal rows above and around the pane body: header (3) + status (3) + pane border (2). */
const CHROME_ROWS = 8;

/** How many flattened body rows fit under the chrome at this terminal height. */
export function visibleRowCount(terminalHeight: number): number {
  return Math.max(1, terminalHeight - CHROME_ROWS);
}

/** Total height of the flattened layout, in terminal rows. */
function totalRowsHeight(rows: readonly FlatRow[]): number {
  return rows.reduce((sum, row) => sum + (row.kind === "header" ? 1 : REQUEST_ROW_HEIGHT), 0);
}

/** The terminal row where the flattened row at `rowIndex` starts (-1 if absent). */
function rowOffset(rows: readonly FlatRow[], rowIndex: number): number {
  let top = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (index === rowIndex) return top;
    top += rows[index]?.kind === "header" ? 1 : REQUEST_ROW_HEIGHT;
  }
  return -1;
}

/**
 * The window start (first visible flattened row's terminal offset) that
 * keeps the row at `rowIndex` fully in view within `visible` rows, clamped
 * to the layout. Pure: returns the input when nothing needs to move.
 */
export function windowForCursor(
  rows: readonly FlatRow[],
  rowIndex: number,
  visible: number,
  current: number,
): number {
  const top = rowOffset(rows, rowIndex);
  if (top === -1) return current;
  let start = current;
  if (top < start) start = top;
  else if (top + REQUEST_ROW_HEIGHT > start + visible) {
    start = top + REQUEST_ROW_HEIGHT - visible;
  }
  return Math.max(0, Math.min(start, Math.max(0, totalRowsHeight(rows) - visible)));
}
