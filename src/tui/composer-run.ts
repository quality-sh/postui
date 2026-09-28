import { writeFileAtomic } from "../fs/atomic.ts";
import type { LoadedRequest } from "../gen/load.ts";
import type { SendResult } from "../send/send.ts";
import { tableSource } from "./composer-editor.ts";
import type { EditorState } from "./composer-editor.ts";
import { holdUntil, type ComposerFx } from "./composer-fx.ts";
import type { LiveParts } from "./composer-mount.ts";
import type { ComposerMessage } from "./composer-render.ts";
import { DraftSaveRefusedError, draftModule } from "./composer-save.ts";
import { draftCredentialValues } from "./composer-send.ts";
import type { RequestDraft, sendDraft } from "./composer-send.ts";
import { fxClock } from "./fx/clock.ts";
import { notify } from "./fx/notify.ts";
import { blendHex } from "./motion.ts";
import { errorLine } from "./render.ts";
import { THEME } from "./theme.ts";

/**
 * The composer's two actions that start work — SEND and ctrl+s — with the
 * feedback each one owes the input rule (rule_tui_input_acknowledged).
 *
 * SEND: the pill swells brighter under the key and shows a spinner for the
 * whole send; the busy state lasts at least MIN_BUSY_MS on the fx clock.
 * A response that lands sooner is HELD — the result reaches the response
 * pane (diagnostics.showResult / showError) only once MIN_BUSY_MS has
 * passed since the key, so pill and pane leave the busy state together
 * and a fast send never looks like nothing happened. A second send while
 * one is in flight is refused with a note and a love pulse on the pill.
 *
 * Save: a toast either way (`saved <name>.ts`, the refusal's reason, or
 * `no changes to save`), the title's ● fading into the panel on success,
 * and a love pulse on the field a refusal names.
 */

/** Minimum busy display for a send, from the key (design/feel-spec.md §3.2). */
export const MIN_BUSY_MS = 220;
/** The ● fades out over this long once a save clears it. */
const DOT_FADE_MS = 420;
const SEND_PRESSED = blendHex(THEME.color.accent, THEME.color.text, 0.45);

/**
 * What the composer tells the response pane (the diagnostic region). The
 * shell wires these to the response pane; the composer never renders
 * response content itself.
 */
export interface SendDiagnostics {
  showSending(): void;
  /**
   * `forName` tags the result with the request that produced it (the pane
   * labels a result that outlives its request). `extraSecrets` carries
   * values that must be scrubbed from the rendered output in addition to
   * the pipeline's resolved env values (literal credential values from the
   * draft).
   */
  showResult(result: SendResult, latencyMs: number, extraSecrets?: string[], forName?: string): void;
  showError(error: unknown): void;
  showNote(text: string): void;
}

/** The pane's mutable state, shared by the pane, its renderer and these actions. */
export interface ComposerState {
  request: LoadedRequest | null;
  /** draftKey of what the module on disk holds. */
  baseline: string;
  inFlight: boolean;
  focused: boolean;
  message: ComposerMessage | null;
  readonly scroll: { bodyTop: number };
  /** The fx target under the mouse. */
  hover: string | null;
  readonly live: LiveParts;
}

export interface RunContext {
  readonly state: ComposerState;
  readonly editor: EditorState;
  readonly fx: ComposerFx;
  readonly diagnostics: SendDiagnostics;
  readonly sendDraft: typeof sendDraft;
  readonly render: () => void;
  /** Run a step after every step queued before it (sends and saves settle in order). */
  readonly enqueue: (step: () => Promise<void>) => Promise<void>;
}

/** Canonical form of a draft for the dirty check. */
export const draftKey = (draft: RequestDraft | null): string => JSON.stringify(draft);

export const isDirty = (ctx: Pick<RunContext, "state" | "editor">): boolean =>
  ctx.state.request !== null && draftKey(ctx.editor.draft) !== ctx.state.baseline;

