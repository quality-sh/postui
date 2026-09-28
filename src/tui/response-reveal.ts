import { TextRenderable, rgbToHex } from "@opentui/core";
import type { CliRenderer, Renderable } from "@opentui/core";
import { cellsFromSpans, developLines } from "./fx/develop.ts";

/**
 * The reveal for the response pane's short views (headers, the tests
 * listing, notes and diagnostics): every text renderable under the given
 * nodes is swapped, in place, for a develop effect of the same characters
 * and colours, so the view comes out of halftone fog instead of popping in.
 * A settled develop draws cell for cell the text it replaced, so it stays
 * put; the pane's next render builds plain text again.
 */

export interface RevealOptions {
  /** Develop seed: the send number, so a repeat send develops differently. */
  readonly seed: number;
  /** Columns to wrap at (the pane's text width). */
  readonly width: number;
}

/** Split a text's chunks into lines of coloured spans. */
function spanLines(text: TextRenderable): { text: string; fg: string }[][] {
  const fallback = rgbToHex(text.fg);
  const lines: { text: string; fg: string }[][] = [[]];
  for (const chunk of text.chunks) {
    const color = chunk.fg === undefined ? fallback : rgbToHex(chunk.fg);
    chunk.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines.at(-1)?.push({ text: part, fg: color });
    });
  }
  return lines;
}

function textsUnder(node: Renderable, found: TextRenderable[]): void {
  if (node instanceof TextRenderable) {
    found.push(node);
    return;
  }
  for (const child of node.getChildren()) textsUnder(child as Renderable, found);
}

/** Develop every text under `nodes` (already attached to the pane). */
export function developTexts(renderer: CliRenderer, nodes: readonly Renderable[], opts: RevealOptions): void {
  const texts: TextRenderable[] = [];
  for (const node of nodes) textsUnder(node, texts);
  for (const [index, text] of texts.entries()) {
    const parent = text.parent;
    if (parent === null || text.plainText.trim() === "") continue;
    const cells = cellsFromSpans(spanLines(text), { wrap: Math.max(1, opts.width) });
    const at = parent.getChildren().indexOf(text);
    const develop = developLines(renderer, cells, { seed: opts.seed * 31 + index });
    text.destroyRecursively();
    parent.add(develop, at);
  }
}
