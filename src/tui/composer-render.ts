import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { CliRenderer, MouseEvent } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { COMPOSER_TABS } from "./composer-editor.ts";
import type { ComposerTab, EditorState } from "./composer-editor.ts";
import type { ComposerFx } from "./composer-fx.ts";
import { mountContent, type LiveParts } from "./composer-mount.ts";
import { contentLines } from "./composer-render-content.ts";
import type { RequestDraft } from "./composer-send.ts";
import { lineText, withCursor } from "./composer-spans.ts";
import { windowAround } from "./composer-text.ts";
import { halftoneSpinner } from "./fx/spinner.ts";
import { blendHex } from "./motion.ts";
import { renderEmptyState } from "./render.ts";
import { THEME, methodColor } from "./theme.ts";

/**
 * Composer pane rendering: the METHOD ▾ pill, URL field, SEND button,
 * PARAMS/HEADERS/BODY/AUTH strip and the tab content.
 *
 * The pane border is the one frame around the editor: nothing inside it is
 * boxed. METHOD, URL and SEND are one-row filled pills on the element
 * tone; the tab content sits directly under a rule. The focused field
 * (only while the pane itself has focus) takes the accent — an accent-soft
 * fill on METHOD/URL and on the table row, an accent pill on the active
 * tab — and text fields show a block cursor. SEND is the primary button:
 * accent text at rest, filled with the accent while the composer has focus
 * or a send is in flight, when a halftone spinner takes its label. Pills
 * and rows swap to elementHover under the mouse.
 *
 * Every fill and the method's colour go through ComposerFx bindings, so a
 * pulse started by a key keeps running across the rebuild that key causes.
 */

const TAB_LABELS: Record<string, string> = {
  params: "PARAMS",
  headers: "HEADERS",
  body: "BODY",
  auth: "AUTH",
};

/** Fixed widths so cycling the method or starting a send never shifts the URL. */
const METHOD_PILL_WIDTH = 11; // " OPTIONS ▾ "
const SEND_PILL_WIDTH = 10;
const SPINNER_WIDTH = 5;
/** The send row's pills plus the blank row under them. */
const SEND_ROW_ROWS = 2;

/** A one-line composer message: a refusal or a note (successes are toasts). */
export interface ComposerMessage {
  readonly text: string;
  readonly tone: "error" | "note";
}

export interface ComposerRenderState {
  readonly request: LoadedRequest | null;
  readonly editor: EditorState;
  /** The draft differs from the module on disk. */
  readonly dirty: boolean;
  readonly inFlight: boolean;
  /** The composer pane has app focus (field focus is only shown then). */
  readonly focused: boolean;
  readonly message: ComposerMessage | null;
  /** First body line shown; the renderer moves it to keep the cursor in view. */
  readonly scroll: { bodyTop: number };
  readonly fx: ComposerFx;
  /** Whether the mouse is over this fx target now (read at paint time: hover moves without a rebuild). */
  readonly hovered: (target: string) => boolean;
  /** Record which renderable stands for which hover target (filled per render). */
  readonly hoverable: (box: BoxRenderable, target: string) => void;
  readonly live: LiveParts;
  readonly onSendClick: () => void;
  /** A tab label was clicked. */
  readonly onTabClick: (tab: ComposerTab) => void;
}

const MESSAGE_COLORS: Record<ComposerMessage["tone"], string> = {
  error: THEME.color.love,
  note: THEME.color.muted,
};

/** The SEND pill's accent, lifted toward the text colour under the mouse. */
const ACCENT_HOVER = blendHex(THEME.color.accent, THEME.color.text, 0.3);

