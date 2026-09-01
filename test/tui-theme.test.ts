import { describe, expect, test } from "bun:test";
import { THEME } from "../src/tui/theme.ts";

/** Every token is a #rrggbb hex string — OpenTUI takes these everywhere. */
function isHex(color: string): boolean {
  return /^#[0-9a-f]{6}$/.test(color);
}

describe("THEME", () => {
  test("every color token is a 6-digit hex string", () => {
    for (const [name, color] of Object.entries(THEME.color)) {
      expect(isHex(color), `token ${name} should be #rrggbb`).toBe(true);
    }
  });

  test("palette matches the mockup: near-black bg, pink/red accent, lavender text, gold highlight", () => {
    expect(THEME.color.bg).toBe("#0b0b10");
    expect(THEME.color.accent).toBe("#f43f5e");
    expect(THEME.color.text).toBe("#a9a3c4");
    expect(THEME.color.gold).toBe("#d4a24e");
  });

  test("supporting tokens exist for borders, bright text, and dimmed decoration", () => {
    expect(THEME.color.border).toBe("#35323f");
    expect(THEME.color.bright).toBe("#e6e2f0");
    expect(THEME.color.dim).toBe("#5c5770");
  });

  test("color roles are distinct so states remain visually separable", () => {
    const values = Object.values(THEME.color);
    expect(new Set(values).size).toBe(values.length);
  });
});
