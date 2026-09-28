import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer, MouseEvent, Renderable } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { REQUEST_ROW_HEIGHT, headerSpans, requestSpans, styledSpans } from "./collections-render.ts";
import type { RowSpan, TreeBranch } from "./collections-render.ts";
import { fxClock } from "./fx/clock.ts";
import type { Cancel, FxClock } from "./fx/clock.ts";
import { cellsFromSpans, developLines } from "./fx/develop.ts";
import { blendHex } from "./motion.ts";
import { THEME } from "./theme.ts";

/**
 * One row slot of the collections pane: a one-row box and its text,
 * created once and REPAINTED as the window moves — the pane keeps a pool
 * of these for its visible window (collections-view.ts) instead of
 * rebuilding every row on every keypress. A slot only touches its text
 * when what it shows actually changed, so a cursor move repaints exactly
 * the row it left and the row it landed on.
 *
 * A slot also carries the row's feedback: the hover fill, the selection
 * pulses (fill and `▌` bar flash toward the accent and settle), and the
 * develop reveal (the row resolves out of halftone fog while its text
 * waits hidden underneath). Pulses and reveals run on the fx clock, so
 * tests can watch them frame by frame and instantClock lands them at once.
 */

/** What a slot shows: a collection header, or a request row. */
export type SlotLook =
  | { readonly kind: "header"; readonly title: string }
  | {
      readonly kind: "request";
      readonly request: LoadedRequest;
      readonly branch: TreeBranch;
      readonly selected: boolean;
    };

/** move: the cursor landed; press: enter sent it; reveal: an import arrived. */
export type PulseKind = "move" | "press" | "reveal";

/**
 * Pulse shapes: how long, how far the fill climbs from accentSoft toward the
 * accent, and the colour the bar starts at before settling to the accent.
 * Press and reveal stay on screen past 300 ms (rule_tui_input_acknowledged);
 * move is short because the bar's new position is itself the lasting sign.
 */
const PULSES: Record<PulseKind, { readonly ms: number; readonly fill: number; readonly bar: string }> = {
  move: { ms: 150, fill: 0.35, bar: THEME.color.accent },
  press: { ms: 380, fill: 0.7, bar: THEME.color.text },
  reveal: { ms: 560, fill: 0.55, bar: THEME.color.text },
};

const FRAME_MS = 16;
const TRANSPARENT = "transparent";

/** A pulse's resting fill for blending: a clear row blends toward the pane's own panel. */
const blendable = (fill: string): string => (fill === TRANSPARENT ? THEME.color.panel : fill);

/** ease-out: fast away from the peak, slow into the rest colour. */
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** Spans → a comparable string, so a repaint with nothing new is skipped. */
function signatureOf(spans: readonly RowSpan[]): string {
  return spans.map(span => `${span.text}\u0000${span.fg}\u0000${span.bold === true ? 1 : 0}`).join("\u0001");
}

interface Pulse {
  readonly kind: PulseKind;
  readonly clock: FxClock;
  readonly started: number;
  readonly cancel: Cancel;
}

export class RowSlot {
  readonly box: BoxRenderable;
  private readonly text: TextRenderable;
  private look: SlotLook | null = null;
  private signature = "";
  private fill = TRANSPARENT;
  private hovered = false;
  private overlay: Renderable | null = null;
  private pulse: Pulse | null = null;

  constructor(
    private readonly renderer: CliRenderer,
    onSelect: (name: string) => void,
  ) {
    this.box = new BoxRenderable(renderer, { height: REQUEST_ROW_HEIGHT, width: "100%", flexShrink: 0 });
    this.text = new TextRenderable(renderer, { content: "", wrapMode: "none" });
    this.box.add(this.text);
    this.box.onMouseDown = (event: MouseEvent): void => {
      const name = this.name;
      if (event.type !== "down" || event.button !== 0 || name === null) return;
      onSelect(name);
    };
    this.box.onMouseOver = (): void => this.setHovered(true);
    this.box.onMouseOut = (): void => this.setHovered(false);
  }

  /** The request this slot shows, or null for a header or an unused slot. */
  get name(): string | null {
    return this.look?.kind === "request" ? this.look.request.name : null;
  }

  /** What the slot shows, as an identity: `request:<name>`, `header:<title>`, or "". */
  get key(): string {
    if (this.look === null) return "";
    return this.look.kind === "request" ? `request:${this.look.request.name}` : `header:${this.look.title}`;
  }

