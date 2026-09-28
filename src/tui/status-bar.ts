import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, Renderable, TextChunk } from "@opentui/core";
import type { KeyHint } from "./keymap.ts";
import { clearChildren } from "./render.ts";
import { THEME } from "./theme.ts";

/**
 * The bottom bar as a mode-aware component: ONE row, no frame, no cells.
 * The left side is the focused pane's key hints while browsing (key in the
 * body text, label muted, two spaces apart) and the query input while
 * searching (the palette lives where the mockup draws `/ search`); while a
 * send is in flight the send hint says so in the accent. The right side is
 * a live-status slot that the app drives on its own clock: a short text
 * and, beside it, one renderable such as a spinner.
 */
export type StatusBarMode = "browsing" | "searching" | "sending";

/** Terminal rows the status bar takes. */
export const STATUS_BAR_ROWS = 1;

export interface SearchBarState {
  readonly query: string;
  /** Matches for the current query (null before the first count arrives). */
  readonly matchCount: number | null;
}

export interface StatusBar {
  readonly pane: BoxRenderable;
  /**
   * Repaint the left side for the given mode. `hints` are the focused
   * pane's key hints (the shell picks them); `search` feeds the palette.
   * Never touches the live-status slot.
   */
  paint(mode: StatusBarMode, hints: readonly KeyHint[], search?: SearchBarState): void;
  /**
   * The live-status text at the bar's right edge (a plain string renders
   * muted; a StyledText keeps its own colors). null clears it.
   */
  setStatus(content: StyledText | string | null): void;
  /**
   * Mount one renderable (a spinner) just left of the status text. The bar
   * owns it from here on: replacing or clearing it (null) destroys it, so
   * its timers stop with it.
   */
  setIndicator(node: Renderable | null): void;
}

export function startStatusBar(renderer: CliRenderer): StatusBar {
  const pane = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: THEME.color.bg,
    height: STATUS_BAR_ROWS,
    width: "100%",
    paddingX: 1,
    gap: 2,
  });
  // The left side is rebuilt on every paint; the live slot on the right
  // persists across paints so a running spinner is never torn down by a
  // focus move.
  const left = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
    overflow: "hidden",
  });
  const live = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, gap: 1 });
  const statusText = new TextRenderable(renderer, { content: "", fg: THEME.color.muted });
  live.add(statusText);
  pane.add(left);
  pane.add(live);
  let indicator: Renderable | null = null;

  const paint = (
    mode: StatusBarMode,
    hints: readonly KeyHint[],
    search?: SearchBarState,
  ): void => {
    clearChildren(left);
    const content =
      mode === "searching" && search !== undefined
        ? searchChunks(search.query, search.matchCount)
        : hintChunks(hints, mode === "sending");
    left.add(new TextRenderable(renderer, { content: new StyledText(content), wrapMode: "none" }));
  };

  const setStatus = (content: StyledText | string | null): void => {
    statusText.content = content ?? "";
  };

  const setIndicator = (node: Renderable | null): void => {
    indicator?.destroyRecursively();
    indicator = node;
    if (node !== null) live.add(node, 0);
  };

  return { pane, paint, setStatus, setIndicator };
}

/** Two spaces between hints: the gap alone separates them, no rules. */
const HINT_GAP = "  ";

/**
 * The hints as one styled line: key in the body text, label muted. While a
 * send is in flight the send hint reads "sending…", key and label both in
 * the accent.
 */
function hintChunks(hints: readonly KeyHint[], sending: boolean): TextChunk[] {
  const chunks: TextChunk[] = [];
  hints.forEach((hint, index) => {
    if (index > 0) chunks.push(fg(THEME.color.muted)(HINT_GAP));
    const display = hint.glyph ?? hint.key;
    if (hint.label === "send" && sending) {
      chunks.push(bold(fg(THEME.color.accent)(display)), fg(THEME.color.accent)(" sending…"));
      return;
    }
    chunks.push(bold(fg(THEME.color.text)(display)), fg(THEME.color.muted)(` ${hint.label}`));
  });
  return chunks;
}

/** Query characters shown before the palette overflows the bar. */
const MAX_QUERY_CHARS = 32;

/** The search palette: accent "/" prompt, the query and cursor, match count, way out. */
function searchChunks(query: string, matchCount: number | null): TextChunk[] {
  // Keep the newest characters visible: the cursor is at the end, so the
  // tail of the query is what the eye is on.
  const shown =
    query.length > MAX_QUERY_CHARS ? `…${query.slice(-(MAX_QUERY_CHARS - 1))}` : query;
  const count =
    matchCount === null ? "" : `  ${matchCount} match${matchCount === 1 ? "" : "es"}`;
  return [
    bold(fg(THEME.color.accent)("/")),
    fg(THEME.color.text)(` ${shown}`),
    fg(THEME.color.accent)("▌"),
    fg(THEME.color.muted)(count),
    fg(THEME.color.muted)(HINT_GAP),
    ...hintChunks(
      [
        { key: "enter", label: "open", glyph: "⏎" },
        { key: "esc", label: "back" },
      ],
      false,
    ),
  ];
}
