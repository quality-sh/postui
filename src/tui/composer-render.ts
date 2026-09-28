import { BoxRenderable, StyledText, TextRenderable, bg, bold, fg, underline } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { isMutatingMethod } from "./collection-groups.ts";
import { COMPOSER_TABS } from "./composer-editor.ts";
import type { EditorState } from "./composer-editor.ts";
import { cursorChunks, renderContent } from "./composer-render-content.ts";
import type { RequestDraft } from "./composer-send.ts";
import { windowAround } from "./composer-text.ts";
import { renderEmptyState } from "./render.ts";
import { THEME } from "./theme.ts";

/**
 * Composer pane rendering: the mockup's METHOD ▾ box, URL field, SEND
 * button, PARAMS/HEADERS/BODY/AUTH strip and the tab content.
 *
 * The pane border is the one frame around the editor: the tab content sits
 * directly inside it under a rule, never in a box of its own. The focused
 * field (only while the pane itself has focus) takes the accent — a pink
 * border on METHOD/URL, a pink pill on the active tab, a ▸ on the table
 * row — and text fields show a block cursor. Redaction rules for header
 * values live in composer-render-content.ts.
 */

const TAB_LABELS: Record<string, string> = {
  params: "PARAMS",
  headers: "HEADERS",
  body: "BODY",
  auth: "AUTH",
};

/** Fixed widths so cycling the method or starting a send never shifts the URL. */
const METHOD_BOX_WIDTH = 11; // "OPTIONS ▾" plus the border
const SEND_BOX_WIDTH = 10; // "SENDING…" plus the border

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
  ok: THEME.color.bright,
  error: THEME.color.accent,
  note: THEME.color.dim,
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
      { text: "no request loaded", tone: "text" },
      { text: "select one in collections (⏎)", tone: "dim" },
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
  });
  renderContent(renderer, content, {
    editor: state.editor,
    active: state.focused && state.editor.field === "content",
    scroll: state.scroll,
    visibleLines: visibleContentLines(pane, state.message !== null),
    width: pane.width - 2,
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

/** Content rows left inside the frame: border, send row, strip, rule, message. */
function visibleContentLines(pane: BoxRenderable, hasMessage: boolean): number {
  if (pane.height <= 0) return Number.POSITIVE_INFINITY; // not laid out yet
  return Math.max(1, pane.height - 2 - 3 - 1 - 1 - (hasMessage ? 1 : 0));
}

/** The mockup's first row: METHOD ▾, URL field, SEND button. */
function sendRow(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ComposerRenderState,
  draft: RequestDraft,
): BoxRenderable {
  const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, width: "100%" });
  const field = state.focused ? state.editor.field : null;

  const method = draft.method.toUpperCase();
  const methodBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: field === "method" ? THEME.color.accent : THEME.color.border,
    backgroundColor: THEME.color.bg,
    alignItems: "center",
    justifyContent: "center",
    width: METHOD_BOX_WIDTH,
  });
  methodBox.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(isMutatingMethod(method) ? THEME.color.accent : THEME.color.dim)(method)),
        fg(field === "method" ? THEME.color.accent : THEME.color.dim)(" ▾"),
      ]),
    }),
  );
  row.add(methodBox);

  const urlBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: field === "url" ? THEME.color.accent : THEME.color.border,
    backgroundColor: THEME.color.bg,
    flexGrow: 1,
    paddingX: 1,
  });
  urlBox.add(urlText(renderer, pane, draft.url, field === "url" ? state.editor.urlCursor : null));
  row.add(urlBox);

  const sendBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: state.inFlight ? THEME.color.border : THEME.color.accent,
    backgroundColor: THEME.color.bg,
    alignItems: "center",
    justifyContent: "center",
    width: SEND_BOX_WIDTH,
  });
  sendBox.add(
    new TextRenderable(renderer, {
      content: state.inFlight ? "SENDING…" : "SEND",
      fg: state.inFlight ? THEME.color.dim : THEME.color.accent,
    }),
  );
  row.add(sendBox);
  return row;
}

/** The URL, scrolled so the cursor stays in view while it is edited. */
function urlText(renderer: CliRenderer, pane: BoxRenderable, url: string, cursor: number | null): TextRenderable {
  if (cursor === null) {
    return new TextRenderable(renderer, { content: url === "" ? " " : url, fg: THEME.color.text, width: "100%", wrapMode: "none" });
  }
  // Frame, the two fixed boxes, the gaps, and the URL box's own border + padding.
  const width = pane.width > 0 ? pane.width - 2 - METHOD_BOX_WIDTH - SEND_BOX_WIDTH - 2 - 4 : 0;
  const shown = windowAround(url, cursor, width);
  return new TextRenderable(renderer, {
    content: new StyledText(cursorChunks(shown.text, shown.cursor, THEME.color.bright)),
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
    if (tab !== state.editor.tab) content = new StyledText([fg(THEME.color.text)(label)]);
    else if (stripFocused) content = new StyledText([bold(bg(THEME.color.accent)(fg(THEME.color.bg)(label)))]);
    else content = new StyledText([underline(bold(fg(THEME.color.accent)(label)))]);
    row.add(new TextRenderable(renderer, { content }));
  }
  return row;
}
