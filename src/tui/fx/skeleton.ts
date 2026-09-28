import { RGBA, Renderable } from "@opentui/core";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { fxClock, type Cancel, type FxClock } from "./clock.ts";
import { hash01 } from "./develop-frame.ts";
import { FX, mixRgba, rgba } from "./palette.ts";

/**
 * Skeleton rows for loading states: fog-coloured halftone dots in the shape
 * of text lines, with a brighter band of larger dots drifting across them
 * on a slant — a shimmer, drawn in dots. Stops cleanly: `stop()` freezes the
 * field with no band (the static fallback tests and headless runs see).
 */

const FRAME_MS = 60;
const CLEAR = RGBA.fromValues(0, 0, 0, 0);
/** One band pass, left edge to right edge, in ms. */
const SWEEP_MS = 1600;
/** Band half-width in cells. */
const BAND = 6;
/** Default line lengths as fractions of the width — reads as prose/JSON. */
const DEFAULT_WIDTHS = [0.92, 0.64, 0.78, 0.46, 0.85, 0.58];

export interface SkeletonOptions {
  readonly lines: number;
  readonly width: number | "100%";
  /** Line lengths as fractions (0–1] of the width, cycled. */
  readonly widths?: readonly number[];
  readonly clock?: FxClock;
  readonly id?: string;
}

/** One skeleton cell: its glyph and a 0–2 brightness level. */
export function skeletonCell(
  row: number,
  col: number,
  bandCenter: number | null,
): { char: string; level: 0 | 1 | 2 } {
  const noise = hash01(7, row, col);
  const base = noise < 0.28 ? "∙" : "·";
  if (bandCenter === null) return { char: base, level: 0 };
  // The band leans right as it goes down, like light across a page.
  const near = 1 - Math.abs(col - (bandCenter + row * 1.5)) / BAND;
  if (near > 0.55) return { char: noise < 0.5 ? "•" : "∙", level: 2 };
  if (near > 0) return { char: base === "·" ? "∙" : "•", level: 1 };
  return { char: base, level: 0 };
}

class SkeletonLines extends Renderable {
  private readonly clock: FxClock;
  private readonly widths: readonly number[];
  private readonly rows: number;
  private readonly started: number;
  private cancel: Cancel | null = null;

  constructor(ctx: RenderContext, opts: SkeletonOptions) {
    const rows = Math.max(1, Math.round(opts.lines));
    super(ctx, { id: opts.id, width: opts.width, height: rows, flexShrink: 0 });
    this.rows = rows;
    this.widths = opts.widths !== undefined && opts.widths.length > 0 ? opts.widths : DEFAULT_WIDTHS;
    this.clock = opts.clock ?? fxClock();
    this.started = this.clock.now();
    if (!this.clock.instant) {
      this.cancel = this.clock.every(FRAME_MS, () => this.requestRender());
    }
  }

  /** The band's leading column now, or null when stopped. */
  private bandCenter(): number | null {
    if (this.cancel === null) return null;
    const travel = this.width + BAND * 2 + this.rows * 1.5;
    const phase = ((this.clock.now() - this.started) % SWEEP_MS) / SWEEP_MS;
    return phase * travel - BAND - this.rows * 1.5;
  }

  /** Freeze the field without the band. Idempotent. */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.isDestroyed) this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible) return;
    const band = this.bandCenter();
    const colors = [rgba(FX.fog), mixRgba(FX.fog, FX.dim, 0.5), rgba(FX.dim)] as const;
    const left = this.x;
    const top = this.y;
    for (let row = 0; row < this.rows; row += 1) {
      const fraction = this.widths[row % this.widths.length] ?? 1;
      const length = Math.max(1, Math.round(Math.min(1, fraction) * this.width));
      for (let col = 0; col < length; col += 1) {
        const cell = skeletonCell(row, col, band);
        // drawChar: a codepoint costs nothing to encode, unlike a non-ASCII drawText.
        buffer.drawChar(cell.char.codePointAt(0) ?? 0xb7, left + col, top + row, colors[cell.level], CLEAR);
      }
    }
  }

  protected override destroySelf(): void {
    this.cancel?.();
    this.cancel = null;
    super.destroySelf();
  }
}

/** Placeholder text rows that shimmer until `stop()` or destroy. */
export function skeletonLines(
  renderer: RenderContext,
  opts: SkeletonOptions,
): Renderable & { stop(): void } {
  return new SkeletonLines(renderer, opts);
}
