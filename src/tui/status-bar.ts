import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { GLOBAL_KEYS } from "./keymap.ts";
import type { KeyHint } from "./keymap.ts";
import { clearChildren } from "./render.ts";
import { THEME } from "./theme.ts";

/**
 * The mockup's bottom bar as a mode-aware component: while browsing it is
 * the key map in full-height cells; while searching it becomes the query
 * input (the palette lives where the mockup draws `/ search`); while a send
 * is in flight the send cell says so in the accent color.
 */
export type StatusBarMode = "browsing" | "searching" | "sending";

export interface SearchBarState {
  readonly query: string;
  /** Matches for the current query (null before the first count arrives). */
  readonly matchCount: number | null;
}

export interface StatusBar {
  readonly pane: BoxRenderable;
  /** Repaint the bar for the given mode. */
  paint(mode: StatusBarMode, search?: SearchBarState): void;
}

export function startStatusBar(renderer: CliRenderer): StatusBar {
  const pane = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "stretch",
    border: true,
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.bg,
    height: 3,
    width: "100%",
  });

  const paint = (mode: StatusBarMode, search?: SearchBarState): void => {
    clearChildren(pane);
    if (mode === "searching" && search !== undefined) {
      pane.add(searchCell(renderer, search.query, search.matchCount));
      return;
    }
    for (const [index, hint] of GLOBAL_KEYS.entries()) {
      pane.add(browseCell(renderer, hint, index === 0, mode === "sending"));
    }
  };

  return { pane, paint };
}

/**
 * One key-map cell: full-height separator between equally weighted hints
 * (the first cell has no left border — the bar's own frame closes that
 * side). While a send is in flight the send cell says so, in the accent
 * color.
 */
function browseCell(
  renderer: CliRenderer,
  hint: KeyHint,
  first: boolean,
  sending: boolean,
): BoxRenderable {
  // borderColor only on the bordered cells: OpenTUI 0.5.9 paints a full
  // border around a border:false box the moment a border color is set.
  const cell = new BoxRenderable(renderer, {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    ...(first ? {} : { border: ["left"] as const, borderColor: THEME.color.border }),
  });
  if (hint.label === "send" && sending) {
    cell.add(
      new TextRenderable(renderer, {
        content: new StyledText([
          bold(fg(THEME.color.accent)(hint.glyph ?? hint.key)),
          fg(THEME.color.accent)(" sending…"),
        ]),
      }),
    );
    return cell;
  }
  cell.add(new TextRenderable(renderer, { content: keyHintText(hint) }));
  return cell;
}

/** Query characters shown before the palette cell overflows the bar. */
const MAX_QUERY_CHARS = 32;

/** The search-palette cell: accent "/" prompt, the query, match count, way out. */
function searchCell(
  renderer: CliRenderer,
  query: string,
  matchCount: number | null,
): BoxRenderable {
  const cell = new BoxRenderable(renderer, {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
  });
  // Keep the oldest characters visible: the cursor is at the end, so the
  // tail of the query is what the eye is on.
  const shown =
    query.length > MAX_QUERY_CHARS ? `…${query.slice(-(MAX_QUERY_CHARS - 1))}` : query;
  const count =
    matchCount === null ? "" : `  ${matchCount} match${matchCount === 1 ? "" : "es"}`;
  cell.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(THEME.color.accent)("/")),
        fg(THEME.color.bright)(` ${shown}▌`),
        fg(THEME.color.dim)(count),
        fg(THEME.color.dim)("  ·  ⏎ open · esc back"),
      ]),
    }),
  );
  return cell;
}

/** The key hint as styled chunks: bright bold key, muted label. */
function keyHintText(hint: KeyHint): StyledText {
  const display = hint.glyph ?? hint.key;
  return new StyledText([
    bold(fg(THEME.color.bright)(display)),
    fg(THEME.color.text)(` ${hint.label}`),
  ]);
}
