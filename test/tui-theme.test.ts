import { describe, expect, test } from "bun:test";
import { JSON_COLORS, SCRIM, THEME, methodColor } from "../src/tui/theme.ts";

/** Every token is a #rrggbb hex string — OpenTUI takes these everywhere. */
function isHex(color: string): boolean {
  return /^#[0-9a-f]{6}$/.test(color);
}

describe("THEME", () => {
  test("every color token is a 6-digit hex string", () => {
    for (const [name, color] of Object.entries(THEME.color)) {
      expect(isHex(color), `token ${name} should be #rrggbb`).toBe(true);
    }
    for (const color of THEME.bloom) expect(isHex(color)).toBe(true);
  });

  test("palette follows aether-rose: black ground, grey chrome and accent, love for errors", () => {
    expect(THEME.color.bg).toBe("#000000");
    expect(THEME.color.element).toBe("#1a1a1a");
    expect(THEME.color.border).toBe("#525252");
    expect(THEME.color.text).toBe("#b9b9b9");
    expect(THEME.color.accent).toBe("#cbcbcb");
    expect(THEME.color.love).toBe("#eb6f92");
    expect(THEME.color.sage).toBe("#8fa77a");
    expect(THEME.color.iris).toBe("#c4a7e7");
  });

  test("the accent is not a red: love is the only token in the error color", () => {
    const reds = Object.entries(THEME.color).filter(([, color]) => color === THEME.color.love);
    expect(reds.map(([name]) => name)).toEqual(["love"]);
    expect(THEME.color.accent).not.toBe(THEME.color.love);
  });

  test("the bloom palette ends on the accent", () => {
    expect(THEME.bloom.at(-1)).toBe(THEME.color.accent);
  });

  test("color roles are distinct so states remain visually separable", () => {
    const values = Object.values(THEME.color);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("methodColor", () => {
  test("GET sage, POST gold, PUT/PATCH rose, DELETE love, HEAD/OPTIONS muted", () => {
    expect(methodColor("GET")).toBe(THEME.color.sage);
    expect(methodColor("POST")).toBe(THEME.color.gold);
    expect(methodColor("PUT")).toBe(THEME.color.rose);
    expect(methodColor("PATCH")).toBe(THEME.color.rose);
    expect(methodColor("DELETE")).toBe(THEME.color.love);
    expect(methodColor("HEAD")).toBe(THEME.color.muted);
    expect(methodColor("OPTIONS")).toBe(THEME.color.muted);
  });

  test("case-insensitive, and an unknown method reads as muted", () => {
    expect(methodColor("delete")).toBe(THEME.color.love);
    expect(methodColor("PROPFIND")).toBe(THEME.color.muted);
  });
});

describe("JSON_COLORS", () => {
  test("keys in text, strings gold, literals iris, punctuation dim", () => {
    expect(JSON_COLORS.key).toBe(THEME.color.text);
    expect(JSON_COLORS.string).toBe(THEME.color.gold);
    expect(JSON_COLORS.number).toBe(THEME.color.iris);
    expect(JSON_COLORS.boolean).toBe(THEME.color.iris);
    expect(JSON_COLORS.null).toBe(THEME.color.iris);
    expect(JSON_COLORS.punctuation).toBe(THEME.color.dim);
  });
});

describe("SCRIM", () => {
  test("is translucent black, like opencode's dialog backdrop", () => {
    expect(SCRIM.toInts()).toEqual([0, 0, 0, 150]);
  });
});
