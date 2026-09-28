/**
 * The animation clock every fx effect runs on. Effects never read time or
 * set timers themselves: they ask the clock, so one swap makes them
 * deterministic.
 *
 * - realClock: performance.now + unref'd timers (an animation never keeps
 *   the process alive). The app's clock.
 * - manualClock: time moves only on advance(ms), firing due timers in time
 *   order. Tests render frames at exactly the times they choose.
 * - instantClock: effects land their end state at once and never tick —
 *   for app-level tests that don't care about motion (the fx analogue of
 *   motion.ts running without the timeline engine).
 */

export type Cancel = () => void;

export interface FxClock {
  /** True when effects should skip straight to their end state. */
  readonly instant: boolean;
  /** Milliseconds on this clock's own timeline. */
  now(): number;
  /** Call fn every `ms` until the returned cancel runs. */
  every(ms: number, fn: () => void): Cancel;
  /** Call fn once after `ms` unless cancelled first. */
  after(ms: number, fn: () => void): Cancel;
}

export interface ManualClock extends FxClock {
  /** Move time forward, firing every timer that falls due, in time order. */
  advance(ms: number): void;
  /** How many timers are still scheduled (0 = nothing leaked). */
  pending(): number;
}

const noop: Cancel = () => {};

export function realClock(): FxClock {
  return {
    instant: false,
    now: () => performance.now(),
    every: (ms, fn) => {
      const id = setInterval(fn, Math.max(1, ms));
      id.unref();
      return () => clearInterval(id);
    },
    after: (ms, fn) => {
      const id = setTimeout(fn, Math.max(0, ms));
      id.unref();
      return () => clearTimeout(id);
    },
  };
}

interface Timer {
  due: number;
  readonly period: number | null;
  readonly fn: () => void;
}

export function manualClock(start = 0): ManualClock {
  let time = start;
  const timers = new Set<Timer>();
  const schedule = (ms: number, period: number | null, fn: () => void): Cancel => {
    const timer: Timer = { due: time + Math.max(0, ms), period, fn };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  };
  const nextDue = (limit: number): Timer | null => {
    let next: Timer | null = null;
    for (const timer of timers) {
      if (timer.due <= limit && (next === null || timer.due < next.due)) next = timer;
    }
    return next;
  };
  return {
    instant: false,
    now: () => time,
    every: (ms, fn) => schedule(Math.max(1, ms), Math.max(1, ms), fn),
    after: (ms, fn) => schedule(ms, null, fn),
    advance(ms) {
      const target = time + Math.max(0, ms);
      for (let next = nextDue(target); next !== null; next = nextDue(target)) {
        time = next.due;
        if (next.period === null) timers.delete(next);
        else next.due += next.period;
        next.fn();
      }
      time = target;
    },
    pending: () => timers.size,
  };
}

export function instantClock(): FxClock {
  return { instant: true, now: () => 0, every: () => noop, after: () => noop };
}

let current: FxClock = realClock();

/** The clock effects use when none is passed. */
export function fxClock(): FxClock {
  return current;
}

/** Swap the default clock (e.g. instantClock in app tests); returns the undo. */
export function setFxClock(clock: FxClock): () => void {
  const previous = current;
  current = clock;
  return () => {
    current = previous;
  };
}
