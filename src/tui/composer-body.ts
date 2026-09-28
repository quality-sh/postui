import { highlightJson } from "./json-highlight.ts";
import type { JsonTokenKind } from "./json-highlight.ts";
import { span, type Span } from "./composer-spans.ts";
import { JSON_COLORS, THEME } from "./theme.ts";

/**
 * Body-editor colouring. The editor shows the body EXACTLY as typed — the
 * cursor offsets index into that text — so the JSON is never re-laid out.
 * highlightJson (the response pane's printer) still decides what each
 * token is: its spans carry the source tokens in order, only whitespace
 * added, so walking them against the raw text puts each kind back on the
 * characters it came from. A body that is not JSON (or not yet: mid-edit
 * `{"a" 1`) draws plain, like any text.
 */

/** A coloured stretch of the raw text: [start, end) and its token kind. */
interface Token {
  readonly start: number;
  readonly end: number;
  readonly kind: JsonTokenKind;
}

const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "﻿";

/** The raw text's tokens, or null when it is not JSON (or the walk loses step). */
function tokensOf(text: string): Token[] | null {
  const laidOut = highlightJson(text, { truncated: true });
  if (laidOut.format === "text") return null;
  const tokens: Token[] = [];
  let at = 0;
  for (const line of laidOut.lines) {
    for (const part of line) {
      if (part.kind === "plain") continue; // the printer's indentation and spacing
      while (at < text.length && isSpace(text.charAt(at))) at += 1;
      if (!text.startsWith(part.text, at)) return null;
      tokens.push({ start: at, end: at + part.text.length, kind: part.kind });
      at += part.text.length;
    }
  }
  return tokens;
}

/**
 * The body as coloured spans, one list per `\n`-separated line. JSON
 * tokens take their JSON_COLORS role; everything else is body text.
 */
export function bodySpans(text: string): Span[][] {
  const tokens = tokensOf(text) ?? [];
  const lines: Span[][] = [];
  let lineStart = 0;
  let next = 0;
  for (const raw of text.split("\n")) {
    const lineEnd = lineStart + raw.length;
    const spans: Span[] = [];
    let at = lineStart;
    for (let token = tokens[next]; token !== undefined && token.start < lineEnd; token = tokens[next]) {
      if (token.start > at) spans.push(span(text.slice(at, token.start), THEME.color.text));
      spans.push(span(text.slice(token.start, token.end), JSON_COLORS[token.kind]));
      at = token.end;
      next += 1;
    }
    if (at < lineEnd) spans.push(span(text.slice(at, lineEnd), THEME.color.text));
    lines.push(spans);
    lineStart = lineEnd + 1;
  }
  return lines;
}

/**
 * A one-line JSON body laid out for reading (two-space indent), its tokens
 * exactly as written — the layout comes from highlightJson, which never
 * re-prints a number, so `1.0` and 20-digit ids survive. Null when the body
 * is not complete JSON, has nothing to lay out, or already spans lines (its
 * author chose that layout).
 */
export function prettyBody(text: string): string | null {
  if (text.includes("\n")) return null;
  const laidOut = highlightJson(text);
  if (laidOut.format !== "json" || laidOut.lines.length < 2) return null;
  return laidOut.lines.map(line => line.map(part => part.text).join("")).join("\n");
}
