import { RGBA, Renderable } from "@opentui/core";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { fxClock, type Cancel, type FxClock } from "./clock.ts";
import { FX, rgba } from "./palette.ts";

/**
 * The halftone spinner: a dot that swells through a density ramp as it
 * travels back and forth across 3–5 cells, its colour rising fog → muted →
 * accent at the head. One Renderable, one timer, cells drawn straight into
 * the buffer; the timer asks for a repaint and the frame is derived from
 * the clock, so a late tick never skips or stutters the pattern.
 */

const FRAME_MS = 80;
const CLEAR = RGBA.fromValues(0, 0, 0, 0);
const RAMPS = {
  dots: ["·", "∙", "•", "●"],
  braille: ["⠁", "⠃", "⠇", "⡇", "⣇", "⣧", "⣷", "⣿"],
} as const;

export type SpinnerGlyphs = keyof typeof RAMPS;

export interface SpinnerCell {
  readonly char: string;
  readonly fg: string;
}

/** Cell intensity in [0,1]: 1 at the head, falling off over two cells. */
function intensity(frame: number, col: number, width: number): number {
  const span = Math.max(1, width - 1);
  // The head moves half a cell per frame and ping-pongs across the cells.
  const period = span * 4;
  const step = ((frame % period) + period) % period;
  const head = step <= span * 2 ? step / 2 : (period - step) / 2;
  return Math.max(0, 1 - Math.abs(col - head) / 2);
}

/** One spinner frame as cells — pure, so tests can pin the pattern. */
export function spinnerFrame(
  frame: number,
  width: number,
  opts: { color?: string; glyphs?: SpinnerGlyphs } = {},
): SpinnerCell[] {
  const ramp = RAMPS[opts.glyphs ?? "dots"];
  const head = opts.color ?? FX.accent;
  return Array.from({ length: width }, (_, col) => {
    const level = intensity(frame, col, width);
    const char = ramp[Math.round(level * (ramp.length - 1))] ?? ramp[0];
    let fg: string = FX.fog;
    if (level >= 0.8) fg = head;
    else if (level >= 0.4) fg = FX.muted;
    return { char, fg };
  });
}

export interface SpinnerOptions {
  /** Cells wide, 3–5 reads best (default 4). */
  readonly width?: number;
  /** Head colour (default accent). */
  readonly color?: string;
  readonly glyphs?: SpinnerGlyphs;
  readonly clock?: FxClock;
  readonly id?: string;
}

class HalftoneSpinner extends Renderable {
  private readonly clock: FxClock;
  private readonly cells: number;
  private readonly color: string | undefined;
  private readonly glyphs: SpinnerGlyphs;
  private readonly started: number;
  private cancel: Cancel | null = null;

  constructor(ctx: RenderContext, opts: SpinnerOptions) {
    const width = Math.max(1, Math.round(opts.width ?? 4));
    super(ctx, { id: opts.id, width, height: 1, flexShrink: 0 });
    this.cells = width;
    this.color = opts.color;
    this.glyphs = opts.glyphs ?? "dots";
    this.clock = opts.clock ?? fxClock();
    this.started = this.clock.now();
    if (!this.clock.instant) {
      this.cancel = this.clock.every(FRAME_MS, () => this.requestRender());
    }
  }

  /** The frame on screen now; 0 (the static fallback) once stopped. */
  get frame(): number {
    if (this.cancel === null) return 0;
    return Math.floor((this.clock.now() - this.started) / FRAME_MS);
  }

  /** Stop ticking and settle on the static frame. Idempotent. */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.isDestroyed) this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible) return;
    const cells = spinnerFrame(this.frame, this.cells, { color: this.color, glyphs: this.glyphs });
    const left = this.x;
    const top = this.y;
    for (const [col, cell] of cells.entries()) {
      buffer.drawChar(cell.char.codePointAt(0) ?? 0xb7, left + col, top, rgba(cell.fg), CLEAR);
    }
  }

  protected override destroySelf(): void {
    this.cancel?.();
    this.cancel = null;
    super.destroySelf();
  }
}

/** A 1-row halftone pulse; `stop()` (or destroy) clears its timer. */
export function halftoneSpinner(
  renderer: RenderContext,
  opts: SpinnerOptions = {},
): Renderable & { stop(): void; readonly frame: number } {
  return new HalftoneSpinner(renderer, opts);
}