/** Start a send; false when there is nothing to send or one is already in flight. */
export function runSend(ctx: RunContext, bodyWindow?: number): boolean {
  const draft = ctx.editor.draft;
  const request = ctx.state.request;
  if (draft === null || request === null) return false;
  if (ctx.state.inFlight) {
    // Never queue a second (possibly mutating) request behind the first.
    ctx.diagnostics.showNote("a send is already in flight — wait for it to finish");
    ctx.fx.pulse("send", THEME.color.love, { shape: "swell" });
    return false;
  }
  const clock = fxClock();
  const startedAt = clock.now();
  ctx.state.inFlight = true;
  ctx.fx.pulse("send", SEND_PRESSED, { shape: "swell" });
  ctx.diagnostics.showSending();
  ctx.render();
  // The pipeline gets a snapshot: typing during the send edits the next one.
  const sent = structuredClone(draft);
  void ctx.enqueue(async () => {
    let deliver: () => void;
    try {
      const { result, latencyMs } = await ctx.sendDraft(sent, request.name, bodyWindow);
      deliver = () => ctx.diagnostics.showResult(result, latencyMs, draftCredentialValues(sent), request.name);
    } catch (error) {
      // Named typed errors land on the diagnostic region — never a stack
      // trace, never a crash. MissingEnvError arrives before any network
      // I/O; every pipeline error message is pre-scrubbed.
      deliver = () => ctx.diagnostics.showError(error);
    }
    await holdUntil(clock, startedAt + MIN_BUSY_MS);
    try {
      deliver();
    } finally {
      ctx.state.inFlight = false;
      ctx.state.live.spinner?.destroyRecursively();
      ctx.state.live.spinner = null;
      ctx.render();
    }
  });
  return true;
}

/**
 * Ctrl+S. The module text and the credential checks run synchronously, so
 * a refusal shows at once and the baseline moves with the keypress; the
 * atomic write follows on the queue. A failed write restores the old
 * baseline (the ● comes back).
 */
export function runSave(ctx: RunContext): void {
  const draft = ctx.editor.draft;
  const request = ctx.state.request;
  if (draft === null || request === null) return;
  if (!isDirty(ctx)) {
    notify("no changes to save", "info");
    return;
  }
  let module: ReturnType<typeof draftModule>;
  try {
    module = draftModule(draft);
  } catch (error) {
    if (!(error instanceof DraftSaveRefusedError)) throw error;
    ctx.state.message = { text: error.message, tone: "error" };
    notify(error.message, "error");
    pulseRefused(ctx, error);
    return;
  }
  draft.url = module.url; // what the module now stores (URL normalization)
  ctx.editor.urlCursor = Math.min(ctx.editor.urlCursor, draft.url.length);
  const previous = ctx.state.baseline;
  const saved = draftKey(draft);
  ctx.state.baseline = saved;
  ctx.fx.pulse("dot", THEME.color.text, { durationMs: DOT_FADE_MS, onDone: ctx.render });
  void ctx.enqueue(async () => {
    try {
      await writeFileAtomic(request.path, module.source);
      notify(`saved ${request.name}.ts`, "success");
    } catch (error) {
      if (ctx.state.baseline === saved) ctx.state.baseline = previous;
      ctx.state.message = { text: errorLine(error), tone: "error" };
      notify(errorLine(error), "error");
    }
    ctx.render();
  });
}

/** Point at what a refusal names: the URL pill, or the credential header's row (its tab when hidden). */
function pulseRefused(ctx: RunContext, error: DraftSaveRefusedError): void {
  const refused = { shape: "swell" as const };
  if (error.field === "url") {
    ctx.fx.pulse("url", THEME.color.love, refused);
    return;
  }
  const name = error.header?.toLowerCase() ?? "";
  const shown = ctx.editor.tab === "headers" || ctx.editor.tab === "auth";
  const row = shown ? (tableSource(ctx.editor)?.rows.findIndex(([header]) => header.toLowerCase() === name) ?? -1) : -1;
  ctx.fx.pulse(row >= 0 ? `row:${row}` : "tab:auth", THEME.color.love, refused);
}
