import { blendHex } from "../motion.ts";
import { BLOOM, FX } from "./palette.ts";

/**
 * The develop effect's timing and look, pure. Content "develops" out of a
 * halftone field the way the provenance hero resolves its image: each cell
 * walks fog → engrave → bloom → refine → resolve on its own local clock u,
 * and rows start roughly top-down with seeded per-cell jitter. The
 * renderable (develop.ts) and developFrame both read these functions, so
 * testing developFrame tests what the screen shows.
 */

export interface Cell {
  readonly char: string;
  readonly fg: string;
}

/** Local-time stage starts, after the provenance hero's layer OFFSETS. */
const ENGRAVE = 0.13;
const BLOOM_AT = 0.34;
const REFINE = 0.6;
const RESOLVE = 0.8;

/** How much of the run the top-to-bottom cascade takes. */
const ROW_SPREAD = 0.35;
/** A slight left-to-right lean inside each row. */
const COL_SLOPE = 0.05;
/** Per-cell random start offset. */
const JITTER = 0.15;
/** Each cell's own run; starts max out at 1 - WINDOW so t=1 lands every cell. */
const WINDOW = 1 - ROW_SPREAD - COL_SLOPE - JITTER;

/** Rows past this share the last start — a long body's hidden tail doesn't slow the visible top. */
const CASCADE_ROWS = 40;

/** Blend weights (bloom → final colour) for the refine and resolve stages. */
export const MIX = [0.4, 0.72] as const;

/** Deterministic noise in [0,1) from a seed and a cell position. */
export function hash01(seed: number, row: number, col: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(row + 1, 0xc2b2ae35), 0x27d4eb2f);
  h = Math.imul(h ^ Math.imul(col + 1, 0x165667b1), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

type Weight = 0 | 1 | 2 | 3;

function classify(char: string): Weight {
  if (char.trim() === "") return 0;
  if (/^[.,:;'"`\-_]$/.test(char)) return 1;
  if (/^[\p{L}\p{N}]/u.test(char)) return 3;
  return 2;
}

/** Printable ASCII weights, precomputed: bodies are mostly ASCII. */
const ASCII_WEIGHTS: readonly Weight[] = Array.from({ length: 128 }, (_, code) => classify(String.fromCharCode(code)));

/** Dot weight for a character: 0 blank, 1 light punctuation, 2 symbols, 3 letters/digits. */
export function weightOf(char: string): Weight {
  if (char.length === 1) {
    const weight = ASCII_WEIGHTS[char.charCodeAt(0)];
    if (weight !== undefined) return weight;
  }
  return classify(char);
}

/** When a cell starts developing, in whole-run time [0, 1 - WINDOW]. */
export function cellStart(
  seed: number,
  row: number,
  col: number,
  cascade: { rows: number; cols: number },
): number {
  const rowFrac = Math.min(1, row / Math.max(1, cascade.rows - 1));
  const colFrac = Math.min(1, col / Math.max(1, cascade.cols - 1));
  return rowFrac * ROW_SPREAD + colFrac * COL_SLOPE + hash01(seed, row, col) * JITTER;
}

/** A cell's local progress u in [0,1] at whole-run time t. */
export function localTime(t: number, start: number): number {
  if (t >= 1) return 1;
  return Math.max(0, Math.min(1, (t - start) / WINDOW));
}

/** What a cell looks like at local time u. */
export type Tone = "fog" | "engrave" | "bloom" | "refine" | "resolve" | "final";

const DOTS = {
  fog: ["", "·", "·", "·"],
  engrave: ["", "·", "∙", "•"],
  bloom: ["", "∙", "•", "●"],
  refine: ["", "·", "∙", "•"],
} as const;

export function toneAt(u: number): Tone {
  if (u >= 1) return "final";
  if (u >= RESOLVE) return "resolve";
  if (u >= REFINE) return "refine";
  if (u >= BLOOM_AT) return "bloom";
  if (u >= ENGRAVE) return "engrave";
  return "fog";
}

/** The glyph a cell shows: a dot sized by the char's weight, or the char itself. */
export function glyphAt(tone: Tone, char: string, weight: number): string {
  if (weight === 0) return char;
  if (tone === "final" || tone === "resolve") return char;
  return DOTS[tone][weight] ?? "·";
}

/** A cell's colour at a tone; `bloom` picks the cell's bloom colour. */
function colorAt(tone: Tone, fg: string, bloom: number): string {
  const petal = BLOOM[bloom % BLOOM.length] ?? FX.accent;
  switch (tone) {
    case "fog":
      return FX.fog;
    case "engrave":
      return FX.dim;
    case "bloom":
      return petal;
    case "refine":
      return blendHex(petal, fg, MIX[0]);
    case "resolve":
      return blendHex(petal, fg, MIX[1]);
    default:
      return fg;
  }
}

/** Which bloom colour a cell passes through. */
export function bloomOf(seed: number, row: number, col: number): number {
  return Math.floor(hash01(seed + 101, row, col) * BLOOM.length);
}

/** The cascade extent for a body: rows capped at CASCADE_ROWS, widest row. */
export function cascadeOf(lines: readonly (readonly Cell[])[]): { rows: number; cols: number } {
  let cols = 1;
  for (const line of lines) cols = Math.max(cols, line.length);
  return { rows: Math.min(lines.length, CASCADE_ROWS), cols };
}

/**
 * The whole body at run time t in [0,1]: t=0 is all fog with spaces kept,
 * t=1 is exactly `lines`. Pure; the renderable draws the same thing.
 */
export function developFrame(lines: readonly (readonly Cell[])[], t: number, seed = 0): Cell[][] {
  const cascade = cascadeOf(lines);
  return lines.map((line, row) =>
    line.map((cell, col) => {
      const u = localTime(t, cellStart(seed, row, col, cascade));
      const tone = toneAt(u);
      const weight = weightOf(cell.char);
      // Blanks stay blank from the first frame, so the text's shape reads at once.
      if (tone === "final" || weight === 0) return { char: cell.char, fg: cell.fg };
      return {
        char: glyphAt(tone, cell.char, weight),
        fg: colorAt(tone, cell.fg, bloomOf(seed, row, col)),
      };
    }),
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Coloured spans per line → develop cells, one per grapheme. With `wrap`,
 * lines longer than that many columns continue on the next row (the way a
 * wrapping code block lays them out), so the reveal and the settled view
 * agree on where every character sits.
 */
export function cellsFromSpans(
  lines: readonly (readonly { readonly text: string; readonly fg: string }[])[],
  opts: { readonly wrap?: number } = {},
): Cell[][] {
  const limit = opts.wrap !== undefined && opts.wrap > 0 ? opts.wrap : Number.POSITIVE_INFINITY;
  const out: Cell[][] = [];
  for (const spans of lines) {
    let row: Cell[] = [];
    let used = 0;
    for (const span of spans) {
      for (const { segment } of graphemes.segment(span.text)) {
        const width = Bun.stringWidth(segment);
        if (used + width > limit && row.length > 0) {
          out.push(row);
          row = [];
          used = 0;
        }
        row.push({ char: segment, fg: span.fg });
        used += width;
      }
    }
    out.push(row);
  }
  return out;
}
