import type { JsonTokenKind } from "./json-highlight.ts";

/**
 * POSTUI TUI palette — the single source of color truth for the TUI.
 *
 * Tokens mirror design/postui-opentui-concept.png: near-black background,
 * pink/red primary accent (wordmark, focus treatment), muted lavender text,
 * gold for response highlights. No other TUI module may hardcode a color;
 * import tokens from here.
 */
export const THEME = {
  /**
   * Color roles, all #rrggbb (OpenTUI accepts hex strings for every color
   * option: fg, bg, borderColor, focusedBorderColor, titleColor).
   */
  color: {
    /** App background: near-black with a faint violet cast. */
    bg: "#0b0b10",
    /**
     * Primary accent: the pink/red of the POSTUI wordmark, env badge,
     * focused-pane border, selection bar, mutating method badges, the error
     * ✗ marker, and the search prompt.
     */
    accent: "#f43f5e",
    /** Muted lavender body text. */
    text: "#a9a3c4",
    /** Gold: response highlights; reserved for response content from the composer ticket on. */
    gold: "#d4a24e",
    /** Pane borders at rest and status-bar cell separators. */
    border: "#35323f",
    /** Emphasized text: key glyphs, pane titles, the query text, fix-it commands. */
    bright: "#e6e2f0",
    /** De-emphasized decoration: hints, the halftone dots. */
    dim: "#5c5770",
    /** Muted green: safe (read-only) method badges — the mockup's GET. */
    safe: "#7dbb8e",
    /** Soft cyan: JSON numbers, booleans, and null — distinct from strings and keys. */
    literal: "#6fb3c8",
    /** JSON punctuation: a step dimmer than body text, a step brighter than `dim`. */
    punct: "#7a7590",
  },
} as const;

/**
 * JSON token kinds to color roles (json-highlight.ts spans carry kinds,
 * never colors). Per the mockup's response body: string values gold, keys
 * in the body text color, punctuation dimmer, and literals in their own
 * color so a number never reads as a string.
 */
export const JSON_COLORS: Record<JsonTokenKind, string> = {
  punctuation: THEME.color.punct,
  key: THEME.color.text,
  string: THEME.color.gold,
  number: THEME.color.literal,
  boolean: THEME.color.literal,
  null: THEME.color.literal,
  plain: THEME.color.text,
};
