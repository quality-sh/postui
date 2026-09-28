/**
 * JSON pretty-printing as typed token spans, for any pane that shows a body
 * (the response BODY tab today; the composer's request body can reuse it).
 * Pure and renderer-free: spans carry a KIND, never a color — the render
 * layer maps kinds to theme tokens.
 *
 * The printer re-lays out the SOURCE TEXT's tokens instead of round-tripping
 * through JSON.parse/stringify, so every token renders exactly as the server
 * wrote it: big numbers keep their digits, `1.0` stays `1.0`, and escapes
 * stay escaped. That last point matters for redaction: callers scrub the raw
 * text first, and a decode step after the scrub could turn `abc` back
 * into a secret the scrub never saw.
 */

/** What a span of a pretty-printed line is; `plain` is indentation, spacing, and non-JSON text. */
export type JsonTokenKind = "punctuation" | "key" | "string" | "number" | "boolean" | "null" | "plain";

/** One run of text on a line, all of one kind. */
export interface JsonSpan {
  readonly kind: JsonTokenKind;
  readonly text: string;
}

/** One output line: its spans in order (empty for a blank line). */
export type JsonLine = readonly JsonSpan[];

/**
 * The layout result. `json`: a complete document, pretty-printed.
 * `partial`: a document cut off mid-way (only when the caller said the text
 * is a truncated prefix) — everything up to the cut, pretty-printed, the
 * last token possibly incomplete. `text`: not JSON; the input's own lines,
 * each one plain span.
 */
export interface HighlightedJson {
  readonly format: "json" | "partial" | "text";
  readonly lines: readonly JsonLine[];
}

export interface HighlightOptions {
  /**
   * The text is a prefix of a longer body (a bounded excerpt). A document
   * that runs out early is then laid out up to the cut instead of falling
   * back to plain lines. Without it, running out early means "not JSON".
   */
  readonly truncated?: boolean;
}

const INDENT = "  ";

/**
 * Nesting deeper than this is laid out as plain text: the printer recurses
 * per level, and a hostile `[[[[…` body must not overflow the stack.
 */
const MAX_DEPTH = 256;

/**
 * Pretty-print JSON text (2-space indent, one member or element per line,
 * `{}`/`[]` kept on one line) as typed spans. Text that is not JSON passes
 * through as plain lines.
 */
export function highlightJson(text: string, options: HighlightOptions = {}): HighlightedJson {
  const lexed = lex(text);
  if (lexed.end === "error") return plainText(text);
  const laidOut = layout(lexed.tokens);
  if (laidOut === null) return plainText(text);
  if (laidOut.complete && lexed.end === "clean") return { format: "json", lines: laidOut.lines };
  return options.truncated === true ? { format: "partial", lines: laidOut.lines } : plainText(text);
}

/**
 * Pretty-print an in-memory JSON value (a parsed request body, say). A
 * value JSON cannot represent (undefined, a function) renders as its
 * String() text, plain.
 */
export function highlightJsonValue(value: unknown): HighlightedJson {
  const text: unknown = JSON.stringify(value);
  return typeof text === "string" ? highlightJson(text) : plainText(String(value));
}

/** Non-JSON text: the input's own lines, each one plain span (blank lines stay blank). */
function plainText(text: string): HighlightedJson {
  return {
    format: "text",
    lines: text.split(/\r?\n/).map(line => (line === "" ? [] : [{ kind: "plain", text: line }])),
  };
}

// --- lexing -----------------------------------------------------------------

type Token =
  | { readonly kind: "punctuation"; readonly text: string }
  | { readonly kind: "string" | "number" | "boolean" | "null"; readonly text: string };

/**
 * `clean`: the input ended between tokens. `cut`: it ended inside a token
 * (kept, incomplete, as the last token). `error`: something that is not
 * JSON at all.
 */
interface Lexed {
  readonly tokens: Token[];
  readonly end: "clean" | "cut" | "error";
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** A number that stops early: what a cut can leave behind ("-", "1.", "2e+"). */
const NUMBER_PREFIX = /^-?\d*(?:\.\d*)?(?:[eE][+-]?\d*)?$/;
const LITERALS = [
  { text: "true", kind: "boolean" },
  { text: "false", kind: "boolean" },
  { text: "null", kind: "null" },
] as const;

function lex(text: string): Lexed {
  const tokens: Token[] = [];
  // A leading byte-order mark is not content; some servers send one.
  let at = text.startsWith("﻿") ? 1 : 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      at += 1;
      continue;
    }
    if ("{}[]:,".includes(char)) {
      tokens.push({ kind: "punctuation", text: char });
      at += 1;
      continue;
    }
    const scanned = scanToken(text, at);
    if (scanned === null) return { tokens, end: "error" };
    tokens.push(scanned.token);
    if (scanned.cut) return { tokens, end: "cut" };
    at = scanned.next;
  }
  return { tokens, end: "clean" };
}

/** One string, number, or literal starting at `at`; null when none starts there. */
function scanToken(
  text: string,
  at: number,
): { token: Token; next: number; cut: boolean } | null {
  const char = text.charAt(at);
  if (char === "\"") return scanString(text, at);
  if (char === "-" || (char >= "0" && char <= "9")) return scanNumber(text, at);
  const rest = text.slice(at);
  for (const literal of LITERALS) {
    if (rest.startsWith(literal.text)) {
      return { token: { kind: literal.kind, text: literal.text }, next: at + literal.text.length, cut: false };
    }
    if (literal.text.startsWith(rest)) return { token: { kind: literal.kind, text: rest }, next: text.length, cut: true };
  }
  return null;
}

