import { isCredentialHeader } from "../send/redact.ts";
import type { RequestDraft } from "./composer-send.ts";
import { splitQuery, withQuery } from "./composer-query.ts";
import { applyRowChange, clampCursor, tableStep } from "./composer-table.ts";
import type { Row, RowChange, TableAction, TableCursor } from "./composer-table.ts";
import { applyEdit, editActionOf, moveLine } from "./composer-text.ts";
import type { ComposerKey } from "./composer-text.ts";

/**
 * The composer's editing state and key handling, free of rendering.
 *
 * Focus inside the composer walks METHOD → URL → tab strip → tab content
 * with ↑/↓. The URL and the tab content are text fields: every printable
 * key types into them (a literal "q" or "/" never reaches the global map),
 * ←/→ move the cursor, and esc leaves to the tab strip. METHOD and the tab
 * strip are not text: ←/→ cycle the method or switch tabs there, and keys
 * the composer does not use fall through to the shell. Enter sends from
 * everywhere except the body, where it breaks the line (ctrl+enter sends
 * when the terminal reports it). h/j/k/l stay silent aliases on the two
 * non-text fields only.
 */

export type ComposerTab = "params" | "headers" | "body" | "auth";

export const COMPOSER_TABS: readonly ComposerTab[] = ["params", "headers", "body", "auth"];

export type ComposerField = "method" | "url" | "tabs" | "content";

/** The methods ←/→ cycle through on the METHOD field, in order. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Template for the add row: AUTH's add row starts as an Authorization header. */
const EMPTY_ROW: Row = ["", ""];
const AUTH_ROW: Row = ["Authorization", ""];

export interface EditorState {
  draft: RequestDraft | null;
  /** HEADERS as ordered rows (empty names allowed while typing); draft.headers derives from these. */
  headerRows: Row[];
  field: ComposerField;
  tab: ComposerTab;
  urlCursor: number;
  bodyCursor: number;
  table: TableCursor;
}

/** What the pane must do after a key the editor consumed ("none": just repaint). */
export type EditorEffect = "none" | "send" | "save" | "form-body";

export function newEditorState(): EditorState {
  return {
    draft: null,
    headerRows: [],
    field: "url",
    tab: "body", // the mockup opens on BODY
    urlCursor: 0,
    bodyCursor: 0,
    table: { row: 0, col: 0, pos: 0 },
  };
}

/**
 * Put a draft in the editor. `keepPosition` (a reload of the same request)
 * keeps the focused field and clamps the cursors; a different request
 * starts on the URL with the cursor at its end.
 */
export function loadDraft(state: EditorState, draft: RequestDraft, keepPosition: boolean): void {
  state.draft = draft;
  state.headerRows = Object.entries(draft.headers);
  if (!keepPosition) {
    state.field = "url";
    state.urlCursor = draft.url.length;
    state.bodyCursor = 0;
    state.table = { row: 0, col: 0, pos: 0 };
    return;
  }
  state.urlCursor = Math.min(state.urlCursor, draft.url.length);
  state.bodyCursor = Math.min(state.bodyCursor, typeof draft.body === "string" ? draft.body.length : 0);
  if (state.field === "content" && !canEnterContent(state)) state.field = "tabs";
}

/** True while a text field (URL, body, a table cell) has the keys. */
export function isEditingText(state: EditorState): boolean {
  return state.draft !== null && (state.field === "url" || state.field === "content");
}

/** Indices of the credential-bearing header rows (the AUTH view). */
function credentialIndices(rows: readonly Row[]): number[] {
  return rows.flatMap(([name], index) => (isCredentialHeader(name) ? [index] : []));
}

interface TableSource {
  readonly rows: Row[];
  readonly template: Row;
  apply(change: RowChange): void;
}

/** The rows the current tab edits, and where a change is written back. */
export function tableSource(state: EditorState): TableSource | null {
  const draft = state.draft;
  if (draft === null || state.tab === "body") return null;
  if (state.tab === "params") {
    const rows = splitQuery(draft.url).rows;
    return {
      rows,
      template: EMPTY_ROW,
      apply: (change) => {
        draft.url = withQuery(draft.url, applyRowChange(rows, change));
        state.urlCursor = Math.min(state.urlCursor, draft.url.length);
      },
    };
  }
  if (state.tab === "headers") {
    return {
      rows: state.headerRows,
      template: EMPTY_ROW,
      apply: (change) => setHeaderRows(state, applyRowChange(state.headerRows, change)),
    };
  }
  const indices = credentialIndices(state.headerRows);
  return {
    rows: indices.map(index => state.headerRows[index] ?? EMPTY_ROW),
    template: AUTH_ROW,
    apply: (change) => setHeaderRows(state, applyAuthChange(state.headerRows, indices, change)),
  };
}

/** Map an AUTH-view change (indices into the credential subset) onto every header row. */
function applyAuthChange(all: readonly Row[], indices: readonly number[], change: RowChange): Row[] {
  if (change.kind === "append") return [...all, change.value];
  const target = indices[change.row];
  return target === undefined ? [...all] : applyRowChange(all, { ...change, row: target });
}

function setHeaderRows(state: EditorState, rows: Row[]): void {
  state.headerRows = rows;
  if (state.draft !== null) {
    state.draft.headers = Object.fromEntries(rows.filter(([name]) => name !== ""));
  }
}

const isEnter = (key: ComposerKey): boolean => key.name === "return" || key.name === "enter";

/** A lone ESC byte parses unnamed; both forms are escape. */
const isEscape = (key: ComposerKey): boolean => key.name === "escape" || key.name === "";

