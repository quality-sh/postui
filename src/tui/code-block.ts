import { BoxRenderable, LineNumberRenderable, ScrollBoxRenderable, StyledText, TextRenderable, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { cellsFromSpans, developLines, type Cell } from "./fx/develop.ts";
import type { HighlightedJson, JsonSpan } from "./json-highlight.ts";
import { JSON_COLORS, THEME } from "./theme.ts";

/** Lines shown of a block before an honest count takes over. */
const MAX_BLOCK_LINES = 200;

/** Gutter: at least 3 columns, one blank column right of the number (LineNumberRenderable's own sizing). */
const GUTTER_MIN = 3;

interface ColoredSpan {
  readonly text: string;
  readonly fg: string;
}

/** A layout as coloured lines: the numbered ones, then an unnumbered dim "…" when cut. */
interface CodeLines {
  readonly lines: ColoredSpan[][];
  /** Index of the unnumbered cut marker line, or -1. */
  readonly cutAt: number;
  /** Lines past MAX_BLOCK_LINES, held back. */
  readonly heldBack: number;
}

/** A token span in its theme colour (spans carry kinds, never colours). */
function colored(span: JsonSpan): ColoredSpan {
  return { text: span.text, fg: JSON_COLORS[span.kind] };
}

function codeLines(layout: HighlightedJson): CodeLines {
  const lines = layout.lines
    .slice(0, MAX_BLOCK_LINES)
    .map(spans => spans.map(colored));
  let cutAt = -1;
  if (layout.format === "partial") {
    cutAt = lines.length;
    lines.push([{ text: "…", fg: THEME.color.dim }]);
  }
  return { lines, cutAt, heldBack: Math.max(0, layout.lines.length - MAX_BLOCK_LINES) };
}

/**
 * The block's frame: fills the room its parent has (zero basis — a long
 * body must never grow its pane into a neighbour's space) and scrolls the
 * rest. It never takes key focus, so the pane's own keys keep working.
 */
function blockFrame(renderer: CliRenderer): ScrollBoxRenderable {
  const block = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 1,
    width: "100%",
    backgroundColor: THEME.color.panel,
    scrollbarOptions: { trackOptions: { foregroundColor: THEME.color.dim, backgroundColor: THEME.color.panel } },
  });
  block.focusable = false;
  // Lines wrap, so there is never anything to scroll sideways; pinning the
  // horizontal bar hidden also keeps it from costing the first frame a row.
  block.horizontalScrollBar.visible = false;
  return block;
}

function heldBackNote(renderer: CliRenderer, count: number): TextRenderable {
  return new TextRenderable(renderer, {
    content: `… (${count} more lines held back)`,
    fg: THEME.color.dim,
    width: "100%",
  });
}

/**
 * The mockup's code block, for a laid-out body (json-highlight.ts): no box
 * of its own, just a gutter of line numbers on the element tone beside the
 * lines on the pane's panel, coloured by token kind. The whole body is ONE
 * text renderable under OpenTUI's line-number gutter, so long lines wrap
 * beside the gutter (a number marks only a line's first row) and the block
 * costs three renderables however long it is. A `partial` layout ends in
 * a dim "…" where the text was cut. Past MAX_BLOCK_LINES the block says so
 * instead of silently hiding the rest.
 */
export function codeBlock(renderer: CliRenderer, layout: HighlightedJson): ScrollBoxRenderable {
  const block = blockFrame(renderer);
  const { lines, cutAt, heldBack } = codeLines(layout);
  block.add(numberedText(renderer, lines, cutAt));
  if (heldBack > 0) block.add(heldBackNote(renderer, heldBack));
  return block;
}

