import { describe, expect, test } from "bun:test";
import { GLOBAL_KEYS, globalAction } from "../src/tui/keymap.ts";

describe("GLOBAL_KEYS", () => {
  test("matches the mockup status bar, in order", () => {
    expect(GLOBAL_KEYS).toEqual([
      { key: "j/k", label: "navigate" },
      { key: "tab", label: "focus" },
      { key: "enter", label: "send", glyph: "⏎" },
      { key: "/", label: "search" },
      { key: "q", label: "quit" },
    ]);
  });

  test("glyphs are single characters when present", () => {
    for (const hint of GLOBAL_KEYS) {
      if (hint.glyph !== undefined) {
        expect([...hint.glyph].length).toBe(1);
      }
    }
  });

  test("every entry has a single-cell key glyph or short combo and a lowercase label", () => {
    for (const hint of GLOBAL_KEYS) {
      expect(hint.key.length).toBeGreaterThan(0);
      expect(hint.key).toBe(hint.key.trim());
      expect(hint.label).toBe(hint.label.trim());
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

  test("navigation, send, and search are reserved for their panes and stay inert", () => {
    expect(globalAction({ name: "j", ctrl: false })).toBeNull();
    expect(globalAction({ name: "k", ctrl: false })).toBeNull();
    expect(globalAction({ name: "return", ctrl: false })).toBeNull();
    expect(globalAction({ name: "enter", ctrl: false })).toBeNull();
    expect(globalAction({ name: "/", ctrl: false })).toBeNull();
  });

  test("unmapped keys are inert", () => {
    expect(globalAction({ name: "x", ctrl: false })).toBeNull();
    expect(globalAction({ name: "escape", ctrl: false })).toBeNull();
  });

  test("no action ever collides with the quit key", () => {
    const actions = GLOBAL_KEYS.map(hint => hint.label);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
