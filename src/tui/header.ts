import { BoxRenderable, StyledText, TextRenderable, bg, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { halftoneBox } from "./render.ts";
import { THEME } from "./theme.ts";

/** Terminal rows the header takes: its one content row inside a rounded frame. */
export const HEADER_ROWS = 3;

/** Header bar: POSTUI wordmark + halftone left, workspace center, env badge right. */
export function buildHeader(
  renderer: CliRenderer,
  options: { readonly workspaceName: string; readonly envBadge: string },
): BoxRenderable {
  const header = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.panel,
    paddingX: 1,
    height: HEADER_ROWS,
    width: "100%",
  });

  const left = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    width: "33%",
  });
  left.add(new TextRenderable(renderer, { content: new StyledText(wordmark("POSTUI")) }));
  // The mockup's halftone strip fading out beside the wordmark.
  left.add(halftoneBox(renderer, 16, 1, "top-left"));
  header.add(left);

  const center = new BoxRenderable(renderer, {
    alignItems: "center",
    justifyContent: "center",
    width: "34%",
  });
  center.add(
    new TextRenderable(renderer, { content: options.workspaceName, fg: THEME.color.muted }),
  );
  header.add(center);

  const right = new BoxRenderable(renderer, {
    alignItems: "center",
    justifyContent: "flex-end",
    width: "33%",
  });
  // The env badge as a small accent pill: it names where sends go.
  right.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(bg(THEME.color.accentSoft)(fg(THEME.color.accent)(` ${options.envBadge} `))),
      ]),
    }),
  );
  header.add(right);

  return header;
}

/**
 * The spaced wordmark, one bloom color per letter (the develop effect's
 * palette, so the brand and the reveals share their colors). The walk
 * starts on the palette's last color, the accent, so the mark opens in
 * iris before it warms.
 */
function wordmark(word: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const palette = THEME.bloom;
  [...word].forEach((letter, index) => {
    if (index > 0) chunks.push(fg(THEME.color.panel)(" "));
    const color = palette[(index + palette.length - 1) % palette.length] ?? THEME.color.accent;
    chunks.push(bold(fg(color)(letter)));
  });
  return chunks;
}
