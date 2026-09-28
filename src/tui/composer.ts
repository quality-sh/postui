import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { writeFileAtomic } from "../fs/atomic.ts";
import type { LoadedRequest } from "../gen/load.ts";
import type { SendResult } from "../send/send.ts";
import { editorKey, isEditingText, loadDraft, newEditorState } from "./composer-editor.ts";
import type { ComposerField, EditorEffect } from "./composer-editor.ts";
import { renderComposerPane } from "./composer-render.ts";
import type { ComposerMessage } from "./composer-render.ts";
import { DraftSaveRefusedError, draftModule } from "./composer-save.ts";
import { draftCredentialValues, draftOf, sendDraft } from "./composer-send.ts";
import type { RequestDraft } from "./composer-send.ts";
import type { ComposerKey } from "./composer-text.ts";
import { clearChildren, errorLine } from "./render.ts";
import { THEME } from "./theme.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COMPOSER_PANE_ID = "composer";

/**
 * What the composer tells the response pane (the diagnostic region). The
 * shell wires these to the response pane; the composer never renders
 * response content itself.
 */
interface SendDiagnostics {
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

export interface ComposerPaneOptions {
  /** Where send feedback and named errors surface (the response pane). */
  readonly diagnostics: SendDiagnostics;
}

export interface ComposerPane {
  readonly pane: BoxRenderable;
  /** The request loaded into the composer, if any. */
  readonly loadedName: string | null;
  /** True while the draft differs from the module on disk (the ● marker). */
  readonly edited: boolean;
  /** The field inside the composer that has the keys. */
  readonly field: ComposerField;
  /**
   * True while a text field (URL, body, a table cell) has the keys: every
   * printable key — "q" and "/" included — types there instead of reaching
   * the global map.
   */
  isEditingText(): boolean;
  /** Load a saved request into an in-memory draft. */
  load(request: LoadedRequest): void;
  /** Drop the draft (the module it came from is gone). */
  clear(): void;
  /**
   * Execute the draft through the send pipeline. `bodyWindow` is the
   * response pane's --body-bytes equivalent (progressive disclosure re-sends
   * through the same path). Safe to call while a send is in flight: the
   * second attempt is refused with a note, never queued. Returns whether a
   * send actually started.
   */
  send(bodyWindow?: number): boolean;
  /** Handle a keypress while the pane is focused; true = consumed. */
  handleKey(key: ComposerKey): boolean;
  /** Tell the composer which pane has app focus (field focus shows only when it is this one). */
  syncFocus(focusedPaneId: string | null): void;
  /** Resolves when the send or save currently in flight (if any) has settled. */
  settled(): Promise<void>;
}

/** Canonical form of a draft for the dirty check. */
const draftKey = (draft: RequestDraft | null): string => JSON.stringify(draft);

/**
 * The composer: METHOD, URL, PARAMS/HEADERS/BODY/AUTH and the body editor
 * over an IN-MEMORY draft of a saved request. Keys edit the draft directly
 * (composer-editor.ts); SEND executes it through the real pipeline
 * (sendDraft → sendRequest), never a TUI-local reimplementation; ctrl+s
 * writes it back to its own module in the `postui save` shape
 * (composer-save.ts), refusing literal credentials.
 */
export function startComposerPane(renderer: CliRenderer, options: ComposerPaneOptions): ComposerPane {
  const pane = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: THEME.color.border,
    title: "COMPOSER",
    titleColor: THEME.color.bright,
    backgroundColor: THEME.color.bg,
  });

  const editor = newEditorState();
  const state = {
    request: null as LoadedRequest | null,
    /** draftKey of what the module on disk holds. */
    baseline: "",
    inFlight: false,
    focused: false,
    message: null as ComposerMessage | null,
    scroll: { bodyTop: 0 },
  };

  let tail: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const done = tail.then(step, step);
    tail = done;
    return done;
  };

  const dirty = (): boolean => state.request !== null && draftKey(editor.draft) !== state.baseline;

  const render = (): void => {
    clearChildren(pane);
    renderComposerPane(renderer, pane, {
      request: state.request,
      editor,
      dirty: dirty(),
      inFlight: state.inFlight,
      focused: state.focused,
      message: state.message,
      scroll: state.scroll,
    });
  };

  const send = (bodyWindow?: number): boolean => {
    const draft = editor.draft;
    const request = state.request;
    if (draft === null || request === null) return false;
    if (state.inFlight) {
      // Never queue a second (possibly mutating) request behind the first.
      options.diagnostics.showNote("a send is already in flight — wait for it to finish");
      return false;
    }
    state.inFlight = true;
    options.diagnostics.showSending();
    render();
    // The pipeline gets a snapshot: typing during the send edits the next one.
    const sent = structuredClone(draft);
    void enqueue(async () => {
      try {
        const { result, latencyMs } = await sendDraft(sent, request.name, bodyWindow);
        options.diagnostics.showResult(result, latencyMs, draftCredentialValues(sent), request.name);
      } catch (error) {
        // Named typed errors land on the diagnostic region — never a stack
        // trace, never a crash. MissingEnvError arrives before any network
        // I/O; every pipeline error message is pre-scrubbed.
        options.diagnostics.showError(error);
      } finally {
        state.inFlight = false;
        render();
      }
    });
    return true;
  };

  /**
   * Ctrl+S. The module text and the credential checks run synchronously, so
   * a refusal shows at once and the baseline moves with the keypress; the
   * atomic write follows on the queue. A failed write restores the old
   * baseline (the ● comes back).
   */
  const save = (): void => {
    const draft = editor.draft;
    const request = state.request;
    if (draft === null || request === null) return;
    let module: ReturnType<typeof draftModule>;
    try {
      module = draftModule(draft);
    } catch (error) {
      if (!(error instanceof DraftSaveRefusedError)) throw error;
      state.message = { text: error.message, tone: "error" };
      return;
    }
    draft.url = module.url; // what the module now stores (URL normalization)
    editor.urlCursor = Math.min(editor.urlCursor, draft.url.length);
    const previous = state.baseline;
    const saved = draftKey(draft);
    state.baseline = saved;
    void enqueue(async () => {
      try {
        await writeFileAtomic(request.path, module.source);
        state.message = { text: `saved ${request.name}.ts`, tone: "ok" };
      } catch (error) {
        if (state.baseline === saved) state.baseline = previous;
        state.message = { text: errorLine(error), tone: "error" };
      }
      render();
    });
  };

  const applyEffect = (effect: EditorEffect): void => {
    if (effect === "send") send();
    else if (effect === "save") save();
    else if (effect === "form-body") {
      state.message = { text: "form bodies are edited in the saved module", tone: "note" };
    }
  };

  const handleKey = (key: ComposerKey): boolean => {
    if (key.ctrl && key.name === "c") return false; // ctrl+c stays a shell-level quit
    const effect = editorKey(editor, key);
    if (effect === null) return false;
    if (effect !== "save") state.message = null; // a message lasts until the next key
    applyEffect(effect);
    render();
    return true;
  };

  const load = (request: LoadedRequest): void => {
    const sameRequest = state.request?.name === request.name;
    state.request = request;
    const draft = draftOf(request);
    loadDraft(editor, draft, sameRequest);
    state.baseline = draftKey(draft);
    if (!sameRequest) {
      state.message = null;
      state.scroll.bodyTop = 0;
    }
    render();
  };

  render();

  return {
    pane,
    get loadedName(): string | null {
      return state.request?.name ?? null;
    },
    get edited(): boolean {
      return dirty();
    },
    get field(): ComposerField {
      return editor.field;
    },
    isEditingText: () => isEditingText(editor),
    load,
    clear(): void {
      state.request = null;
      editor.draft = null;
      state.baseline = "";
      state.message = null;
      render();
    },
    send,
    handleKey,
    syncFocus(focusedPaneId: string | null): void {
      const focused = focusedPaneId === COMPOSER_PANE_ID;
      if (focused === state.focused) return;
      state.focused = focused;
      render();
    },
    settled: () => tail,
  };
}
