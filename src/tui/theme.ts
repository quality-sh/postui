import { RGBA } from "@opentui/core";
import type { JsonTokenKind } from "./json-highlight.ts";

/**
 * Color roles, all #rrggbb (OpenTUI accepts hex strings for every color
 * option: fg, bg, borderColor, focusedBorderColor, titleColor).
 */
const COLOR = {
  /** App background, behind the panes and under the status bar: aether black. */
  bg: "#000000",
  /** Pane interiors: a hair above black — aether separates with grey lines, not tints. */
  panel: "#0a0a0a",
  /** Inputs, pills, the code gutter (aether's surface). */
  element: "#1a1a1a",
  /** Mouse hover on rows and pills. */
  elementHover: "#242424",
  /** Pane frames at rest, rules, tree guides (aether's border grey). */
  border: "#525252",
  /** Secondary emphasis on frames (hover, a dialog's inner edge). */
  borderActive: "#908caa",
  /** Body text: names, values, the query, fix-it commands. */
  text: "#b9b9b9",
  /** Labels, hint text, secondary info. */
  muted: "#8b8b8b",
  /** De-emphasised decoration and placeholders: the halftone dots, gutters. */
  dim: "#6e6a86",
  /** The halftone fog stage and skeletons. */
  fog: "#2e2e2e",
  /** THE accent (light grey): focus, selection bar, cursor, primary buttons. */
  accent: "#cbcbcb",
  /** Selected-row and focused-control fill under the accent. */
  accentSoft: "#262626",
  /** JSON strings, warnings. */
  gold: "#f6c177",
  /** Success (2xx), GET. */
  sage: "#8fa77a",
  /** Info: JSON literals, links. */
  iris: "#c4a7e7",
  /** PUT/PATCH, the wordmark's warm end. */
  rose: "#ebbcba",
  /** Errors, 4xx/5xx, DELETE — nothing else. */
  love: "#eb6f92",
} as const;

/**
 * POSTUI TUI palette — the single source of color truth for the TUI.
 *
 * aether-rose (the owner's Omarchy desktop theme; see
 * ~/.config/opencode/themes/aether-rose.json and design/feel-spec.md §1):
 * a black ground, grey chrome and grey text, and ONE light-grey accent for
 * everything that says "you are here". Rosé Pine colors appear only where
 * they carry meaning: love = an error, a 4xx/5xx, or DELETE; gold = JSON
 * strings and warnings; sage = success and GET; iris = info and JSON
 * literals. No other TUI module may hardcode a color; import tokens from
 * here.
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
 * Method badge colors: GET sage, POST gold, PUT/PATCH rose, DELETE love,
 * HEAD/OPTIONS muted. Keys are uppercase.
 */
const METHOD_COLORS: Readonly<Record<string, string>> = {
  GET: THEME.color.sage,
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
 * never colors): keys in the body text, strings gold, literals iris — so a
 * number never reads as a string — and punctuation dim.
 */
export const JSON_COLORS: Record<JsonTokenKind, string> = {
  punctuation: THEME.color.dim,
  key: THEME.color.text,
  string: THEME.color.gold,
  number: THEME.color.iris,
  boolean: THEME.color.iris,
  null: THEME.color.iris,
  plain: THEME.color.text,
};
