import { StyledText, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { SendResult } from "../send/send.ts";
import type { SendTarget } from "./composer-send.ts";
import { fxClock, type Cancel } from "./fx/clock.ts";
import { notify } from "./fx/notify.ts";
import { halftoneSpinner } from "./fx/spinner.ts";
import { errorLine } from "./render.ts";
import { clockTime, formatBytes, statusColor, targetChunks } from "./response-header.ts";
import type { SendStamp } from "./response-header.ts";
import type { ResponsePane } from "./response-pane.ts";
import type { StatusBar } from "./status-bar.ts";
import { THEME } from "./theme.ts";

/**
 * The send lifecycle on the response side: what the screen does between
 * the keypress that starts a send and the settled result. The composer
 * says when a send starts and settles (its diagnostics callbacks); this
 * controller turns that into the feel spec's sequence (§3.2) across the
 * response pane and the status bar's live slot.
 */

/** The busy view stays up at least this long, however fast the send. */
export const MIN_BUSY_MS = 220;

export interface SendLifecycle {
  /** A send started (t=0): number it, show the busy view everywhere. */
  started(): void;
  /** The send pipeline named its target: label the busy views. */
  described(target: SendTarget): void;
  result(result: SendResult, latencyMs: number, extraSecrets?: string[], forName?: string): void;
  error(error: unknown): void;
  /** True from started() until the settled view is on screen. */
  readonly busy: boolean;
  /** Cancel a held result; later calls do nothing (the shell is gone). */
  dispose(): void;
}

export interface SendLifecycleOptions {
  readonly renderer: CliRenderer;
  readonly response: Pick<ResponsePane, "showSending" | "describeSending" | "showResult" | "showError">;
  readonly statusBar: Pick<StatusBar, "setStatus" | "setIndicator">;
  /** Called when `busy` flips (the shell repaints the bar's send hint). */
  readonly onBusyChange: (busy: boolean) => void;
  /** Wall clock for the `HH:MM:SS` stamp (default: now). */
  readonly wallClock?: () => Date;
}

/** `● 200 · 12ms · 1.2KB · #4`: the live slot once a send has settled. */
function settledStatus(color: string, text: string): StyledText {
  return new StyledText([fg(color)("●"), fg(THEME.color.muted)(` ${text}`)]);
}

/** `sending GET /path` beside the spinner (just "sending" until the target is known). */
function sendingStatus(target: SendTarget | null): StyledText {
  if (target === null) return new StyledText(targetChunks(null));
  return new StyledText([fg(THEME.color.muted)("sending "), ...targetChunks(target)]);
}

/**
 * Every send visibly lands, even when its response is byte-identical to
 * the last one: at t=0 the pane and the status bar go busy (spinner,
 * `GET /path`, a live ms count, skeleton fog); the settled view is held
 * back until the busy view has been up MIN_BUSY_MS on the fx clock (a
 * no-op when the composer already held that long); then it develops in,
 * seeded and stamped with a per-session send number and the time of day,
 * so a repeat send always paints a new screen. A failed send does the
 * same in love and also raises a toast.
 */
// @provenance rule: rule_tui_input_acknowledged
export function startSendLifecycle(options: SendLifecycleOptions): SendLifecycle {
  const wallClock = options.wallClock ?? ((): Date => new Date());
  let count = 0;
  let startedAt = 0;
  let busy = false;
  /** The settled view waiting out the minimum busy time. */
  let held: { run: () => void; cancel: Cancel } | null = null;
  let disposed = false;

  const setBusy = (next: boolean): void => {
    if (busy === next) return;
    busy = next;
    options.onBusyChange(next);
  };

  const stamp = (): SendStamp => ({ number: count, time: clockTime(wallClock()) });

  /** Run `show` once the busy view has had its minimum time. */
  const settle = (show: () => void): void => {
    if (disposed) return; // a send that outlived its shell paints nothing
    const run = (): void => {
      held = null;
      show();
      setBusy(false);
    };
    const clock = fxClock();
    const wait = MIN_BUSY_MS - (clock.now() - startedAt);
    if (clock.instant || wait <= 0) {
      run();
      return;
    }
    held = { run, cancel: clock.after(wait, run) };
  };

  return {
    get busy(): boolean {
      return busy;
    },
    dispose(): void {
      disposed = true;
      held?.cancel();
      held = null;
    },
    started(): void {
      if (disposed) return;
      // A result still held from the last send lands first, so it is never lost.
      if (held !== null) {
        held.cancel();
        held.run();
      }
      count += 1;
      startedAt = fxClock().now();
      options.response.showSending({ number: count, startedAt, target: null });
      options.statusBar.setIndicator(halftoneSpinner(options.renderer, { width: 4 }));
      options.statusBar.setStatus(sendingStatus(null));
      setBusy(true);
    },
    described(next: SendTarget): void {
      if (disposed || !busy || held !== null) return;
      options.response.describeSending(next);
      options.statusBar.setStatus(sendingStatus(next));
    },
    result(result, latencyMs, extraSecrets, forName): void {
      settle(() => {
        const mark = stamp();
        const { status, response } = result.outcome;
        options.response.showResult(result, latencyMs, extraSecrets, forName, mark);
        options.statusBar.setIndicator(null);
        const size = formatBytes(response.size).replace(" ", "");
        const ms = Math.max(1, Math.round(latencyMs));
        options.statusBar.setStatus(settledStatus(statusColor(status), `${status} · ${ms}ms · ${size} · #${mark.number}`));
      });
    },
    error(error): void {
      settle(() => {
        const mark = stamp();
        options.response.showError(error, mark);
        options.statusBar.setIndicator(null);
        options.statusBar.setStatus(settledStatus(THEME.color.love, `error · #${mark.number}`));
        notify(errorLine(error), "error");
      });
    },
  };
}
