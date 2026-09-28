import { StyledText, TextRenderable, bg, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { THEME } from "./theme.ts";

/**
 * The composer's line model: a line of tab content is a list of spans
 * (text + hex colours), not renderables. One list feeds both the plain
 * repaint (as a StyledText) and the develop reveal (as fx cells), so the
 * two can never disagree about what a line says.
 */

export interface Span {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
  readonly bold?: boolean;
}

export interface ContentLine {
  readonly spans: readonly Span[];
  /** The table row this line draws (hover, pulses and fills follow it). */
  readonly row?: number;
}

export const span = (text: string, color: string): Span => ({ text, fg: color });

function chunkOf(part: Span): TextChunk {
  let chunk = fg(part.fg)(part.text);
  if (part.bg !== undefined) chunk = bg(part.bg)(chunk);
  return part.bold === true ? bold(chunk) : chunk;
}

/** One line as a single wrap-free text renderable. */
export function lineText(renderer: CliRenderer, spans: readonly Span[]): TextRenderable {
  const chunks = spans.map(chunkOf);
  return new TextRenderable(renderer, {
    content: new StyledText(chunks.length === 0 ? [fg(THEME.color.text)(" ")] : chunks),
    width: "100%",
    wrapMode: "none",
    flexShrink: 0, // one row, always: a squeezed line slides under the rule
  });
}

/** The spans from UTF-16 offset `from` on (a horizontally scrolled line). */
export function sliceSpans(spans: readonly Span[], from: number): Span[] {
  if (from <= 0) return [...spans];
  const out: Span[] = [];
  let at = 0;
  for (const part of spans) {
    const end = at + part.text.length;
    if (end > from) out.push({ ...part, text: part.text.slice(Math.max(0, from - at)) });
    at = end;
  }
  return out;
}

/**
 * The spans with a block cursor at UTF-16 offset `cursor`: the glyph under
 * it inverted onto the accent (a space when the cursor is past the end).
 */
export function withCursor(spans: readonly Span[], cursor: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  let placed = false;
  for (const part of spans) {
    const end = at + part.text.length;
    if (placed || cursor < at || cursor >= end) {
      out.push(part);
      at = end;
      continue;
    }
    const local = cursor - at;
    const glyph = String.fromCodePoint(part.text.codePointAt(local) ?? 32);
    if (local > 0) out.push({ ...part, text: part.text.slice(0, local) });
    out.push({ text: glyph, fg: THEME.color.bg, bg: THEME.color.accent });
    const rest = part.text.slice(local + glyph.length);
    if (rest !== "") out.push({ ...part, text: rest });
    placed = true;
    at = end;
  }
  if (!placed) out.push({ text: " ", fg: THEME.color.bg, bg: THEME.color.accent });
  return out;
}
