import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { HighlightedJson, JsonSpan } from "./json-highlight.ts";
import { JSON_COLORS, THEME } from "./theme.ts";

/** Lines shown of a block before an honest count takes over. */
const MAX_BLOCK_LINES = 200;

/**
 * The mockup's code block, for a laid-out body (json-highlight.ts): a
 * bordered box holding a gutter of line numbers, a vertical rule, and the
 * lines colored by token kind. It takes the room its parent has and scrolls
 * with the mouse wheel when the lines outgrow it; it never takes key focus,
 * so the pane's own keys keep working. Long lines wrap inside the rule, so
 * the gutter stays clean. A `partial` layout ends in a dim "…" where the
 * text was cut. Past MAX_BLOCK_LINES the block says so instead of silently
 * hiding the rest, and never builds more renderables than the cap.
 */
export function codeBlock(renderer: CliRenderer, layout: HighlightedJson): ScrollBoxRenderable {
  const block = new ScrollBoxRenderable(renderer, {
    // Zero basis: the block fills the room it is given and scrolls the rest
    // — a long body must never grow its pane into a neighbor's space.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 3,
    width: "100%",
    border: true,
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.bg,
    scrollbarOptions: { trackOptions: { foregroundColor: THEME.color.dim, backgroundColor: THEME.color.bg } },
  });
  block.focusable = false;
  // Lines wrap, so there is never anything to scroll sideways; pinning the
  // horizontal bar hidden also keeps it from costing the first frame a row.
  block.horizontalScrollBar.visible = false;
  const shown = layout.lines.slice(0, MAX_BLOCK_LINES);
  const gutter = String(shown.length).length;
  shown.forEach((spans, index) => {
    block.add(codeLine(renderer, String(index + 1).padStart(gutter), spans));
  });
  if (layout.format === "partial") {
    block.add(codeLine(renderer, " ".repeat(gutter), [{ kind: "plain", text: "…" }], THEME.color.dim));
  }
  if (layout.lines.length > MAX_BLOCK_LINES) {
    block.add(
      new TextRenderable(renderer, {
        content: `… (${layout.lines.length - MAX_BLOCK_LINES} more lines held back)`,
        fg: THEME.color.dim,
        width: "100%",
      }),
    );
  }
  return block;
}

/** One numbered line: gutter number, the rule (the cell's left border), the spans. */
function codeLine(
  renderer: CliRenderer,
  number: string,
  spans: readonly JsonSpan[],
  color?: string,
): BoxRenderable {
  const row = new BoxRenderable(renderer, { flexDirection: "row", width: "100%" });
  row.add(new TextRenderable(renderer, { content: ` ${number} `, fg: THEME.color.text, flexShrink: 0 }));
  const cell = new BoxRenderable(renderer, {
    border: ["left"],
    borderColor: THEME.color.border,
    paddingLeft: 1,
    flexGrow: 1,
    flexShrink: 1,
  });
  const chunks = spans.map(span => fg(color ?? JSON_COLORS[span.kind])(span.text));
  cell.add(
    new TextRenderable(renderer, {
      // A blank line still takes its row.
      content: new StyledText(chunks.length === 0 ? [fg(THEME.color.text)(" ")] : chunks),
      wrapMode: "char",
      width: "100%",
    }),
  );
  row.add(cell);
  return row;
}
