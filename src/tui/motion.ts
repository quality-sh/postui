import { createTimeline, engine } from "@opentui/core";
import type { BoxRenderable, CliRenderer, Timeline } from "@opentui/core";

/**
 * Motion layer: short border-color sweeps on the transitions the app already
 * paints instantly — selection moves, pane focus changes, status-bar mode
 * changes. Everything is one property (borderColor) written a few times over
 * ~150ms: visible in the terminal, invisible in the frame budget, and
 * skippable — without the timeline engine attached (tests, headless runs)
 * every sweep lands its end state synchronously, so callers never need to
 * care whether motion ran.
 */

/** Parse #rrggbb into channels; returns null for anything else. */
function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) return null;
  return [
    Number.parseInt(match[1] ?? "", 16),
    Number.parseInt(match[2] ?? "", 16),
    Number.parseInt(match[3] ?? "", 16),
  ];
}

const toByte = (value: number): string =>
  Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");

/**
 * Linear blend of two #rrggbb colors; t=0 is `a`, t=1 is `b`. Any
 * non-#rrggbb input (OpenTUI also accepts names/RGBA objects) returns `b`
 * at t>=1 and `a` otherwise, so a sweep through an unparsable color still
 * lands on a valid endpoint.
 */
export function blendHex(a: string, b: string, t: number): string {
  const from = parseHex(a);
  const to = parseHex(b);
  if (from === null || to === null) return t >= 1 ? b : a;
  const clamped = Math.max(0, Math.min(1, t));
  const [r0, g0, b0] = from;
  const [r1, g1, b1] = to;
  return `#${toByte(r0 + (r1 - r0) * clamped)}${toByte(g0 + (g1 - g0) * clamped)}${toByte(b0 + (b1 - b0) * clamped)}`;
}

/** A border sweep's timing. Short by design: motion confirms, never performs. */
const SWEEP_MS = 150;

let rendererAttached = false;

/**
 * Drive the timeline engine from the renderer's frame loop. Idempotent;
 * the returned detach finalizes every live sweep (end state painted) and
 * unregisters the engine — call it before renderer.destroy().
 */
export function attachMotion(renderer: CliRenderer): () => void {
  if (!rendererAttached) {
    engine.attach(renderer);
    rendererAttached = true;
  }
  return detachMotion;
}

/** Stop the engine and land every in-flight sweep on its end state. */
export function detachMotion(): void {
  // Deleting the current entry during Map iteration is safe (spec-defined),
  // so no snapshot copy is needed.
  for (const [pane, sweep] of live) finalize(pane, sweep, sweep.to);
  engine.detach();
  rendererAttached = false;
}

interface LiveSweep {
  readonly timeline: Timeline;
  readonly from: string;
  readonly to: string;
  /** The tween's 0→1 progress, shared with onUpdate (Timeline mutates it). */
  readonly state: { t: number };
}

/** One live sweep per renderable: a new sweep replaces the running one. */
const live = new Map<BoxRenderable, LiveSweep>();

function finalize(pane: BoxRenderable, sweep: LiveSweep, endColor: string): void {
  sweep.timeline.pause();
  engine.unregister(sweep.timeline);
  live.delete(pane);
  pane.borderColor = endColor;
}

/**
 * Cancel any live sweep on the pane and pin `color` immediately — for when
 * the state a sweep was animating TOWARD is no longer true (focus moved on
 * before the sweep finished). Without this, the sweep's completion would
 * repaint the stale end color over the newer state.
 */
export function settleBorder(pane: BoxRenderable, color: string): void {
  const running = live.get(pane);
  if (running !== undefined) {
    running.timeline.pause();
    engine.unregister(running.timeline);
    live.delete(pane);
  }
  pane.borderColor = color;
}

/**
 * Sweep a pane's border color from `from` to `to` over `durationMs`
 * (ease-out). Without the engine attached the end color is painted
 * synchronously — the same visible result, zero timing dependencies.
 * A sweep started while one is running resumes from the running sweep's
 * current color, so rapid keypresses never snap the border backwards.
 * Returns whether the sweep animated (false = the synchronous fallback).
 */
export function sweepBorder(
  pane: BoxRenderable,
  from: string,
  to: string,
  durationMs: number = SWEEP_MS,
): boolean {
  const running = live.get(pane);
  const start =
    running === undefined
      ? from
      : blendHex(running.from, running.to, running.state.t);
  if (running !== undefined) finalize(pane, running, start);
  if (!rendererAttached) {
    pane.borderColor = to;
    return false;
  }
  const state = { t: 0 };
  const timeline = createTimeline({ duration: durationMs, autoplay: true });
  timeline.add(state, {
    t: 1,
    duration: durationMs,
    ease: "outQuad",
    onUpdate: () => {
      pane.borderColor = blendHex(start, to, state.t);
    },
    onComplete: () => {
      pane.borderColor = to;
      engine.unregister(timeline);
      if (live.get(pane)?.timeline === timeline) live.delete(pane);
    },
  });
  live.set(pane, { timeline, from: start, to, state });
  return true;
}
