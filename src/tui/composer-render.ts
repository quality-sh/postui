import { BoxRenderable, StyledText, TextRenderable, bg, bold, fg, underline } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { COMPOSER_TABS } from "./composer-editor.ts";
import type { EditorState } from "./composer-editor.ts";
import { cursorChunks, renderContent } from "./composer-render-content.ts";
import type { RequestDraft } from "./composer-send.ts";
import { windowAround } from "./composer-text.ts";
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
 * fill on METHOD/URL, an accent pill on the active tab, a ▸ on the table
 * row — and text fields show a block cursor. SEND is the primary button:
 * accent text at rest, filled with the accent (bg-colored label) while the
 * composer has focus or a send is in flight. Redaction rules for header
 * values live in composer-render-content.ts.
 */

const TAB_LABELS: Record<string, string> = {
  params: "PARAMS",
  headers: "HEADERS",
  body: "BODY",
  auth: "AUTH",
};

/** Fixed widths so cycling the method or starting a send never shifts the URL. */
const METHOD_PILL_WIDTH = 11; // " OPTIONS ▾ "
const SEND_PILL_WIDTH = 10; // " SENDING… "
/** The send row's pills plus the blank row under them. */
const SEND_ROW_ROWS = 2;

/** A one-line composer message: save confirmation, refusal, or a note. */
export interface ComposerMessage {
  readonly text: string;
  readonly tone: "ok" | "error" | "note";
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
}

const MESSAGE_COLORS: Record<ComposerMessage["tone"], string> = {
  ok: THEME.color.foam,
  error: THEME.color.love,
  note: THEME.color.muted,
};

export function renderComposerPane(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ComposerRenderState,
): void {
  const draft = state.editor.draft;
  if (state.request === null || draft === null) {
    pane.title = "COMPOSER";
    // The one shared empty-state style: what is missing plus the way out.
    renderEmptyState(renderer, pane, [
      { text: "no request loaded", tone: "message" },
      { text: "select one in collections (⏎)", tone: "hint" },
    ]);
    return;
  }

  pane.title = `COMPOSER · ${state.request.name}.ts${state.dirty ? " ●" : ""}`;
  pane.add(sendRow(renderer, pane, state, draft));
  pane.add(tabStrip(renderer, state));
  // A single rule under the strip instead of a second bordered box.
  pane.add(
    new BoxRenderable(renderer, { border: ["top"], borderColor: THEME.color.border, height: 1, width: "100%" }),
  );
  const content = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
    overflow: "hidden",
    // One cell in from the frame, level with the pills and the tab strip.
    paddingLeft: 1,
  });
  renderContent(renderer, content, {
    editor: state.editor,
    active: state.focused && state.editor.field === "content",
    scroll: state.scroll,
    visibleLines: visibleContentLines(pane, state.message !== null),
    width: pane.width - 3, // frame (2) + the content's left padding
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

/** Content rows left inside the frame: border, send row and its gap, strip, rule, message. */
function visibleContentLines(pane: BoxRenderable, hasMessage: boolean): number {
  if (pane.height <= 0) return Number.POSITIVE_INFINITY; // not laid out yet
  return Math.max(1, pane.height - 2 - SEND_ROW_ROWS - 1 - 1 - (hasMessage ? 1 : 0));
}

/** The mockup's first row: METHOD ▾, URL field, SEND button, as filled pills. */
function sendRow(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ComposerRenderState,
  draft: RequestDraft,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    gap: 1,
    width: "100%",
    height: 1,
    marginBottom: SEND_ROW_ROWS - 1,
  });
  const field = state.focused ? state.editor.field : null;

  const method = draft.method.toUpperCase();
  const methodPill = new BoxRenderable(renderer, {
    backgroundColor: pillFill(field === "method"),
    paddingX: 1,
    width: METHOD_PILL_WIDTH,
  });
  methodPill.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(methodColor(method))(method)),
        fg(field === "method" ? THEME.color.accent : THEME.color.muted)(" ▾"),
      ]),
    }),
  );
  row.add(methodPill);

  const urlPill = new BoxRenderable(renderer, {
    backgroundColor: pillFill(field === "url"),
    flexGrow: 1,
    paddingX: 1,
  });
  urlPill.add(urlText(renderer, pane, draft.url, field === "url" ? state.editor.urlCursor : null));
  row.add(urlPill);

  // Pressed look while the composer has focus (enter sends from here) or a
  // send is in flight; the accent label on the element tone otherwise.
  const pressed = state.focused || state.inFlight;
  const sendPill = new BoxRenderable(renderer, {
    backgroundColor: pressed ? THEME.color.accent : THEME.color.element,
    alignItems: "center",
    justifyContent: "center",
    width: SEND_PILL_WIDTH,
  });
  sendPill.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(pressed ? THEME.color.bg : THEME.color.accent)(state.inFlight ? "SENDING…" : "SEND")),
      ]),
    }),
  );
  row.add(sendPill);
  return row;
}

/** A pill's fill: accent-soft while its field has the keys, the element tone otherwise. */
function pillFill(focused: boolean): string {
  return focused ? THEME.color.accentSoft : THEME.color.element;
}

/** The URL, scrolled so the cursor stays in view while it is edited. */
function urlText(renderer: CliRenderer, pane: BoxRenderable, url: string, cursor: number | null): TextRenderable {
  if (cursor === null) {
    return new TextRenderable(renderer, { content: url === "" ? " " : url, fg: THEME.color.text, width: "100%", wrapMode: "none" });
  }
  // Frame, the two fixed pills, the gaps, and the URL pill's own padding.
  const width = pane.width > 0 ? pane.width - 2 - METHOD_PILL_WIDTH - SEND_PILL_WIDTH - 2 - 2 : 0;
  const shown = windowAround(url, cursor, width);
  return new TextRenderable(renderer, {
    content: new StyledText(cursorChunks(shown.text, shown.cursor, THEME.color.text)),
    width: "100%",
    wrapMode: "none",
  });
}

/**
 * The tab strip: the active tab underlined in the accent (the mockup);
 * while the strip itself has focus the active tab becomes an accent pill.
 */
function tabStrip(renderer: CliRenderer, state: ComposerRenderState): BoxRenderable {
  const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 2, width: "100%", paddingX: 1 });
  const stripFocused = state.focused && state.editor.field === "tabs";
  for (const tab of COMPOSER_TABS) {
    const label = TAB_LABELS[tab] ?? tab;
    let content: StyledText;
    if (tab !== state.editor.tab) content = new StyledText([fg(THEME.color.muted)(label)]);
    else if (stripFocused) content = new StyledText([bold(bg(THEME.color.accent)(fg(THEME.color.bg)(label)))]);
    else content = new StyledText([underline(bold(fg(THEME.color.accent)(label)))]);
    row.add(new TextRenderable(renderer, { content }));
  }
  return row;
}
