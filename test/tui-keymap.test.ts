import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KEY_HINTS,
  PANE_KEY_HINTS,
  globalAction,
  hintsFor,
} from "../src/tui/keymap.ts";
import type { KeyHint } from "../src/tui/keymap.ts";
import { COLLECTIONS_PANE_ID, COMPOSER_PANE_ID, RESPONSE_PANE_ID } from "../src/tui/shell.ts";

/** A hint set as the status bar prints it: glyph (or key), space, label. */
const shown = (hints: readonly KeyHint[]): string[] =>
  hints.map(hint => `${hint.glyph ?? hint.key} ${hint.label}`);

describe("PANE_KEY_HINTS", () => {
  test("collections advertises arrows and one-step send, in order", () => {
    expect(shown(hintsFor(COLLECTIONS_PANE_ID))).toEqual([
      "↑↓ select",
      "⏎ send",
      "tab focus",
      "/ search",
      "q quit",
    ]);
  });

  test("the composer advertises typing, tabs, send, save and the way out", () => {
    expect(shown(hintsFor(COMPOSER_PANE_ID))).toEqual([
      "type to edit",
      "←→ tabs",
      "⏎ send",
      "^s save",
      "esc leave field",
    ]);
  });

  test("the response pane advertises scrolling, tabs and the honest +/- re-send", () => {
    expect(shown(hintsFor(RESPONSE_PANE_ID))).toEqual([
      "↑↓ scroll",
      "←→ tabs",
      "+/- resend ±body",
      "tab focus",
      "q quit",
    ]);
  });

  test("every pane id the shell registers has a hint set", () => {
    for (const id of [COLLECTIONS_PANE_ID, COMPOSER_PANE_ID, RESPONSE_PANE_ID]) {
      expect(PANE_KEY_HINTS[id]).toBeDefined();
    }
  });

  test("unknown or no focus falls back to the default set", () => {
    expect(hintsFor(null)).toBe(DEFAULT_KEY_HINTS);
    expect(hintsFor("test-probe")).toBe(DEFAULT_KEY_HINTS);
  });

  test("j/k/h/l stay silent aliases: never advertised", () => {
    for (const hints of Object.values(PANE_KEY_HINTS)) {
      for (const hint of hints) {
        expect(hint.key).not.toMatch(/^[hjkl](\/[hjkl])?$/);
      }
    }
  });

  test("every entry has a trimmed key and label, and labels are unique per pane", () => {
    for (const hints of Object.values(PANE_KEY_HINTS)) {
      for (const hint of hints) {
        expect(hint.key.length).toBeGreaterThan(0);
        expect(hint.key).toBe(hint.key.trim());
        expect(hint.label).toBe(hint.label.trim());
      }
      const labels = hints.map(hint => hint.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("globalAction", () => {
  test("q quits and tab moves focus", () => {
    expect(globalAction({ name: "q", ctrl: false })).toBe("quit");
    expect(globalAction({ name: "tab", ctrl: false })).toBe("focus-next");
  });

  test("shift+tab moves focus backward", () => {
    expect(globalAction({ name: "tab", shift: true, ctrl: false })).toBe("focus-previous");
  });

  test("ctrl+c quits", () => {
    expect(globalAction({ name: "c", ctrl: true })).toBe("quit");
  });

  test("navigation and send are reserved for their panes and stay inert", () => {
    for (const name of ["j", "k", "up", "down", "left", "right", "return", "enter"]) {
      expect(globalAction({ name, ctrl: false })).toBeNull();
    }
  });

  test("/ opens the search palette at shell level", () => {
    expect(globalAction({ name: "/", ctrl: false })).toBe("search");
  });

  test("unmapped keys are inert", () => {
    expect(globalAction({ name: "x", ctrl: false })).toBeNull();
    expect(globalAction({ name: "escape", ctrl: false })).toBeNull();
  });

  test("with a text field focused, q and / type instead of acting", () => {
    const context = { textFocused: true };
    expect(globalAction({ name: "q", ctrl: false }, context)).toBeNull();
    expect(globalAction({ name: "/", ctrl: false }, context)).toBeNull();
    // ctrl+c always quits; tab still moves focus
    expect(globalAction({ name: "c", ctrl: true }, context)).toBe("quit");
    expect(globalAction({ name: "tab", ctrl: false }, context)).toBe("focus-next");
  });
});