export function renderComposerPane(renderer: CliRenderer, pane: BoxRenderable, state: ComposerRenderState): void {
  const draft = state.editor.draft;
  if (state.request === null || draft === null) {
    pane.title = "COMPOSER";
    // The one shared empty-state style: what is missing plus the way out.
    renderEmptyState(renderer, pane, [
      { text: "no request loaded", tone: "message" },
      { text: "click a request in collections, or ↑↓ and ⏎", tone: "hint" },
    ]);
    return;
  }

  const title = `COMPOSER · ${state.request.name}.ts`;
  pane.title = state.dirty ? `${title} ●` : title;
  if (!state.dirty && state.fx.running("dot")) pane.add(fadingDot(renderer, state.fx, title));
  pane.add(sendRow(renderer, pane, state, draft));
  pane.add(tabStrip(renderer, state));
  // A single rule under the strip instead of a second bordered box.
  pane.add(
    new BoxRenderable(renderer, { border: ["top"], borderColor: THEME.color.border, height: 1, width: "100%", flexShrink: 0 }),
  );
  const content = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
    // One cell in from the frame, level with the pills and the tab strip.
    paddingLeft: 1,
  });
  const active = state.focused && state.editor.field === "content";
  const lines = contentLines({
    editor: state.editor,
    active,
    scroll: state.scroll,
    visibleLines: visibleContentLines(pane, state.message !== null),
    width: pane.width - 3, // frame (2) + the content's left padding
  });
  mountContent(renderer, content, lines, {
    fx: state.fx,
    live: state.live,
    hoverable: state.hoverable,
    rowRest: (row) => {
      if (active && state.editor.tab !== "body" && state.editor.table.row === row) return THEME.color.accentSoft;
      return state.hovered(`row:${row}`) ? THEME.color.elementHover : THEME.color.panel;
    },
  });
  pane.add(content);
  if (state.message !== null) {
    pane.add(
      new TextRenderable(renderer, {
        content: state.message.text,
        fg: MESSAGE_COLORS[state.message.tone],
        width: "100%",
        wrapMode: "none",
      }),
    );
  }
}

/**
 * The ● a save just cleared, drawn over the frame where the title had it
 * and fading into the panel while the "dot" pulse runs.
 */
function fadingDot(renderer: CliRenderer, fx: ComposerFx, title: string): TextRenderable {
  const dot = new TextRenderable(renderer, {
    content: " ●",
    position: "absolute",
    top: -1, // onto the top border, inside which children are laid out
    left: Bun.stringWidth(title) + 1, // the title starts one cell in from the corner
    fg: THEME.color.text,
    bg: THEME.color.panel, // the space must cover the frame line under it
  });
  fx.bind("dot", () => THEME.color.panel, color => {
    dot.fg = color;
  });
  return dot;
}

/** Content rows left inside the frame: border, send row and its gap, strip, rule, message. */
function visibleContentLines(pane: BoxRenderable, hasMessage: boolean): number {
  if (pane.height <= 0) return Number.POSITIVE_INFINITY; // not laid out yet
  return Math.max(1, pane.height - 2 - SEND_ROW_ROWS - 1 - 1 - (hasMessage ? 1 : 0));
}

/** A pill's fill: accent-soft while its field has the keys, hover or the element tone otherwise. */
function pillRest(state: ComposerRenderState, target: "method" | "url"): string {
  if (state.focused && state.editor.field === target) return THEME.color.accentSoft;
  return state.hovered(target) ? THEME.color.elementHover : THEME.color.element;
}

/** Bind a box's fill to an fx target and make it a hover target. */
function bindFill(state: ComposerRenderState, box: BoxRenderable, target: string, rest: () => string): void {
  state.fx.bind(target, rest, color => {
    box.backgroundColor = color;
  });
  state.hoverable(box, target);
}

/** The mockup's first row: METHOD ▾, URL field, SEND button, as filled pills. */
function sendRow(renderer: CliRenderer, pane: BoxRenderable, state: ComposerRenderState, draft: RequestDraft): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    gap: 1,
    width: "100%",
    height: 1,
    flexShrink: 0,
    marginBottom: SEND_ROW_ROWS - 1,
  });
  const field = state.focused ? state.editor.field : null;

  const method = draft.method.toUpperCase();
  const methodPill = new BoxRenderable(renderer, { flexDirection: "row", paddingX: 1, width: METHOD_PILL_WIDTH });
  bindFill(state, methodPill, "method", () => pillRest(state, "method"));
  const label = new TextRenderable(renderer, { content: method, attributes: TextAttributes.BOLD });
  state.fx.bind("method:label", () => methodColor(method), color => {
    label.fg = color;
  });
  methodPill.add(label);
  methodPill.add(new TextRenderable(renderer, { content: " ▾", fg: field === "method" ? THEME.color.accent : THEME.color.muted }));
  row.add(methodPill);

  const urlPill = new BoxRenderable(renderer, { flexGrow: 1, paddingX: 1 });
  bindFill(state, urlPill, "url", () => pillRest(state, "url"));
  urlPill.add(urlText(renderer, pane, draft.url, field === "url" ? state.editor.urlCursor : null));
  row.add(urlPill);

  row.add(sendPill(renderer, state));
  return row;
}

