import { applyEdit, nextBoundary, previousBoundary } from "./composer-text.ts";
import type { EditAction } from "./composer-text.ts";

/**
 * The name/value row editor behind PARAMS, HEADERS and AUTH.
 *
 * Rows are shown with one extra trailing "add" row. Typing into the add row
 * creates a real row; no bare letter key is ever a command. A row goes away
 * with ctrl+d, or with backspace/delete on a row that is already empty.
 * The editor never owns the rows: each key yields a RowChange that the
 * caller applies to its own source (the URL query, the header list).
 */

export type Row = readonly [name: string, value: string];

export interface TableCursor {
  readonly row: number;
  /** 0 = name, 1 = value. */
  readonly col: 0 | 1;
  /** Offset within the cell's text. */
  readonly pos: number;
}

export type RowChange =
  | { readonly kind: "set"; readonly row: number; readonly value: Row }
  | { readonly kind: "append"; readonly value: Row }
  | { readonly kind: "remove"; readonly row: number };

export type TableAction = EditAction | { readonly kind: "remove-row" };

export interface TableStep {
  readonly change: RowChange | null;
  readonly cursor: TableCursor;
  /** The cursor tried to leave above the first row. */
  readonly exitUp: boolean;
}

/** Apply a change to a plain row list. */
export function applyRowChange(rows: readonly Row[], change: RowChange): Row[] {
  if (change.kind === "append") return [...rows, change.value];
  if (change.kind === "remove") return rows.filter((_, index) => index !== change.row);
  return rows.map((row, index) => (index === change.row ? change.value : row));
}

/** The text of the cell under the cursor (`template` stands in for the add row). */
function cellText(rows: readonly Row[], cursor: TableCursor, template: Row): string {
  const row = rows[cursor.row] ?? template;
  return row[cursor.col];
}

/** Keep a cursor inside the table after the rows changed under it. */
export function clampCursor(rows: readonly Row[], cursor: TableCursor, template: Row): TableCursor {
  const row = Math.max(0, Math.min(cursor.row, rows.length));
  const clamped = { ...cursor, row };
  return { ...clamped, pos: Math.min(cursor.pos, cellText(rows, clamped, template).length) };
}

const stay = (cursor: TableCursor): TableStep => ({ change: null, cursor, exitUp: false });

function withCell(row: Row, col: 0 | 1, text: string): Row {
  return col === 0 ? [text, row[1]] : [row[0], text];
}

/** One key's worth of table editing. */
export function tableStep(
  rows: readonly Row[],
  cursor: TableCursor,
  action: TableAction,
  template: Row,
): TableStep {
  if (action.kind === "up" || action.kind === "down") return verticalStep(rows, cursor, action.kind, template);
  if (action.kind === "remove-row") return removeRow(rows, cursor, template);
  const onAddRow = cursor.row >= rows.length;
  const text = cellText(rows, cursor, template);
  if (action.kind === "insert") {
    const edited = applyEdit({ text, cursor: cursor.pos }, action);
    const value = withCell(rows[cursor.row] ?? template, cursor.col, edited.text);
    const change: RowChange = onAddRow ? { kind: "append", value } : { kind: "set", row: cursor.row, value };
    return { change, cursor: { ...cursor, pos: edited.cursor }, exitUp: false };
  }
  if (action.kind === "backspace" || action.kind === "delete") {
    return onAddRow ? stay(cursor) : deleteStep(rows, cursor, action.kind, template);
  }
  return moveStep(text, cursor, action.kind, rows, template);
}

function verticalStep(
  rows: readonly Row[],
  cursor: TableCursor,
  direction: "up" | "down",
  template: Row,
): TableStep {
  if (direction === "up" && cursor.row === 0) return { change: null, cursor, exitUp: true };
  const row = direction === "up" ? cursor.row - 1 : Math.min(cursor.row + 1, rows.length);
  return stay(clampCursor(rows, { ...cursor, row }, template));
}

function removeRow(rows: readonly Row[], cursor: TableCursor, template: Row): TableStep {
  if (cursor.row >= rows.length) return stay(cursor);
  const after = applyRowChange(rows, { kind: "remove", row: cursor.row });
  return {
    change: { kind: "remove", row: cursor.row },
    cursor: clampCursor(after, { row: cursor.row, col: 0, pos: 0 }, template),
    exitUp: false,
  };
}

/** Backspace/delete inside a cell; on an empty row they remove it. */
function deleteStep(
  rows: readonly Row[],
  cursor: TableCursor,
  kind: "backspace" | "delete",
  template: Row,
): TableStep {
  const row = rows[cursor.row] ?? template;
  if (row[0] === "" && row[1] === "") {
    const step = removeRow(rows, cursor, template);
    if (kind === "delete" || cursor.row === 0) return step;
    // backspace on an empty row lands at the end of the row above
    const above = rows[cursor.row - 1] ?? template;
    return { ...step, cursor: { row: cursor.row - 1, col: 1, pos: above[1].length } };
  }
  const text = row[cursor.col];
  const atEdge = kind === "backspace" ? cursor.pos === 0 : cursor.pos >= text.length;
  if (atEdge) {
    // backspace at the start of a value steps back into the name
    return kind === "backspace" && cursor.col === 1 ? stay({ ...cursor, col: 0, pos: row[0].length }) : stay(cursor);
  }
  const edited = applyEdit({ text, cursor: cursor.pos }, { kind });
  return {
    change: { kind: "set", row: cursor.row, value: withCell(row, cursor.col, edited.text) },
    cursor: { ...cursor, pos: edited.cursor },
    exitUp: false,
  };
}

/** Left/right/home/end: move within a cell, crossing name ↔ value at its edges. */
function moveStep(
  text: string,
  cursor: TableCursor,
  kind: EditAction["kind"],
  rows: readonly Row[],
  template: Row,
): TableStep {
  const row = rows[cursor.row] ?? template;
  if (kind === "home") return stay({ ...cursor, pos: 0 });
  if (kind === "end") return stay({ ...cursor, pos: text.length });
  if (kind === "left") {
    if (cursor.pos > 0) return stay({ ...cursor, pos: previousBoundary(text, cursor.pos) });
    return cursor.col === 1 ? stay({ ...cursor, col: 0, pos: row[0].length }) : stay(cursor);
  }
  if (kind === "right") {
    if (cursor.pos < text.length) return stay({ ...cursor, pos: nextBoundary(text, cursor.pos) });
    return cursor.col === 0 ? stay({ ...cursor, col: 1, pos: 0 }) : stay(cursor);
  }
  return stay(cursor);
}
