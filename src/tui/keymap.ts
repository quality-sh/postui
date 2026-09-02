/**
 * The global key map shown in the status bar and dispatched at app level.
 *
 * Display side: `GLOBAL_KEYS` renders exactly as in the mockup's bottom bar
 * ("⏎ send" — the composer owns enter). Input side: `globalAction` maps a
 * parsed key to an app-level action. Pane-level keys (j/k navigation,
 * enter run/open) are reserved for the panes that own them
 * (collections/composer) and stay inert here; "/" is app-level because the
 * search palette is shell chrome (it replaces the status bar), and while it
 * is open every printable key — including a literal "/" — types into the
 * query before this map ever sees it.
 */
export interface KeyHint {
  readonly key: string;
  readonly label: string;
  /** Status-bar glyph shown instead of `key` when the mockup uses a symbol. */
  readonly glyph?: string;
}

/** The status-bar key map, in display order. */
export const GLOBAL_KEYS: readonly KeyHint[] = [
  { key: "j/k", label: "navigate" },
  { key: "tab", label: "focus" },
  { key: "enter", label: "send", glyph: "⏎" },
  { key: "/", label: "search" },
  { key: "q", label: "quit" },
] as const;

/** App-level actions the shell itself handles. */
export type GlobalAction = "quit" | "focus-next" | "focus-previous" | "search";

/** Minimal shape of a parsed keypress (a subset of OpenTUI's KeyEvent). */
export interface ParsedKeyLike {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift?: boolean;
}

/** Map a parsed keypress to a shell action, or null when the key is inert. */
export function globalAction(key: ParsedKeyLike): GlobalAction | null {
  // Note for panes with a text input (composer edit, search): their key
  // handler must consume printable keys (including "q" and "/") before
  // they reach this global map — by running before it in the shell's
  // key listener.
  if (key.ctrl && key.name === "c") return "quit";
  if (key.name === "q") return "quit";
  if (key.name === "tab") return key.shift === true ? "focus-previous" : "focus-next";
  if (key.name === "/") return "search";
  return null;
}
