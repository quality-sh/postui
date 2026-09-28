import { RGBA } from "@opentui/core";
import { blendHex } from "../motion.ts";

/**
 * The fx module's colours, straight from design/feel-spec.md §1. They live
 * here only while theme.ts is being rewritten to the same palette; at merge
 * they fold into THEME and this file reads from there.
 */
export const FX = {
  bg: "#100f17",
  panel: "#15131e",
  element: "#1d1a28",
  text: "#e0def4",
  muted: "#908caa",
  dim: "#6e6a86",
  fog: "#3e3a52",
  accent: "#c4a7e7",
  love: "#eb6f92",
  foam: "#9ccfd8",
  gold: "#f6c177",
} as const;

/** The develop effect's bloom colours (provenance hero, Rosé Pine) plus the accent. */
export const BLOOM: readonly string[] = [
  "#eb6f92",
  "#c4a56a",
  "#908caa",
  "#ea9a97",
  "#935e6d",
  FX.accent,
];

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
