import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { draftCredentialValues, draftOf, sendDraft } from "./composer-send.ts";
import type { RequestDraft } from "./composer-send.ts";
import type { LoadedRequest } from "../gen/load.ts";
import { COMPOSER_RENDER_TABS, renderComposerPane } from "./composer-render.ts";
import type { ComposerRenderState } from "./composer-render.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { clearChildren } from "./render.ts";
import type { SendResult } from "../send/send.ts";
import { THEME } from "./theme.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COMPOSER_PANE_ID = "composer";

export type ComposerTab = "params" | "headers" | "body" | "auth";

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
  /** True when the draft was edited since it was loaded from the module. */
  readonly edited: boolean;
  /** Load a saved request into an in-memory draft (the module stays the source). */
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
  handleKey(key: ParsedKeyLike): boolean;
  /** Resolves when the send currently in flight (if any) has settled. */
  settled(): Promise<void>;
}

type EditTarget = "url" | "body";

/**
 * The composer: the mockup's method display, URL field, PARAMS/HEADERS/BODY/
 * AUTH tabs and line-numbered body editor. Editing is display plus minor
 * field editing of an IN-MEMORY draft — the saved module is never written
 * back and remains the source of truth; a reload from collections resets the
 * draft. SEND executes the draft through the real pipeline (sendDraft →
 * sendRequest), never a TUI-local reimplementation.
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

  const state = {
    request: null as LoadedRequest | null,
    draft: null as RequestDraft | null,
    edited: false, // draft differs from the loaded module (this session)
    tab: "body" as ComposerTab, // the mockup opens on BODY
    editing: null as EditTarget | null,
    editBackup: "",
    inFlight: false,
  };

  let tail: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const done = tail.then(step, step);
    tail = done;
    return done;
  };

  const render = (): void => {
    clearChildren(pane);
    const renderState: ComposerRenderState = {
      request: state.request,
      draft: state.draft,
      edited: state.edited,
      tab: state.tab,
      editing: state.editing,
      inFlight: state.inFlight,
    };
    renderComposerPane(renderer, pane, renderState);
  };

  const startEditing = (target: EditTarget): void => {
    if (state.draft === null) return;
    if (target === "body" && typeof state.draft.body !== "string") {
      // Form and empty bodies are not line-editable; the module is the editor
      // for those — say so instead of failing silently.
      options.diagnostics.showNote("form and empty bodies are edited in the saved module");
      return;
    }
    state.editing = target;
    state.editBackup = target === "url" ? state.draft.url : (state.draft.body as string);
    render();
  };

  const cancelEditing = (): void => {
    if (state.editing === null || state.draft === null) return;
    if (state.editing === "url") state.draft.url = state.editBackup;
    else state.draft.body = state.editBackup;
    state.editing = null;
    render();
  };

  const commitEditing = (): void => {
    if (state.editing === null || state.draft === null) return;
    // Only a real change marks the draft edited (u then enter is a no-op).
    const changed =
      state.editing === "url"
        ? state.draft.url !== state.editBackup
        : (state.draft.body as string) !== state.editBackup;
    if (changed) state.edited = true;
    state.editing = null;
    render();
  };

  const appendToEditing = (text: string): void => {
    if (state.editing === null || state.draft === null) return;
    if (state.editing === "url") state.draft.url += text;
    else state.draft.body = (state.draft.body as string) + text;
    render();
  };

  const backspaceEditing = (): void => {
    if (state.editing === null || state.draft === null) return;
    if (state.editing === "url") state.draft.url = state.draft.url.slice(0, -1);
    else state.draft.body = (state.draft.body as string).slice(0, -1);
    render();
  };

  const stepTab = (delta: 1 | -1): void => {
    const index = COMPOSER_RENDER_TABS.indexOf(state.tab);
    const next = COMPOSER_RENDER_TABS[(index + delta + COMPOSER_RENDER_TABS.length) % COMPOSER_RENDER_TABS.length];
    state.tab = next as ComposerTab;
    render();
  };

  /** Keys while an edit is active; everything is consumed (true) except ctrl. */
  const handleEditingKey = (key: ParsedKeyLike): void => {
    if (key.name === "return" || key.name === "enter") commitEditing();
    else if (key.name === "escape" || key.name === "") cancelEditing(); // a lone ESC byte parses unnamed
    else if (key.name === "backspace") backspaceEditing();
    else if (key.name.length === 1) appendToEditing(key.name);
  };

  const handleKey = (key: ParsedKeyLike): boolean => {
    if (key.ctrl) return false; // ctrl+c must stay a shell-level quit
    if (state.editing !== null) {
      // An active edit consumes every printable key — including "q" and "/",
      // which must never leak to the global map while typing (keymap note).
      handleEditingKey(key);
      return true;
    }
    if (state.draft === null) return false; // nothing loaded: keys fall through
    if (key.name === "return" || key.name === "enter" || key.name === "s") {
      send();
      return true;
    }
    if (key.name === "u" || key.name === "b") {
      startEditing(key.name === "u" ? "url" : "body");
      return true;
    }
    if (key.name === "h" || key.name === "left") {
      stepTab(-1);
      return true;
    }
    if (key.name === "l" || key.name === "right") {
      stepTab(1);
      return true;
    }
    return false;
  };

  const send = (bodyWindow?: number): boolean => {
    const draft = state.draft;
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
    void enqueue(async () => {
      try {
        const { result, latencyMs } = await sendDraft(draft, request.name, bodyWindow);
        options.diagnostics.showResult(result, latencyMs, draftCredentialValues(draft), request.name);
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

  render();

  return {
    pane,
    get loadedName(): string | null {
      return state.request?.name ?? null;
    },
    get edited(): boolean {
      return state.edited;
    },
    load(request: LoadedRequest): void {
      state.request = request;
      state.draft = draftOf(request);
      state.edited = false;
      state.editing = null;
      render();
    },
    clear(): void {
      state.request = null;
      state.draft = null;
      state.edited = false;
      state.editing = null;
      render();
    },
    send,
    handleKey,
    settled: () => tail,
  };
}