/**
 * SEND: pressed (accent fill, bg-coloured label) while the composer has
 * focus or a send is in flight; during the send a halftone spinner takes
 * the label. The spinner lives in state.live so a rebuild never restarts it.
 */
function sendPill(renderer: CliRenderer, state: ComposerRenderState): BoxRenderable {
  const pressed = state.focused || state.inFlight;
  const pill = new BoxRenderable(renderer, { alignItems: "center", justifyContent: "center", width: SEND_PILL_WIDTH });
  bindFill(state, pill, "send", () => {
    if (pressed) return state.hovered("send") ? ACCENT_HOVER : THEME.color.accent;
    return state.hovered("send") ? THEME.color.elementHover : THEME.color.element;
  });
  pill.onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    // After the event has bubbled on to the pane (click-to-focus): the send
    // rebuilds the pane, and a destroyed pill would stop the bubbling.
    queueMicrotask(state.onSendClick);
  };
  if (state.inFlight) {
    state.live.spinner ??= halftoneSpinner(renderer, { width: SPINNER_WIDTH, color: THEME.color.bg });
    pill.add(state.live.spinner);
  } else {
    pill.add(
      new TextRenderable(renderer, {
        content: "SEND",
        fg: pressed ? THEME.color.bg : THEME.color.accent,
        attributes: TextAttributes.BOLD,
      }),
    );
  }
  return pill;
}

/** The URL, scrolled so the cursor stays in view while it is edited. */
function urlText(renderer: CliRenderer, pane: BoxRenderable, url: string, cursor: number | null): TextRenderable {
  if (cursor === null) {
    return new TextRenderable(renderer, { content: url === "" ? " " : url, fg: THEME.color.text, width: "100%", wrapMode: "none" });
  }
  // Frame, the two fixed pills, the gaps, and the URL pill's own padding.
  const width = pane.width > 0 ? pane.width - 2 - METHOD_PILL_WIDTH - SEND_PILL_WIDTH - 2 - 2 : 0;
  const shown = windowAround(url, cursor, width);
  return lineText(renderer, withCursor([{ text: shown.text, fg: THEME.color.text }], shown.cursor));
}

/**
 * The tab strip: the active tab underlined in the accent (the mockup);
 * while the strip itself has focus the active tab becomes an accent pill.
 * Each label sits on its own box so a tab switch can hand the pill's fill
 * from the old tab to the new one.
 */
function tabStrip(renderer: CliRenderer, state: ComposerRenderState): BoxRenderable {
  const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 2, width: "100%", paddingX: 1, flexShrink: 0 });
  const stripFocused = state.focused && state.editor.field === "tabs";
  for (const tab of COMPOSER_TABS) {
    const active = tab === state.editor.tab;
    const pill = active && stripFocused;
    const box = new BoxRenderable(renderer, {});
    box.onMouseDown = (event: MouseEvent): void => {
      if (event.button === 0) state.onTabClick(tab);
    };
    state.fx.bind(`tab:${tab}`, () => (pill ? THEME.color.accent : THEME.color.panel), color => {
      box.backgroundColor = color;
    });
    let fg: string = THEME.color.muted;
    if (active) fg = pill ? THEME.color.bg : THEME.color.accent;
    let attributes = TextAttributes.NONE;
    if (active) attributes = pill ? TextAttributes.BOLD : TextAttributes.BOLD | TextAttributes.UNDERLINE;
    box.add(new TextRenderable(renderer, { content: TAB_LABELS[tab] ?? tab, fg, attributes }));
    row.add(box);
  }
  return row;
}
