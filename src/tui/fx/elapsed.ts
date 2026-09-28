import { RGBA, Renderable } from "@opentui/core";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { fxClock, type Cancel, type FxClock } from "./clock.ts";
import { FX, rgba } from "./palette.ts";

/**
 * A live elapsed-time readout ("184 ms", then "12.3 s"): the busy header's
 * proof that the wait is being counted. Like the spinner it is one
 * Renderable on one timer that only asks for a repaint; the number is read
 * from the clock at draw time. Fixed width, right-aligned, so the text
 * beside it never shifts as digits are added.
 */

const FRAME_MS = 40;
const WIDTH = 8;
const CLEAR = RGBA.fromValues(0, 0, 0, 0);

/** The readout for `ms` elapsed: whole ms under 10 s, tenths of a second after. */
export function elapsedLabel(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  if (whole < 10_000) return `${whole} ms`;
  return `${(whole / 1000).toFixed(1)} s`;
}

export interface ElapsedOptions {
  /** Clock time the count starts from (default: now). */
  readonly since?: number;
  readonly color?: string;
  readonly clock?: FxClock;
  readonly id?: string;
}

class ElapsedCounter extends Renderable {
  private readonly clock: FxClock;
  private readonly since: number;
  private readonly color: RGBA;
  private stoppedAt: number | null = null;
  private cancel: Cancel | null = null;

  constructor(ctx: RenderContext, opts: ElapsedOptions) {
    super(ctx, { id: opts.id, width: WIDTH, height: 1, flexShrink: 0 });
    this.clock = opts.clock ?? fxClock();
    this.since = opts.since ?? this.clock.now();
    this.color = rgba(opts.color ?? FX.muted);
    if (!this.clock.instant) {
      this.cancel = this.clock.every(FRAME_MS, () => this.requestRender());
    }
  }

  /** Milliseconds shown now (frozen once stopped). */
  get elapsed(): number {
    return (this.stoppedAt ?? this.clock.now()) - this.since;
  }

  /** Freeze the count where it is. Idempotent. */
  stop(): void {
    if (this.stoppedAt === null) this.stoppedAt = this.clock.now();
    this.cancel?.();
    this.cancel = null;
    if (!this.isDestroyed) this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible) return;
    const text = elapsedLabel(this.elapsed).padStart(WIDTH);
    buffer.drawText(text, this.x, this.y, this.color, CLEAR);
  }

  protected override destroySelf(): void {
    this.cancel?.();
    this.cancel = null;
    super.destroySelf();
  }
}

/** A 1-row elapsed-ms counter that ticks on the fx clock until stopped or destroyed. */
export function elapsedCounter(
  renderer: RenderContext,
  opts: ElapsedOptions = {},
): Renderable & { stop(): void; readonly elapsed: number } {
  return new ElapsedCounter(renderer, opts);
}
