import { RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";

/** Cell-level reads of a captured frame, for tests that watch fills change. */

/** Row index and column of the first `needle` on screen. */
export function locate(setup: TestRendererSetup, needle: string): { row: number; col: number } {
  const rows = setup.captureCharFrame().split("\n");
  const row = rows.findIndex(line => line.includes(needle));
  if (row === -1) throw new Error(`"${needle}" is not on screen`);
  return { row, col: (rows[row] ?? "").indexOf(needle) };
}

/** The background colour of the cell at (row, col). */
export function bgAt(setup: TestRendererSetup, row: number, col: number): RGBA | null {
  let x = 0;
  for (const span of setup.captureSpans().lines[row]?.spans ?? []) {
    const width = Bun.stringWidth(span.text);
    if (col < x + width) return span.bg;
    x += width;
  }
  return null;
}

/** True when `color` is exactly the theme colour `hex`. */
export const is = (color: RGBA | null | undefined, hex: string): boolean => color?.equals(RGBA.fromHex(hex)) ?? false;
