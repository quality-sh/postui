import { RGBA } from "@opentui/core";
import type { JsonTokenKind } from "./json-highlight.ts";

/**
 * Color roles, all #rrggbb (OpenTUI accepts hex strings for every color
 * option: fg, bg, borderColor, focusedBorderColor, titleColor).
 */
const COLOR = {
  /** App background, behind the panes and under the status bar. */
  bg: "#100f17",
  /** Pane interiors: one step up from bg. */
  panel: "#15131e",
  /** Inputs, pills, the code gutter: one step up from panel. */
  element: "#1d1a28",
  /** Mouse hover on rows and pills. */
  elementHover: "#252134",
  /** Pane frames at rest, rules, tree guides. */
  border: "#2a2738",
  /** Secondary emphasis on frames (hover, a dialog's inner edge). */
  borderActive: "#45405a",
  /** Body text: names, values, the query, fix-it commands. */
  text: "#e0def4",
  /** Labels, hint text, secondary info. */
  muted: "#908caa",
  /** De-emphasised decoration and placeholders: the halftone dots, gutters. */
  dim: "#6e6a86",
  /** The halftone fog stage and skeletons. */
  fog: "#3e3a52",
  /** THE accent (iris): focus, selection bar, wordmark, cursor, primary buttons. */
  accent: "#c4a7e7",
  /** Selected-row and focused-control fill under the accent. */
  accentSoft: "#2a2440",
  /** JSON strings, warnings. */
  gold: "#f6c177",
  /** Success (2xx), JSON literals, GET. */
  foam: "#9ccfd8",
  /** PUT/PATCH, warm secondary. */
  rose: "#ebbcba",
  /** Errors, 4xx/5xx, DELETE — nothing else. */
  love: "#eb6f92",
} as const;

/**
 * POSTUI TUI palette — the single source of color truth for the TUI.
 *
 * Rosé Pine derived (design/feel-spec.md §1): a violet-black ground in
 * three steps (bg, panel, element), lavender text in three strengths
 * (text, muted, dim), and ONE accent — iris — for everything that says
 * "you are here": focus, the selection bar, the wordmark, the cursor, the
 * primary button. Red (`love`) means an error, a 4xx/5xx, or DELETE, and
 * nothing else. No other TUI module may hardcode a color; import tokens
 * from here.
 */
export const THEME = {
  color: COLOR,
  /**
   * The bloom palette: the colors a halftone "develop" passes through, and
   * the wordmark's letters. Rosé Pine's warm set plus the accent.
   */
  bloom: ["#eb6f92", "#c4a56a", "#908caa", "#ea9a97", "#935e6d", COLOR.accent],
} as const;

/** The dim veil laid over the app behind a dialog (opencode's ui/dialog.tsx). */
export const SCRIM = RGBA.fromInts(0, 0, 0, 150);

/**
 * Method badge colors: GET foam, POST gold, PUT/PATCH rose, DELETE love,
 * HEAD/OPTIONS muted. Keys are uppercase.
 */
const METHOD_COLORS: Readonly<Record<string, string>> = {
  GET: THEME.color.foam,
  POST: THEME.color.gold,
  PUT: THEME.color.rose,
  PATCH: THEME.color.rose,
  DELETE: THEME.color.love,
  HEAD: THEME.color.muted,
  OPTIONS: THEME.color.muted,
};

/**
 * The badge color of a method. Case-insensitive, because hand-edited
 * modules may hold lowercase methods; an unknown method reads as muted.
 */
export function methodColor(method: string): string {
  return METHOD_COLORS[method.toUpperCase()] ?? THEME.color.muted;
}

/**
 * JSON token kinds to color roles (json-highlight.ts spans carry kinds,
 * never colors): keys in the body text, strings gold, literals foam — so a
 * number never reads as a string — and punctuation dim.
 */
export const JSON_COLORS: Record<JsonTokenKind, string> = {
  punctuation: THEME.color.dim,
  key: THEME.color.text,
  string: THEME.color.gold,
  number: THEME.color.foam,
  boolean: THEME.color.foam,
  null: THEME.color.foam,
  plain: THEME.color.text,
};
