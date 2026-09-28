import type { ParsedKeyLike } from "./keymap.ts";

/**
 * Text-field editing for the composer: the key → edit-action mapping and the
 * pure cursor operations the URL field, body editor and table cells share.
 * Offsets are UTF-16 indices kept on code point boundaries, so an astral
 * character is never split by a cursor move or a delete.
 */

/**
 * A parsed keypress as the composer reads it. The runtime object is
 * OpenTUI's KeyEvent; `sequence` carries the typed text (the case and
 * punctuation `name` loses) and is optional so synthetic events still work.
 */
export interface ComposerKey extends ParsedKeyLike {
  readonly sequence?: string;
  readonly meta?: boolean;
}

/** One edit a key asks a text field for. */
export type EditAction =
  | { readonly kind: "insert"; readonly text: string }
  | {
      readonly kind:
        | "backspace"
        | "delete"
        | "left"
        | "right"
        | "home"
        | "end"
        | "up"
        | "down";
    };

const NAMED_ACTIONS: Record<string, EditAction> = {
  backspace: { kind: "backspace" },
  delete: { kind: "delete" },
  left: { kind: "left" },
  right: { kind: "right" },
  home: { kind: "home" },
  end: { kind: "end" },
  up: { kind: "up" },
  down: { kind: "down" },
};

/** The printable text a key types, or null for control and named keys. */
function printableOf(key: ComposerKey): string | null {
  if (key.ctrl || key.meta === true) return null;
  if (key.name === "space") return " ";
  const seq = key.sequence;
  if (seq !== undefined) {
    return [...seq].length === 1 && seq >= " " && seq !== "\x7f" ? seq : null;
  }
  // Synthetic events carry no sequence: fall back to the key name.
  if ([...key.name].length !== 1) return null;
  return key.shift === true ? key.name.toUpperCase() : key.name;
}

/** The edit a key asks for, or null when the key is not an edit. */
export function editActionOf(key: ComposerKey): EditAction | null {
  const text = printableOf(key);
  if (text !== null) return { kind: "insert", text };
  if (key.ctrl || key.meta === true) return null;
  return NAMED_ACTIONS[key.name] ?? null;
}

/** A text value plus its cursor offset. */
export interface TextState {
  readonly text: string;
  readonly cursor: number;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** The code point boundary before `at`. */
export function previousBoundary(text: string, at: number): number {
  if (at <= 0) return 0;
  return at >= 2 && isLowSurrogate(text.charCodeAt(at - 1)) ? at - 2 : at - 1;
}

/** The code point boundary after `at`. */
export function nextBoundary(text: string, at: number): number {
  if (at >= text.length) return text.length;
  return isHighSurrogate(text.charCodeAt(at)) && at + 1 < text.length ? at + 2 : at + 1;
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
}

/**
 * Apply a horizontal edit (insert, delete, cursor moves, home/end of the
 * current line). Vertical moves go through moveLine.
 */
export function applyEdit(state: TextState, action: EditAction): TextState {
  const { text, cursor } = state;
  switch (action.kind) {
    case "insert":
      return { text: text.slice(0, cursor) + action.text + text.slice(cursor), cursor: cursor + action.text.length };
    case "backspace": {
      const from = previousBoundary(text, cursor);
      return { text: text.slice(0, from) + text.slice(cursor), cursor: from };
    }
    case "delete":
      return { text: text.slice(0, cursor) + text.slice(nextBoundary(text, cursor)), cursor };
    case "left":
      return { text, cursor: previousBoundary(text, cursor) };
    case "right":
      return { text, cursor: nextBoundary(text, cursor) };
    case "home":
      return { text, cursor: lineStart(text, cursor) };
    case "end":
      return { text, cursor: lineEnd(text, cursor) };
    default:
      return state;
  }
}

/**
 * Move the cursor one line up or down, keeping its column where the target
 * line allows. Returns null at the first (up) or last (down) line: the
 * caller decides where focus goes next.
 */
export function moveLine(state: TextState, direction: "up" | "down"): TextState | null {
  const { text, cursor } = state;
  const start = lineStart(text, cursor);
  const column = cursor - start;
  if (direction === "up") {
    if (start === 0) return null;
    const previousStart = lineStart(text, start - 1);
    return { text, cursor: Math.min(previousStart + column, start - 1) };
  }
  const end = lineEnd(text, cursor);
  if (end === text.length) return null;
  const nextStart = end + 1;
  return { text, cursor: Math.min(nextStart + column, lineEnd(text, nextStart)) };
}

/** The zero-based line the cursor sits on. */
export function lineOf(text: string, cursor: number): number {
  let line = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < cursor; at = text.indexOf("\n", at + 1)) line += 1;
  return line;
}

/**
 * The visible slice of a one-line field `width` cells wide that keeps the
 * cursor in view (the tail of a long URL scrolls in as the cursor moves).
 */
export function windowAround(text: string, cursor: number, width: number): TextState {
  if (width <= 0 || text.length < width) return { text, cursor };
  const start = Math.max(0, Math.min(cursor - width + 1, text.length - width + 1));
  return { text: text.slice(start, start + width), cursor: cursor - start };
}