  /** True while a develop reveal is running on this slot. */
  get developing(): boolean {
    return this.overlay !== null;
  }

  /**
   * Show `look`. Returns whether the text changed; an unchanged look only
   * re-asserts the fill (hover, selection) and keeps any reveal or pulse
   * running, while a changed one cancels them — they were about the old row.
   */
  show(look: SlotLook): boolean {
    this.look = look;
    this.box.visible = true;
    const spans = this.spans();
    const signature = signatureOf(spans);
    if (signature === this.signature) {
      this.paintFill();
      return false;
    }
    this.signature = signature;
    this.stopPulse();
    this.stopDevelop();
    this.text.content = styledSpans(spans);
    this.paintFill();
    return true;
  }

  /** Take the slot out of the layout (the window is shorter than the pool). */
  hide(): void {
    this.stopPulse();
    this.stopDevelop();
    this.look = null;
    this.signature = "";
    this.hovered = false;
    this.box.visible = false;
  }

  /** Mouse hover: request rows swap to elementHover; the selected row keeps its accent-soft fill. */
  setHovered(hovered: boolean): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.paintFill();
  }

  /** Resolve the row out of halftone fog over `durationMs` (skipped on an instant clock). */
  develop(durationMs: number, seed: number): void {
    const clock = fxClock();
    if (clock.instant || this.look === null) return;
    this.stopDevelop();
    const overlay = developLines(this.renderer, cellsFromSpans([this.spans()]), {
      durationMs,
      seed,
      clock,
      onDone: () => {
        if (this.overlay === overlay) this.stopDevelop();
      },
    });
    this.overlay = overlay;
    this.text.visible = false;
    this.box.add(overlay);
  }

  /** Flash the selected row's fill and bar toward the accent, then settle. */
  flash(kind: PulseKind): void {
    this.stopPulse();
    const clock = fxClock();
    if (clock.instant || this.look?.kind !== "request" || !this.look.selected) return;
    const cancel = clock.every(FRAME_MS, () => this.tickPulse());
    this.pulse = { kind, clock, started: clock.now(), cancel };
    this.paintPulse(0);
  }

  private spans(bar?: string): RowSpan[] {
    const look = this.look;
    if (look === null) return [];
    if (look.kind === "header") return headerSpans(look.title);
    return requestSpans(look.request, look.branch, look.selected, bar);
  }

  /** The fill the row rests on: selection wins over hover. */
  private restFill(): string {
    if (this.look?.kind !== "request") return TRANSPARENT;
    if (this.look.selected) return THEME.color.accentSoft;
    return this.hovered ? THEME.color.elementHover : TRANSPARENT;
  }

  private paintFill(): void {
    if (this.pulse !== null) {
      this.tickPulse();
      return;
    }
    this.setFill(this.restFill());
  }

  /** Write the box's fill only when it changes: an unchanged row costs nothing. */
  private setFill(fill: string): void {
    if (this.fill === fill) return;
    this.fill = fill;
    this.box.backgroundColor = fill;
  }

  private tickPulse(): void {
    const pulse = this.pulse;
    if (pulse === null) return;
    if (this.box.isDestroyed) {
      pulse.cancel(); // the pane went away mid-pulse (renderer destroyed)
      this.pulse = null;
      return;
    }
    const t = (pulse.clock.now() - pulse.started) / PULSES[pulse.kind].ms;
    if (t >= 1) this.stopPulse();
    else this.paintPulse(easeOut(Math.max(0, t)));
  }

  /** One pulse frame at eased progress `e` (0 = peak, 1 = rest). */
  private paintPulse(e: number): void {
    const shape = PULSES[this.pulse?.kind ?? "move"];
    const rest = blendable(this.restFill());
    const peak = blendHex(THEME.color.accentSoft, THEME.color.accent, shape.fill);
    this.setFill(blendHex(peak, rest, e));
    this.text.content = styledSpans(this.spans(blendHex(shape.bar, THEME.color.accent, e)));
  }

  private stopPulse(): void {
    if (this.pulse === null) return;
    this.pulse.cancel();
    this.pulse = null;
    if (this.box.isDestroyed) return;
    this.text.content = styledSpans(this.spans());
    this.setFill(this.restFill());
  }

  private stopDevelop(): void {
    const overlay = this.overlay;
    if (overlay === null) return;
    this.overlay = null;
    overlay.destroyRecursively();
    if (!this.text.isDestroyed) this.text.visible = true;
  }
}