function scanString(text: string, start: number): { token: Token; next: number; cut: boolean } | null {
  let at = start + 1;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === "\"") {
      return { token: { kind: "string", text: text.slice(start, at + 1) }, next: at + 1, cut: false };
    }
    // JSON strings may not hold raw control characters.
    if (char < " ") return null;
    if (char === "\\") {
      const escape = escapeLength(text, at);
      if (escape === null) return null;
      at += escape;
    } else {
      at += 1;
    }
  }
  return { token: { kind: "string", text: text.slice(start) }, next: text.length, cut: true };
}

/** Length of the escape at `at` (a backslash); an escape cut by the end of text still counts. */
function escapeLength(text: string, at: number): number | null {
  const kind = text.charAt(at + 1);
  if (kind === "") return 1;
  if ("\"\\/bfnrt".includes(kind)) return 2;
  if (kind !== "u") return null;
  const hex = text.slice(at + 2, at + 6);
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  return 2 + hex.length;
}

function scanNumber(text: string, start: number): { token: Token; next: number; cut: boolean } | null {
  NUMBER.lastIndex = start;
  const match = NUMBER.exec(text);
  const end = match === null ? start : start + match[0].length;
  const rest = text.slice(start);
  // The strict match stopped short of the end on a number-ish tail: the
  // text was cut inside the number ("1." or "-").
  if (end < text.length && NUMBER_PREFIX.test(rest)) {
    return { token: { kind: "number", text: rest }, next: text.length, cut: true };
  }
  if (match === null) return null;
  return { token: { kind: "number", text: match[0] }, next: end, cut: false };
}

// --- layout -----------------------------------------------------------------

/**
 * Why the printer stopped early: `cut` when the tokens run out mid-document
 * (a truncated prefix), `invalid` on tokens in an order JSON does not allow.
 */
class LayoutStop extends Error {
  constructor(readonly reason: "cut" | "invalid") {
    super(reason);
  }
}

/**
 * Lay the tokens out as pretty lines. `complete` is false when the tokens
 * ran out mid-document; null means they are not JSON (including trailing
 * tokens after the document).
 */
function layout(tokens: readonly Token[]): { lines: JsonLine[]; complete: boolean } | null {
  if (tokens.length === 0) return null;
  const printer = new Printer(tokens);
  try {
    printer.value(0);
    if (printer.hasMore()) return null;
    return { lines: printer.finish(), complete: true };
  } catch (error) {
    if (!(error instanceof LayoutStop)) throw error;
    return error.reason === "cut" ? { lines: printer.finish(), complete: false } : null;
  }
}

class Printer {
  private at = 0;
  private readonly lines: JsonSpan[][] = [];
  private line: JsonSpan[] = [];

  constructor(private readonly tokens: readonly Token[]) {}

  hasMore(): boolean {
    return this.at < this.tokens.length;
  }

  /**
   * Every line so far. A cut right after a separator leaves a line holding
   * only indentation; it carries nothing, so it is dropped.
   */
  finish(): JsonLine[] {
    const last = this.line.every(span => span.kind === "plain" && span.text.trim() === "");
    return last && this.lines.length > 0 ? [...this.lines] : [...this.lines, this.line];
  }

  value(depth: number): void {
    if (depth > MAX_DEPTH) throw new LayoutStop("invalid");
    const token = this.next();
    if (token.kind !== "punctuation") {
      this.emit(token.kind, token.text);
      return;
    }
    if (token.text === "{") this.container(depth, "{", "}");
    else if (token.text === "[") this.container(depth, "[", "]");
    else throw new LayoutStop("invalid");
  }

  /** An object or array body after its opening bracket. */
  private container(depth: number, open: string, close: string): void {
    this.emit("punctuation", open);
    if (this.peekIs(close)) {
      this.next();
      this.emit("punctuation", close);
      return;
    }
    for (;;) {
      this.newline(depth + 1);
      if (open === "{") this.member(depth + 1);
      else this.value(depth + 1);
      const separator = this.next();
      if (separator.kind !== "punctuation") throw new LayoutStop("invalid");
      if (separator.text === ",") {
        this.emit("punctuation", ",");
        continue;
      }
      if (separator.text !== close) throw new LayoutStop("invalid");
      this.newline(depth);
      this.emit("punctuation", close);
      return;
    }
  }

  /** `"key": value` inside an object. */
  private member(depth: number): void {
    const key = this.next();
    if (key.kind !== "string") throw new LayoutStop("invalid");
    this.emit("key", key.text);
    const colon = this.next();
    if (colon.kind !== "punctuation" || colon.text !== ":") throw new LayoutStop("invalid");
    this.emit("punctuation", ":");
    this.emit("plain", " ");
    this.value(depth);
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new LayoutStop("cut");
    this.at += 1;
    return token;
  }

  private peekIs(text: string): boolean {
    const token = this.tokens[this.at];
    return token?.kind === "punctuation" && token.text === text;
  }

  private newline(depth: number): void {
    this.lines.push(this.line);
    this.line = depth === 0 ? [] : [{ kind: "plain", text: INDENT.repeat(depth) }];
  }

  private emit(kind: JsonTokenKind, text: string): void {
    this.line.push({ kind, text });
  }
}