/** The settled lines: one wrapping text under OpenTUI's line-number gutter. */
function numberedText(renderer: CliRenderer, lines: readonly ColoredSpan[][], cutAt: number): LineNumberRenderable {
  const chunks: TextChunk[] = [];
  lines.forEach((spans, index) => {
    if (index > 0) chunks.push(fg(THEME.color.text)("\n"));
    for (const span of spans) chunks.push(fg(span.fg)(span.text));
  });
  const text = new TextRenderable(renderer, {
    content: new StyledText(chunks),
    wrapMode: "char",
    flexGrow: 1,
    flexShrink: 1,
    marginLeft: 1,
  });
  return new LineNumberRenderable(renderer, {
    target: text,
    fg: THEME.color.dim,
    bg: THEME.color.element,
    minWidth: GUTTER_MIN,
    width: "100%",
    hideLineNumbers: new Set(cutAt < 0 ? [] : [cutAt]),
  });
}

export interface DevelopingBlockOptions {
  /** Columns inside the pane's padding: the block's full width. */
  readonly width: number;
  /** Rows the block has before it must scroll (a scroll bar then takes a column). */
  readonly rows: number;
  /** Develop seed: the send number, so a repeat send develops differently. */
  readonly seed: number;
}

/** Gutter columns for a block of `rows` visual rows, as LineNumberRenderable sizes it. */
function gutterWidth(rows: number): number {
  return Math.max(GUTTER_MIN, String(Math.max(1, rows)).length + 2);
}

/** Each line as develop rows wrapped at `wrap` columns (a line is at least one row). */
function wrapped(lines: readonly ColoredSpan[][], wrap: number): Cell[][][] {
  return lines.map(spans => cellsFromSpans([spans], { wrap: Math.max(1, wrap) }));
}

/**
 * The code block developing in: the same gutter and wrapping as codeBlock,
 * with the text drawn by the develop effect. The wrap width is worked out
 * from the pane's size the way the settled block lays itself out (gutter,
 * one column of margin, a scroll-bar column once the rows overflow), so
 * when the develop settles and the plain lines take its place nothing
 * moves. It is the same scroll box before and after, so ↑/↓ work while it
 * develops and the scroll position carries over.
 */
export function developingCodeBlock(
  renderer: CliRenderer,
  layout: HighlightedJson,
  opts: DevelopingBlockOptions,
): ScrollBoxRenderable {
  const block = blockFrame(renderer);
  const { lines, cutAt, heldBack } = codeLines(layout);
  let viewport = opts.width;
  let gutter = gutterWidth(lines.length);
  let rows = wrapped(lines, viewport - gutter - 1);
  if (rows.flat().length + (heldBack > 0 ? 1 : 0) > opts.rows) viewport -= 1; // the scroll bar's column
  gutter = gutterWidth(rows.flat().length);
  rows = wrapped(lines, viewport - gutter - 1);
  gutter = gutterWidth(rows.flat().length);

  // A number marks a line's first row only, right-aligned before one blank column.
  const numbers: string[] = [];
  rows.forEach((line, index) => {
    const label = index === cutAt ? "" : String(index + 1);
    line.forEach((_, row) => numbers.push((row === 0 ? label : "").padStart(gutter - 1).padEnd(gutter)));
  });
  const row = new BoxRenderable(renderer, { flexDirection: "row", width: "100%" });
  const gutterBox = new BoxRenderable(renderer, { backgroundColor: THEME.color.element, flexShrink: 0 });
  gutterBox.add(new TextRenderable(renderer, { content: numbers.join("\n"), fg: THEME.color.dim }));
  row.add(gutterBox);
  // Settled, the develop gives way to the plain lines in the same scroll
  // box, so the reader's scroll position survives the swap.
  const settle = (): void => {
    if (row.isDestroyed) return;
    row.destroyRecursively();
    block.add(numberedText(renderer, lines, cutAt), 0);
  };
  const develop = developLines(renderer, rows.flat(), { seed: opts.seed, onDone: settle });
  develop.marginLeft = 1;
  row.add(develop);
  block.add(row);
  if (heldBack > 0) block.add(heldBackNote(renderer, heldBack));
  return block;
}