/**
 * Handle one key. Returns the effect for the pane, or null when the key is
 * not the composer's (it then falls through to the shell's global map).
 */
export function editorKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  if (state.draft === null) return null;
  if (key.ctrl) return ctrlKey(state, key);
  if (key.name === "tab") return null; // pane focus is the shell's
  if (isEscape(key)) {
    if (!isEditingText(state)) return null;
    state.field = "tabs";
    return "none";
  }
  if (state.field === "method") return methodKey(state, key);
  if (state.field === "url") return urlKey(state, key);
  if (state.field === "tabs") return tabsKey(state, key);
  return state.tab === "body" ? bodyKey(state, key) : tableKey(state, key);
}

/** Ctrl chords: ^s save, ^enter send, ^d drop a row. Anything else (^c) is the shell's. */
function ctrlKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  if (key.name === "s") return "save";
  if (isEnter(key)) return "send";
  if (key.name === "d" && state.field === "content" && state.tab !== "body") {
    stepTable(state, { kind: "remove-row" });
    return "none";
  }
  return null;
}

function methodKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  const name = key.name;
  if (name === "left" || name === "h") cycleMethod(state, -1);
  else if (name === "right" || name === "l" || name === "space") cycleMethod(state, 1);
  else if (name === "down" || name === "j") state.field = "url";
  else if (isEnter(key) || name === "linefeed") return "send";
  else if (name !== "up" && name !== "k") return null;
  return "none";
}

function cycleMethod(state: EditorState, delta: 1 | -1): void {
  const draft = state.draft as RequestDraft;
  const index = METHODS.indexOf(draft.method.toUpperCase() as (typeof METHODS)[number]);
  // A custom method (not in the list) steps onto the list's first or last entry.
  let from = index;
  if (index === -1) from = delta === 1 ? -1 : 0;
  draft.method = METHODS[(from + delta + METHODS.length) % METHODS.length] ?? "GET";
}

function urlKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  if (isEnter(key) || key.name === "linefeed") return "send";
  const action = editActionOf(key);
  if (action === null) return null;
  const draft = state.draft as RequestDraft;
  if (action.kind === "up") state.field = "method";
  else if (action.kind === "down") state.field = "tabs";
  else {
    const next = applyEdit({ text: draft.url, cursor: state.urlCursor }, action);
    draft.url = next.text;
    state.urlCursor = next.cursor;
  }
  return "none";
}

function tabsKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  const name = key.name;
  if (name === "left" || name === "h") stepTab(state, -1);
  else if (name === "right" || name === "l") stepTab(state, 1);
  else if (name === "up" || name === "k") state.field = "url";
  else if (name === "down" || name === "j") return enterContent(state);
  else if (isEnter(key) || name === "linefeed") return "send";
  else return null;
  return "none";
}

function stepTab(state: EditorState, delta: 1 | -1): void {
  const index = COMPOSER_TABS.indexOf(state.tab);
  state.tab = COMPOSER_TABS[(index + delta + COMPOSER_TABS.length) % COMPOSER_TABS.length] ?? "body";
}

/** Form bodies are display-only: the saved module is their editor. */
function canEnterContent(state: EditorState): boolean {
  return !(state.tab === "body" && Array.isArray(state.draft?.body));
}

function enterContent(state: EditorState): EditorEffect {
  if (!canEnterContent(state)) return "form-body";
  state.field = "content";
  const source = tableSource(state);
  if (source !== null) state.table = settleCursor(state, source.rows, state.table, source.template);
  return "none";
}

/** Clamp a table cursor; on AUTH's add row the cursor sits in the value. */
function settleCursor(state: EditorState, rows: readonly Row[], cursor: TableCursor, template: Row): TableCursor {
  const clamped = clampCursor(rows, cursor, template);
  if (state.tab !== "auth" || clamped.row < rows.length) return clamped;
  return { ...clamped, col: 1, pos: Math.min(clamped.pos, template[1].length) };
}

function bodyKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  if (key.name === "linefeed") return "send"; // ctrl+enter on terminals that send LF
  const action = isEnter(key) ? { kind: "insert" as const, text: "\n" } : editActionOf(key);
  if (action === null) return null;
  const draft = state.draft as RequestDraft;
  const current = { text: typeof draft.body === "string" ? draft.body : "", cursor: state.bodyCursor };
  if (action.kind === "up" || action.kind === "down") {
    const moved = moveLine(current, action.kind);
    if (moved !== null) state.bodyCursor = moved.cursor;
    else if (action.kind === "up") state.field = "tabs";
    return "none";
  }
  const next = applyEdit(current, action);
  // An emptied body is no body: the module saves `body: null`, not "".
  draft.body = next.text === "" ? null : next.text;
  state.bodyCursor = next.cursor;
  return "none";
}

function tableKey(state: EditorState, key: ComposerKey): EditorEffect | null {
  if (isEnter(key) || key.name === "linefeed") return "send";
  const action = editActionOf(key);
  if (action === null) return null;
  stepTable(state, action);
  return "none";
}

function stepTable(state: EditorState, action: TableAction): void {
  const source = tableSource(state);
  if (source === null) return;
  const cursor = settleCursor(state, source.rows, state.table, source.template);
  const step = tableStep(source.rows, cursor, action, source.template);
  if (step.exitUp) {
    state.field = "tabs";
    return;
  }
  if (step.change !== null) source.apply(step.change);
  const after = tableSource(state) ?? source;
  state.table = settleCursor(state, after.rows, step.cursor, after.template);
}
