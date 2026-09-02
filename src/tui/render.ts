import { BoxRenderable, StyledText, TextRenderable, bold, fg, underline } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { THEME } from "./theme.ts";

/**
 * Render helpers shared by every pane: child clearing, named-error text,
 * line-numbered blocks, the one empty-state style, and the mockup's halftone
 * dot decoration. Kept free of pane policy so the collections, composer, and
 * response panes stay visually consistent.
 */

/** Remove every child of a box (getChildren() is a fresh array: safe to mutate while iterating). */
export function clearChildren(box: BoxRenderable): void {
  for (const child of box.getChildren()) box.remove(child);
}

/** The tone of one empty-state line (theme roles, never raw colors). */
type EmptyTone = "text" | "dim" | "bright";

/** One line of the shared empty state: what is missing, or the way out. */
export interface EmptyStateLine {
  readonly text: string;
  readonly tone: EmptyTone;
}

const TONE_COLORS: Record<EmptyTone, string> = {
  text: THEME.color.text,
  dim: THEME.color.dim,
  bright: THEME.color.bright,
};

/**
 * The ONE empty-state style every pane shares (the mockup's centered stacked
 * hint): what is missing in the text tone, hints dimmed, the fix-it command
 * bright. Panes pass their lines; the styling lives here so the panes
 * cannot drift apart. `decor` pins the halftone dot field under the message
 * (the mockup's dotted left rail) — used by panes with large empty regions.
 */
export function renderEmptyState(
  renderer: CliRenderer,
  pane: BoxRenderable,
  lines: readonly EmptyStateLine[],
  options: { readonly decor?: boolean } = {},
): BoxRenderable {
  const box = emptyStateBox(renderer, lines, options);
  pane.add(box);
  return box;
}

/** The shared empty-state box without a parent — for panes that place it themselves. */
export function emptyStateBox(
  renderer: CliRenderer,
  lines: readonly EmptyStateLine[],
  options: { readonly decor?: boolean } = {},
): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
    gap: 1,
  });
  // Spacers center the message in the space above the decoration (or the
  // whole pane when there is none).
  box.add(new BoxRenderable(renderer, { flexGrow: 1 }));
  const block = new BoxRenderable(renderer, {
    flexDirection: "column",
    alignItems: "center",
    gap: 1,
    width: "100%",
  });
  for (const line of lines) {
    block.add(
      new TextRenderable(renderer, { content: line.text, fg: TONE_COLORS[line.tone] }),
    );
  }
  box.add(block);
  if (options.decor === true) {
    box.add(halftoneTail(renderer));
  } else {
    box.add(new BoxRenderable(renderer, { flexGrow: 1 }));
  }
  return box;
}

/** Halftone decoration size for shared empty states and the left rail. */
export const DECOR_SIZE = { width: 14, height: 5 } as const;

/** Braille bit for each of the eight dot positions (U+2800 block layout). */
const DOT_BITS = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80] as const;

/** Deterministic per-dot noise in [0,1) — pure, so re-renders never shimmer. */
function dotNoise(row: number, col: number, sub: number): number {
  let h = (row * 374761393 + col * 668265263 + sub * 0x9e3779b1) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The mockup's halftone dot field as text rows: a braille dot grid whose
 * density falls off with the distance from the anchor corner (dense at the
 * corner, fading across the block). Deterministic in (row, col, dot), so a
 * re-render paints exactly the same dots.
 */
function halftoneLines(
  width: number,
  height: number,
  anchor: "bottom-left" | "top-left",
): string[] {
  const lines: string[] = [];
  const spanX = Math.max(1, width - 1);
  const spanY = Math.max(1, height - 1);
  for (let row = 0; row < height; row += 1) {
    let line = "";
    for (let col = 0; col < width; col += 1) {
      const fx = col / spanX;
      const fy =
        anchor === "bottom-left"
          ? (height - 1 - row) / spanY
          : row / spanY;
      // Density peaks at the anchor corner and fades across the block. The
      // 0.5 cap keeps even the densest cell speckled (at most half the
      // braille dots on) so the field reads as dots, never as solid blocks.
      const dist = Math.hypot(fx, fy) / Math.SQRT2;
      const density = Math.max(0, 1 - dist) ** 1.5 * 0.5;
      let bits = 0;
      for (let sub = 0; sub < DOT_BITS.length; sub += 1) {
        if (dotNoise(row, col, sub) < density) bits |= DOT_BITS[sub] ?? 0;
      }
      line += bits === 0 ? " " : String.fromCharCode(0x2800 + bits);
    }
    lines.push(line);
  }
  return lines;
}

/** The halftone field as a fixed-size decoration box (dim dots on the bg). */
export function halftoneBox(
  renderer: CliRenderer,
  width: number,
  height: number,
  anchor: "bottom-left" | "top-left",
): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    flexDirection: "column",
    width,
    height,
  });
  for (const line of halftoneLines(width, height, anchor)) {
    box.add(new TextRenderable(renderer, { content: line, fg: THEME.color.dim }));
  }
  return box;
}

/** A flexible spacer pinning the halftone decoration to a pane's bottom. */
export function halftoneTail(renderer: CliRenderer): BoxRenderable {
  const tail = new BoxRenderable(renderer, {
    flexDirection: "column",
    justifyContent: "flex-end",
    flexGrow: 1,
    width: "100%",
  });
  tail.add(halftoneBox(renderer, DECOR_SIZE.width, DECOR_SIZE.height, "bottom-left"));
  return tail;
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
