import { BoxRenderable } from "@opentui/core";
import type { BorderCharacters, RenderContext, Renderable } from "@opentui/core";
import { fxClock, type Cancel, type FxClock } from "./clock.ts";
import { developLines, type Cell } from "./develop.ts";
import { FX } from "./palette.ts";

/**
 * Toasts: a top-right stack (newest on top, at most 3) of panel-coloured
 * notes with a `▌` bar in the variant colour, after opencode's ui/toast.tsx.
 * Each one's text develops in from halftone fog and the note leaves after
 * 1.8 s on the fx clock.
 */

export type ToastVariant = "success" | "error" | "info";

const HIDE_MS = 1800;
const REVEAL_MS = 180;
const MAX_TOASTS = 3;

const VARIANTS: Record<ToastVariant, { readonly color: string; readonly mark: string }> = {
  success: { color: FX.sage, mark: "✓" },
  error: { color: FX.love, mark: "✗" },
  info: { color: FX.accent, mark: "•" },
};

/** Only the left side draws: a half-block bar, no corners. */
const BAR: BorderCharacters = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "▌",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
};

interface Entry {
  readonly box: BoxRenderable;
  readonly hide: Cancel;
}

export interface Toaster {
  show(text: string, variant: ToastVariant): void;
  /** Toasts on screen now. */
  readonly count: number;
  /** Remove every toast and the stack; cancels their timers. */
  destroy(): void;
}

/** Fit text to `max` columns, ending in … when cut. */
function fit(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " "));
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function mountToasts(
  renderer: RenderContext,
  root: Renderable,
  opts: { readonly clock?: FxClock; readonly top?: number } = {},
): Toaster {
  const clock = opts.clock ?? fxClock();
  const stack = new BoxRenderable(renderer, {
    id: "fx-toasts",
    position: "absolute",
    top: opts.top ?? 1,
    right: 2,
    zIndex: 100,
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 1,
  });
  root.add(stack);
  let entries: Entry[] = [];

  const drop = (entry: Entry): void => {
    entry.hide();
    entries = entries.filter(other => other !== entry);
    if (!entry.box.isDestroyed) entry.box.destroyRecursively();
  };

  return {
    show(text, variant) {
      const { color, mark } = VARIANTS[variant];
      const room = Math.max(8, Math.min(56, renderer.width - 10));
      const cells: Cell[] = [
        { char: mark, fg: color },
        { char: " ", fg: FX.text },
        ...Array.from(fit(text, room), char => ({ char, fg: FX.text })),
      ];
      const box = new BoxRenderable(renderer, {
        backgroundColor: FX.panel,
        border: ["left"],
        customBorderChars: BAR,
        borderColor: color,
        paddingLeft: 1,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
      });
      box.add(developLines(renderer, [cells], { durationMs: REVEAL_MS, clock, seed: entries.length }));
      stack.add(box, 0);
      const entry: Entry = { box, hide: clock.after(HIDE_MS, () => drop(entry)) };
      entries = [entry, ...entries];
      for (const old of entries.slice(MAX_TOASTS)) drop(old);
    },
    get count() {
      return entries.length;
    },
    destroy() {
      for (const entry of entries) drop(entry);
      if (!stack.isDestroyed) stack.destroyRecursively();
    },
  };
}
