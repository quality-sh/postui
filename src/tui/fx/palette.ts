import { RGBA } from "@opentui/core";
import { blendHex } from "../motion.ts";
import { THEME } from "../theme.ts";

/** The fx module's colours: views onto THEME, the one source of colour truth. */
export const FX = THEME.color;

/** The develop effect's bloom colours (provenance hero, Rosé Pine) plus the accent. */
export const BLOOM: readonly string[] = THEME.bloom;

const cache = new Map<string, RGBA>();

/**
 * Hex → RGBA, cached: effects repaint every frame and must not allocate a
 * colour object per cell per frame.
 */
export function rgba(hex: string): RGBA {
  let color = cache.get(hex);
  if (color === undefined) {
    color = RGBA.fromHex(hex);
    cache.set(hex, color);
  }
  return color;
}

/** A fixed blend step between two hex colours, as a cached RGBA. */
export function mixRgba(a: string, b: string, t: number): RGBA {
  return rgba(blendHex(a, b, t));
}
