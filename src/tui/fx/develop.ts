import { RGBA, Renderable } from "@opentui/core";
import type { OptimizedBuffer, RenderContext } from "@opentui/core";
import { fxClock, type Cancel, type FxClock } from "./clock.ts";
import {
  bloomOf,
  cascadeOf,
  cellStart,
  glyphAt,
  localTime,
  MIX,
  toneAt,
  weightOf,
  type Cell,
  type Tone,
} from "./develop-frame.ts";
import { BLOOM, FX, mixRgba, rgba } from "./palette.ts";

export type { Cell } from "./develop-frame.ts";
export { cellsFromSpans, developFrame } from "./develop-frame.ts";

/**
 * The develop reveal as one Renderable: every cell is drawn straight into
 * the buffer in renderSelf (no per-cell renderables) and per-cell timing is
 * precomputed once. Cells draw with drawChar (a codepoint, no string
 * encoding — drawText of a non-ASCII string costs ~25 µs a call); settled
 * rows draw ASCII stretches as one drawText. Once finished it draws exactly
 * the input chars and colours — cell for cell the same as plain text, so
 * callers may leave it in place or swap it out.
 */

const FRAME_MS = 16;
const CLEAR = RGBA.fromValues(0, 0, 0, 0);
const FOG_DOT = 0xb7; // ·

/** A settled stretch: ASCII text drawn at once, or one cell by codepoint. */
interface Run {
  readonly x: number;
  readonly text: string;
  /** Codepoint for a single non-ASCII cell; -1 means drawText(text). */
  readonly code: number;
  readonly color: RGBA;
}

export interface DevelopOptions {
  readonly durationMs?: number;
  readonly onDone?: () => void;
  readonly clock?: FxClock;
  /** Jitter seed; vary it (e.g. per send) so repeats develop differently. */
  readonly seed?: number;
  readonly id?: string;
}

/** Columns a char takes, and its codepoint when drawChar can draw it alone (-1 otherwise). */
function measure(char: string): { width: number; code: number } {
  const first = char.codePointAt(0) ?? 32;
  if (char.length === 1 && first >= 32 && first < 127) return { width: 1, code: first };
  if (char === "") return { width: 0, code: -1 };
  const width = Math.max(1, Bun.stringWidth(char));
  const single = String.fromCodePoint(first) === char;
  return { width, code: single && width === 1 ? first : -1 };
}

/** The dot codepoint a cell of this weight shows at a dot stage. */
function dotCode(tone: Tone, weight: number): number {
  return glyphAt(tone, "", weight).codePointAt(0) ?? FOG_DOT;
}

/** A settled row as runs: same-colour ASCII stretches merged, other cells alone. */
function settledRuns(line: readonly Cell[], xs: Int32Array, codes: Int32Array, offset: number): Run[] {
  const runs: Run[] = [];
  let open: { x: number; text: string; fg: string } | null = null;
  const close = (): void => {
    if (open !== null) runs.push({ x: open.x, text: open.text, code: -1, color: rgba(open.fg) });
    open = null;
  };
  for (const [col, cell] of line.entries()) {
    const code = codes[offset + col] ?? -1;
    const x = xs[offset + col] ?? 0;
    if (code >= 32 && code < 127) {
      if (open !== null && open.fg === cell.fg) open.text += cell.char;
      else {
        close();
        open = { x, text: cell.char, fg: cell.fg };
      }
      continue;
    }
    close();
    if (cell.char !== "") runs.push({ x, text: cell.char, code, color: rgba(cell.fg) });
  }
  close();
  return runs;
}

class DevelopRenderable extends Renderable {
  private readonly clock: FxClock;
  private readonly durationMs: number;
  private readonly onDone: (() => void) | undefined;
  private readonly started: number;
  private cancel: Cancel | null = null;
  private settled = false;

  /** Flat per-cell tables; row r spans rowAt[r]..rowAt[r+1]. */
  private readonly rowAt: Int32Array;
  private readonly chars: string[] = [];
  private readonly xs: Int32Array;
  private readonly codes: Int32Array;
  private readonly start: Float32Array;
  private readonly weight: Uint8Array;
  private readonly bloom: Uint8Array;
  private readonly fgIndex: Uint16Array;
  private readonly fgs: string[] = [];
  private readonly mixes: (RGBA | undefined)[] = [];
  private readonly rowFirst: Float32Array;
  private readonly rowLast: Float32Array;
  private readonly finalRuns: Run[][] = [];

  constructor(ctx: RenderContext, lines: readonly (readonly Cell[])[], opts: DevelopOptions) {
    let total = 0;
    for (const line of lines) total += line.length;
    super(ctx, { id: opts.id, width: 1, height: Math.max(1, lines.length), flexShrink: 0 });
    this.clock = opts.clock ?? fxClock();
    this.durationMs = Math.max(1, opts.durationMs ?? 300);
    this.onDone = opts.onDone;
    this.started = this.clock.now();
    this.rowAt = new Int32Array(lines.length + 1);
    this.xs = new Int32Array(total);
    this.codes = new Int32Array(total);
    this.start = new Float32Array(total);
    this.weight = new Uint8Array(total);
    this.bloom = new Uint8Array(total);
    this.fgIndex = new Uint16Array(total);
    this.rowFirst = new Float32Array(lines.length);
    this.rowLast = new Float32Array(lines.length);
    this.width = Math.max(1, this.index(lines, opts.seed ?? 0));
    if (this.clock.instant) {
      this.settled = true;
      if (this.onDone !== undefined) queueMicrotask(this.onDone);
    } else {
      this.cancel = this.clock.every(FRAME_MS, () => this.tick());
    }
  }

