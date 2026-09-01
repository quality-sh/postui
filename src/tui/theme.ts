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
    /** Primary accent: the pink/red of the POSTUI wordmark, env badge, and focused-pane border. */
    accent: "#f43f5e",
    /** Muted lavender body text. */
    text: "#a9a3c4",
    /** Gold: response highlights; reserved for response content from the composer ticket on. */
    gold: "#d4a24e",
    /** Pane borders at rest. */
    border: "#35323f",
    /** Emphasized text: key glyphs in the status bar, pane titles. */
    bright: "#e6e2f0",
    /** De-emphasized decoration: hints, the halftone dots. */
    dim: "#5c5770",
  },
} as const;
