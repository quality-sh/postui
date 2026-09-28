import { fxClock, type Cancel, type FxClock } from "./fx/clock.ts";
import { blendHex } from "./motion.ts";

/**
 * The composer's acknowledgements: short colour pulses on its pills, tabs
 * and rows, run on the fx clock.
 *
 * The composer rebuilds its whole pane on every key, so a sweep bound to
 * one box (motion.ts sweepFill) dies with that box on the next keystroke.
 * Here a pulse belongs to a TARGET name ("send", "method", "row:2"), not a
 * box: each render binds the target's fresh box and its rest colour, and
 * the colour on screen is read off the clock — a rebuild mid-pulse carries
 * on where it was. Nothing rebuilds while a pulse runs: one timer repaints
 * the bound colours and stops when the last pulse ends. On an instant
 * clock (app tests) a pulse is its end state: the rest colour, at once.
 */

/** `sweep` runs from its colour to rest; `swell` rises from rest to its colour and falls back. */
type Shape = "sweep" | "swell";

/** Default pulse length: the input rule's ≥300 ms sign, with room to spare. */
const PULSE_MS = 320;

const FRAME_MS = 16;
/** Where a swell peaks, as a share of its run: a quick rise, a slower fall. */
const PEAK_AT = 0.3;

interface Pulse {
  readonly color: string;
  readonly shape: Shape;
  readonly start: number;
  readonly durationMs: number;
  readonly onDone: (() => void) | undefined;
}

interface Slot {
  /** The colour the target shows when no pulse runs (hover and focus fold in here). */
  readonly rest: () => string;
  readonly paint: (color: string) => void;
}

interface PulseOptions {
  readonly shape?: Shape;
  readonly durationMs?: number;
  /** Runs once when the pulse ends (at once on an instant clock). */
  readonly onDone?: () => void;
}

export interface ComposerFx {
  /** Start (or restart) a pulse on `target`. */
  pulse(target: string, color: string, opts?: PulseOptions): void;
  /** Bind this render's box for `target`: paints it now and on every pulse frame. */
  bind(target: string, rest: () => string, paint: (color: string) => void): void;
  /** Repaint a bound target (its rest colour changed: hover moved). */
  refresh(target: string): void;
  /** True while a pulse runs on `target`. */
  running(target: string): boolean;
  /** Forget every binding: the boxes they paint are about to be destroyed. */
  unbindAll(): void;
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** A pulse's colour at progress t ∈ [0,1]. */
function colorAt(pulse: Pulse, rest: string, t: number): string {
  if (pulse.shape === "sweep") return blendHex(pulse.color, rest, easeOut(t));
  const rise = t < PEAK_AT ? t / PEAK_AT : 1 - (t - PEAK_AT) / (1 - PEAK_AT);
  return blendHex(rest, pulse.color, easeOut(Math.max(0, rise)));
}

/** Pulses run on the fx clock in use when they start (real in the app, manual or instant in tests). */
export function createComposerFx(): ComposerFx {
  const pulses = new Map<string, Pulse>();
  const slots = new Map<string, Slot>();
  let ticker: Cancel | null = null;
  let tickerClock: FxClock | null = null;

  const current = (target: string, slot: Slot): string => {
    const pulse = pulses.get(target);
    const rest = slot.rest();
    if (pulse === undefined || tickerClock === null) return rest;
    const t = Math.min(1, (tickerClock.now() - pulse.start) / pulse.durationMs);
    return colorAt(pulse, rest, t);
  };

  const stopTicker = (): void => {
    ticker?.();
    ticker = null;
    tickerClock = null;
  };

  const tick = (): void => {
    const now = tickerClock?.now() ?? 0;
    const ended: Pulse[] = [];
    for (const [target, pulse] of pulses) {
      if (now - pulse.start >= pulse.durationMs) {
        pulses.delete(target);
        ended.push(pulse);
      }
      const slot = slots.get(target);
      if (slot !== undefined) slot.paint(current(target, slot));
    }
    if (pulses.size === 0) stopTicker();
    for (const pulse of ended) pulse.onDone?.();
  };

  return {
    pulse(target, color, opts = {}) {
      const time = fxClock();
      if (time.instant) {
        opts.onDone?.();
        return;
      }
      if (tickerClock !== null && tickerClock !== time) {
        // The clock was swapped under running pulses (tests): they end now.
        pulses.clear();
        stopTicker();
      }
      tickerClock = time;
      pulses.set(target, {
        color,
        shape: opts.shape ?? "sweep",
        start: time.now(),
        durationMs: Math.max(1, opts.durationMs ?? PULSE_MS),
        onDone: opts.onDone,
      });
      ticker ??= time.every(FRAME_MS, tick);
      const slot = slots.get(target);
      if (slot !== undefined) slot.paint(current(target, slot));
    },
    bind(target, rest, paint) {
      const slot = { rest, paint };
      slots.set(target, slot);
      paint(current(target, slot));
    },
    refresh(target) {
      const slot = slots.get(target);
      if (slot !== undefined) slot.paint(current(target, slot));
    },
    running: (target) => pulses.has(target),
    unbindAll: () => slots.clear(),
  };
}

/**
 * Resolve once `until` (a time on `clock`) has passed. An instant clock
 * never waits: its effects have no duration to hold for.
 */
export function holdUntil(clock: FxClock, until: number): Promise<void> {
  const remaining = until - clock.now();
  if (clock.instant || remaining <= 0) return Promise.resolve();
  return new Promise(resolve => {
    clock.after(remaining, resolve);
  });
}