  /** Fill the per-cell tables; returns the widest row in columns. */
  private index(lines: readonly (readonly Cell[])[], seed: number): number {
    const cascade = cascadeOf(lines);
    const palette = new Map<string, number>();
    let widest = 0;
    let i = 0;
    for (const [row, line] of lines.entries()) {
      const offset = i;
      this.rowAt[row] = offset;
      let x = 0;
      let first = 1;
      let last = 0;
      for (const [col, cell] of line.entries()) {
        let fg = palette.get(cell.fg);
        if (fg === undefined) {
          fg = this.fgs.push(cell.fg) - 1;
          palette.set(cell.fg, fg);
        }
        const { width, code } = measure(cell.char);
        const start = cellStart(seed, row, col, cascade);
        this.chars.push(cell.char);
        this.xs[i] = x;
        this.codes[i] = code;
        this.start[i] = start;
        this.weight[i] = weightOf(cell.char);
        this.bloom[i] = bloomOf(seed, row, col);
        this.fgIndex[i] = fg;
        first = Math.min(first, start);
        last = Math.max(last, start);
        x += width;
        i += 1;
      }
      widest = Math.max(widest, x);
      this.rowFirst[row] = first;
      this.rowLast[row] = last;
      this.finalRuns.push(settledRuns(line, this.xs, this.codes, offset));
    }
    this.rowAt[lines.length] = i;
    return widest;
  }

  private colorFor(tone: Tone, i: number): RGBA {
    const fg = this.fgIndex[i] ?? 0;
    const bloom = this.bloom[i] ?? 0;
    if (tone === "fog") return rgba(FX.fog);
    if (tone === "engrave") return rgba(FX.dim);
    const petal = BLOOM[bloom] ?? FX.accent;
    if (tone === "bloom") return rgba(petal);
    if (tone === "final") return rgba(this.fgs[fg] ?? FX.text);
    const level = tone === "refine" ? 0 : 1;
    const key = (fg * BLOOM.length + bloom) * 2 + level;
    let color = this.mixes[key];
    if (color === undefined) {
      color = mixRgba(petal, this.fgs[fg] ?? FX.text, MIX[level]);
      this.mixes[key] = color;
    }
    return color;
  }

  /** Whole-run progress in [0,1]. */
  get progress(): number {
    if (this.settled) return 1;
    return Math.min(1, (this.clock.now() - this.started) / this.durationMs);
  }

  get done(): boolean {
    return this.settled;
  }

  private tick(): void {
    if (this.progress >= 1) this.finish();
    else this.requestRender();
  }

  /** Land the end state now; fires onDone once. Idempotent. */
  finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.cancel?.();
    this.cancel = null;
    if (!this.isDestroyed) this.requestRender();
    this.onDone?.();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible) return;
    const t = this.progress;
    const rows = this.rowAt.length - 1;
    // x/y walk the parent chain on every read: take them once per frame.
    const left = this.x;
    const top = this.y;
    for (let row = 0; row < rows; row += 1) {
      const y = top + row;
      if (y < 0) continue;
      if (y >= buffer.height) break;
      if (localTime(t, this.rowLast[row] ?? 0) >= 1) this.drawSettled(buffer, row, left, y);
      else this.drawDeveloping(buffer, row, { left, y }, t <= (this.rowFirst[row] ?? 0) ? 0 : t);
    }
  }

  private drawSettled(buffer: OptimizedBuffer, row: number, left: number, y: number): void {
    for (const run of this.finalRuns[row] ?? []) {
      const x = left + run.x;
      if (x >= buffer.width) break;
      if (run.code >= 0) buffer.drawChar(run.code, x, y, run.color, CLEAR);
      else buffer.drawText(run.text, x, y, run.color);
    }
  }

  /** A row still developing: each cell its own stage. t=0 short-cuts to fog. */
  private drawDeveloping(buffer: OptimizedBuffer, row: number, at: { left: number; y: number }, t: number): void {
    const end = this.rowAt[row + 1] ?? 0;
    for (let i = this.rowAt[row] ?? 0; i < end; i += 1) {
      const x = at.left + (this.xs[i] ?? 0);
      if (x >= buffer.width) break;
      const tone = t === 0 ? "fog" : toneAt(localTime(t, this.start[i] ?? 0));
      this.drawCell(buffer, i, tone, x, at.y);
    }
  }

  private drawCell(buffer: OptimizedBuffer, i: number, tone: Tone, x: number, y: number): void {
    const dot = tone !== "final" && tone !== "resolve";
    // Blank cells stay blank until the row settles; nothing to draw.
    if (dot && this.weight[i] === 0) return;
    const code = dot ? dotCode(tone, this.weight[i] ?? 1) : (this.codes[i] ?? -1);
    const color = this.colorFor(tone, i);
    if (code >= 0) buffer.drawChar(code, x, y, color, CLEAR);
    else buffer.drawText(this.chars[i] ?? " ", x, y, color);
  }

  protected override destroySelf(): void {
    this.cancel?.();
    this.cancel = null;
    super.destroySelf();
  }
}

/**
 * Reveal `lines` (per-cell char + fg) from halftone fog over `durationMs`.
 * `finish()` lands the end state immediately; `onDone` fires once either way.
 */
export function developLines(
  renderer: RenderContext,
  lines: readonly (readonly Cell[])[],
  opts: DevelopOptions = {},
): Renderable & { finish(): void; readonly done: boolean; readonly progress: number } {
  return new DevelopRenderable(renderer, lines, opts);
}
