import { BoxRenderable } from "@opentui/core";
import type { CliRenderer, MouseEvent, Renderable } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { acknowledgeKey, snapshotOf, sweepFocusIn } from "./composer-ack.ts";
import type { RevealTarget } from "./composer-ack.ts";
import { editorKey, isEditingText, loadDraft, newEditorState } from "./composer-editor.ts";
import type { ComposerField, EditorEffect } from "./composer-editor.ts";
import { createComposerFx } from "./composer-fx.ts";
import { detachLive } from "./composer-mount.ts";
import type { DevelopPart } from "./composer-mount.ts";
import { renderComposerPane } from "./composer-render.ts";
import { draftKey, isDirty, runSave, runSend } from "./composer-run.ts";
import type { ComposerState, RunContext, SendDiagnostics } from "./composer-run.ts";
import { draftOf, sendDraft } from "./composer-send.ts";
import type { ComposerKey } from "./composer-text.ts";
import { fxClock } from "./fx/clock.ts";
import { clearChildren } from "./render.ts";
import { THEME } from "./theme.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COMPOSER_PANE_ID = "composer";

export interface ComposerPaneOptions {
  /** Where send feedback and named errors surface (the response pane). */
  readonly diagnostics: SendDiagnostics;
  /** The send pipeline bridge; tests pass a stub. */
  readonly sendDraft?: typeof sendDraft;
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
  /**
   * A bracketed paste: typed into the focused text field as if keyed in.
   * Line breaks survive only in the body (elsewhere Enter would send).
   * False when no text field has the keys.
   */
  paste(text: string): boolean;
  /** Tell the composer which pane has app focus (field focus shows only when it is this one). */
  syncFocus(focusedPaneId: string | null): void;
  /** Resolves when the send or save currently in flight (if any) has settled. */
  settled(): Promise<void>;
}

/**
 * The composer: METHOD, URL, PARAMS/HEADERS/BODY/AUTH and the body editor
 * over an IN-MEMORY draft of a saved request. Keys edit the draft directly
 * (composer-editor.ts); SEND executes it through the real pipeline
 * (sendDraft → sendRequest), never a TUI-local reimplementation; ctrl+s
 * writes it back to its own module in the `postui save` shape
 * (composer-save.ts), refusing literal credentials. Every key that changes
 * something also shows that it landed (composer-ack.ts, composer-run.ts).
 */
export function startComposerPane(renderer: CliRenderer, options: ComposerPaneOptions): ComposerPane {
  const pane = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.color.border,
    title: "COMPOSER",
    titleColor: THEME.color.text,
    backgroundColor: THEME.color.panel,
  });

  const editor = newEditorState();
  const fx = createComposerFx();
  const state: ComposerState = {
    request: null,
    baseline: "",
    inFlight: false,
    focused: false,
    message: null,
    scroll: { bodyTop: 0 },
    hover: null,
    live: { spinner: null, develop: null },
  };
  /** Which renderable stands for which hover target, rebuilt every render. */
  let hoverables = new Map<Renderable, string>();

  let tail: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const done = tail.then(step, step);
    tail = done;
    return done;
  };

  const render = (): void => {
    detachLive(state.live);
    fx.unbindAll();
    hoverables = new Map();
    clearChildren(pane);
    renderComposerPane(renderer, pane, {
      request: state.request,
      editor,
      dirty: isDirty(ctx),
      inFlight: state.inFlight,
      focused: state.focused,
      message: state.message,
      scroll: state.scroll,
      fx,
      hovered: target => state.hover === target,
      hoverable: (box, target) => hoverables.set(box, target),
      live: state.live,
      onSendClick: () => void send(),
    });
  };

  const ctx: RunContext = {
    state,
    editor,
    fx,
    diagnostics: options.diagnostics,
    sendDraft: options.sendDraft ?? sendDraft,
    render,
    enqueue,
  };
  const send = (bodyWindow?: number): boolean => runSend(ctx, bodyWindow);

  /** Drop a running reveal: the next frame shows the real lines at once. */
  const dropReveal = (): void => {
    state.live.develop?.instance?.destroyRecursively();
    state.live.develop = null;
  };

  /** Start a develop reveal for the next rebuild (never on an instant clock: nothing would run it). */
  const startReveal = (target: RevealTarget): void => {
    dropReveal();
    if (target === null || fxClock().instant) return;
    const part: DevelopPart = {
      target,
      instance: null,
      onDone: () => {
        if (state.live.develop !== part) return;
        state.live.develop = null;
        render();
      },
    };
    state.live.develop = part;
  };

  /** Hover moved between targets (null = off every pill and row). */
  const setHover = (target: string | null): void => {
    if (target === state.hover) return;
    const previous = state.hover;
    state.hover = target;
    if (previous !== null) fx.refresh(previous);
    if (target !== null) fx.refresh(target);
  };
  const hoverTargetOf = (event: MouseEvent): string | null => {
    for (let node: Renderable | null = event.target; node !== null && node !== pane; node = node.parent) {
      const target = hoverables.get(node);
      if (target !== undefined) return target;
    }
    return null;
  };
  // Over/out bubble up from whatever the pointer is on: one pair of handlers
  // covers every pill and row, however often the pane is rebuilt.
  pane.onMouseOver = (event: MouseEvent): void => setHover(hoverTargetOf(event));
  pane.onMouseOut = (): void => setHover(null);

  const applyEffect = (effect: EditorEffect): void => {
    if (effect === "send") send();
    else if (effect === "save") runSave(ctx);
    else if (effect === "form-body") {
      state.message = { text: "form bodies are edited in the saved module", tone: "note" };
    }
  };

  const paste = (text: string): boolean => {
    if (!isEditingText(editor)) return false;
    const before = snapshotOf(editor);
    const multiline = editor.field === "content" && editor.tab === "body";
    for (const ch of text.replace(/\r\n?/g, "\n")) {
      if (ch === "\n" && !multiline) continue;
      editorKey(editor, ch === "\n" ? { name: "return", ctrl: false } : { name: ch, ctrl: false, sequence: ch });
    }
    state.message = null;
    startReveal(acknowledgeKey(fx, before, editor, { name: "paste", ctrl: false }));
    render();
    return true;
  };

  const handleKey = (key: ComposerKey): boolean => {
    if (key.ctrl && key.name === "c") return false; // ctrl+c stays a shell-level quit
    const before = snapshotOf(editor);
    const effect = editorKey(editor, key);
    if (effect === null) return false;
    if (effect !== "save") state.message = null; // a message lasts until the next key
    // A key is its own repaint: any reveal still running gives way to it.
    startReveal(acknowledgeKey(fx, before, editor, key));
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
      dropReveal();
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
      return isDirty(ctx);
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
      dropReveal();
      render();
    },
    send,
    handleKey,
    paste,
    syncFocus(focusedPaneId: string | null): void {
      const focused = focusedPaneId === COMPOSER_PANE_ID;
      if (focused === state.focused) return;
      state.focused = focused;
      if (focused && editor.draft !== null) sweepFocusIn(fx, editor);
      render();
    },
    settled: () => tail,
  };
}
