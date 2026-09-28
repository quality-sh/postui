/**
 * The key hints shown in the status bar and the app-level key map.
 *
 * Display side: the status bar shows the hints of the FOCUSED pane
 * (`PANE_KEY_HINTS`), in the mockup's look ("⏎ send" — arrows and enter are
 * the advertised keys; j/k/h/l stay silent aliases in the panes that own
 * them). A pane gains or changes hints with a one-line edit to that table.
 * Input side: `globalAction` maps a parsed key to an app-level action.
 * Pane-level keys (arrows, enter) are reserved for the panes that own them
 * and stay inert here; "/" is app-level because the search palette is shell
 * chrome (it replaces the status bar), and while it is open every printable
 * key — including a literal "/" — types into the query before this map ever
 * sees it.
 */
export interface KeyHint {
  readonly key: string;
  readonly label: string;
  /** Status-bar glyph shown instead of `key` when the mockup uses a symbol. */
  readonly glyph?: string;
}

const SELECT: KeyHint = { key: "up/down", label: "select", glyph: "↑↓" };
const SCROLL: KeyHint = { key: "up/down", label: "scroll", glyph: "↑↓" };
const TABS: KeyHint = { key: "left/right", label: "tabs", glyph: "←→" };
const SEND: KeyHint = { key: "enter", label: "send", glyph: "⏎" };
const FOCUS: KeyHint = { key: "tab", label: "focus" };
const SEARCH: KeyHint = { key: "/", label: "search" };
const QUIT: KeyHint = { key: "q", label: "quit" };

/** Hints when no registered pane has focus (and for the collections pane). */
export const DEFAULT_KEY_HINTS: readonly KeyHint[] = [SELECT, SEND, FOCUS, SEARCH, QUIT];

/**
 * Status-bar hints per pane id, in display order. The ids are the panes'
 * exported *_PANE_ID values (kept as literals so this table stays free of
 * pane imports; a test pins them together).
 */
export const PANE_KEY_HINTS: Readonly<Record<string, readonly KeyHint[]>> = {
  collections: DEFAULT_KEY_HINTS,
  composer: [
    { key: "type", label: "to edit" },
    TABS,
    SEND,
    { key: "ctrl+s", label: "save", glyph: "^s" },
    { key: "esc", label: "leave field" },
  ],
  // +/- re-send with a wider/narrower body window: said plainly, because a
  // re-send of a mutating request is a real second request.
  response: [SCROLL, TABS, { key: "+/-", label: "resend ±body" }, FOCUS, QUIT],
};

/** The hints for the focused pane (the default set for unknown or no focus). */
export function hintsFor(paneId: string | null): readonly KeyHint[] {
  return (paneId === null ? undefined : PANE_KEY_HINTS[paneId]) ?? DEFAULT_KEY_HINTS;
}

/** App-level actions the shell itself handles. */
export type GlobalAction = "quit" | "focus-next" | "focus-previous" | "search";

/** Minimal shape of a parsed keypress (a subset of OpenTUI's KeyEvent). */
export interface ParsedKeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift?: boolean;
}

/** What the global map needs to know about the app beyond the key itself. */
export interface GlobalKeyContext {
  /** A text field has keyboard focus: printable keys belong to it, never to the map. */
  readonly textFocused?: boolean;
}

/** Map a parsed keypress to a shell action, or null when the key is inert. */
export function globalAction(
  key: ParsedKeyLike,
  context: GlobalKeyContext = {},
): GlobalAction | null {
  if (key.ctrl && key.name === "c") return "quit";
  if (key.name === "tab") return key.shift === true ? "focus-previous" : "focus-next";
  // Panes with a text input (composer fields, search) consume printable keys
  // before they reach this map. The context check is the backstop: with a
  // text field focused, "q" and "/" never quit or open search.
  if (context.textFocused === true) return null;
  if (key.name === "q") return "quit";
  if (key.name === "/") return "search";
  return null;
}
