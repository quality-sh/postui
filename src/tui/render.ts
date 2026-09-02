import { BoxRenderable, StyledText, TextRenderable, bold, fg, underline } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { THEME } from "./theme.ts";

/**
 * Render helpers shared by every pane: child clearing, named-error text and
 * line-numbered blocks. Kept free of pane policy so the collections,
 * composer, and response panes stay visually consistent.
 */

/** Remove every child of a box (getChildren() is a fresh array: safe to mutate while iterating). */
export function clearChildren(box: BoxRenderable): void {
  for (const child of box.getChildren()) box.remove(child);
}

/** The tag of a named typed error (Effect `_tag`), or the Error class name. */
export function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag);
  }
  return error instanceof Error ? error.name : "Error";
}

export function namedErrorText(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`;
}

/**
 * One diagnostic line in the CLI's exact format — tag plus message, never a
 * stack trace. Send-pipeline typed errors arrive pre-scrubbed (the pipeline
 * scrubs its own messages), so this text is safe to render verbatim.
 */
export function errorLine(error: unknown): string {
  return `error: ${namedErrorText(errorName(error), error)}`;
}

/** Lines shown of a numbered block before an honest count takes over. */
const MAX_NUMBERED_LINES = 200;

/**
 * The mockup's line-numbered block (dim gutter): used by the composer's body
 * editor and the response body. Content color is the caller's theme decision
 * (lavender for request text, gold — reserved — for response content). Past
 * MAX_NUMBERED_LINES the block says so instead of silently hiding the rest —
 * and never builds more renderables than the cap, so a megabyte excerpt
 * cannot explode the pane.
 */
export function numberedLines(
  renderer: CliRenderer,
  text: string,
  contentColor: string,
  maxLines = MAX_NUMBERED_LINES,
): TextRenderable[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const shown = lines.slice(0, maxLines);
  const width = String(shown.length).length;
  const rows = shown.map((line, index) => {
    const gutter = `${String(index + 1).padStart(width, " ")} │ `;
    return new TextRenderable(renderer, {
      content: new StyledText([
        fg(THEME.color.dim)(gutter),
        fg(contentColor)(line === "" ? " " : line),
      ]),
      width: "100%",
    });
  });
  if (lines.length > maxLines) {
    rows.push(
      new TextRenderable(renderer, {
        content: `… (${lines.length - maxLines} more lines held back)`,
        fg: THEME.color.dim,
        width: "100%",
      }),
    );
  }
  return rows;
}

/**
 * The mockup's tab strip: labels in a row, the active one bold/bright and
 * underlined (the mockup's underline marker; the underline renders in the
 * text color, so `underlineColor` picks the label's own color — accent in
 * the composer, gold in the response pane).
 */
export function tabsRow(
  renderer: CliRenderer,
  labels: readonly string[],
  active: number,
  underlineColor: string,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    gap: 2,
    width: "100%",
  });
  labels.forEach((label, index) => {
    if (index === active) {
      row.add(
        new TextRenderable(renderer, {
          content: new StyledText([underline(bold(fg(underlineColor)(label)))]),
        }),
      );
      return;
    }
    row.add(new TextRenderable(renderer, { content: label, fg: THEME.color.text }));
  });
  return row;
}
