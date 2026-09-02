import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { RequestDraft } from "./composer-send.ts";
import { isCredentialHeader, redactHeaders } from "../send/redact.ts";
import type { LoadedRequest } from "../gen/load.ts";
import { isMutatingMethod } from "./collection-groups.ts";
import { numberedLines, renderEmptyState, tabsRow } from "./render.ts";
import type { ComposerTab } from "./composer.ts";
import { THEME } from "./theme.ts";

/**
 * Composer pane rendering: the mockup's method display, URL field, SEND
 * button, PARAMS/HEADERS/BODY/AUTH tabs and the line-numbered body editor.
 *
 * REDACTION at rest: header values shown in the HEADERS and AUTH tabs go
 * through the pipeline's redactHeaders — a hand-edited module carrying a
 * literal credential renders as [redacted], identical to the CLI's request
 * view. Env refs are shown as $NAMES (never resolved): values resolve only
 * at send time, inside the pipeline (rule_env_resolve_at_send).
 */

const COMPOSER_TAB_LABELS = ["PARAMS", "HEADERS", "BODY", "AUTH"] as const;

export const COMPOSER_RENDER_TABS = ["params", "headers", "body", "auth"] as const;

export interface ComposerRenderState {
  readonly request: LoadedRequest | null;
  readonly draft: RequestDraft | null;
  readonly edited: boolean;
  readonly tab: ComposerTab;
  readonly editing: "url" | "body" | null;
  readonly inFlight: boolean;
}

export function renderComposerPane(
  renderer: CliRenderer,
  pane: BoxRenderable,
  state: ComposerRenderState,
): void {
  if (state.request === null || state.draft === null) {
    pane.title = "COMPOSER";
    // The one shared empty-state style: what is missing plus the way out.
    renderEmptyState(renderer, pane, [
      { text: "no request loaded", tone: "text" },
      { text: "select one in collections (⏎)", tone: "dim" },
    ]);
    return;
  }

  pane.title = `COMPOSER · ${state.request.name}.ts${state.edited ? " · edited" : ""}`;
  pane.add(sendRow(renderer, state));
  pane.add(tabsRow(renderer, COMPOSER_TAB_LABELS, tabIndexOf(state.tab), THEME.color.accent));
  pane.add(hintRow(renderer, state));
  pane.add(fieldView(renderer, state));
}

function tabIndexOf(tab: ComposerTab): number {
  if (tab === "params") return 0;
  if (tab === "headers") return 1;
  if (tab === "body") return 2;
  return 3;
}

/** The mockup's first row: method display, URL field, SEND button. */
function sendRow(renderer: CliRenderer, state: ComposerRenderState): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    gap: 1,
    width: "100%",
  });

  const draft = state.draft as RequestDraft;
  const method = draft.method.toUpperCase();
  const mutating = isMutatingMethod(method);
  const methodBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.bg,
    alignItems: "center",
    justifyContent: "center",
  });
  methodBox.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(mutating ? THEME.color.accent : THEME.color.dim)(method)),
        fg(THEME.color.dim)(" ▾"),
      ]),
    }),
  );
  row.add(methodBox);

  const urlBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: state.editing === "url" ? THEME.color.accent : THEME.color.border,
    backgroundColor: THEME.color.bg,
    flexGrow: 1,
    paddingX: 1,
  });
  const urlText =
    state.editing === "url" ? `${draft.url}▌` : draft.url;
  urlBox.add(
    new TextRenderable(renderer, {
      content: urlText === "" ? " " : urlText,
      fg: state.editing === "url" ? THEME.color.bright : THEME.color.text,
      width: "100%",
    }),
  );
  row.add(urlBox);

  const sendBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: state.inFlight ? THEME.color.border : THEME.color.accent,
    backgroundColor: THEME.color.bg,
    alignItems: "center",
    justifyContent: "center",
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

/** One dim line of composer keys, so the pane explains itself like the status bar does. */
function hintRow(renderer: CliRenderer, state: ComposerRenderState): BoxRenderable {
  const hints =
    state.editing !== null
      ? "type to edit · backspace deletes · ⏎ done · esc cancel"
      : "h/l tabs · u edit url · b edit body · ⏎ send";
  const row = new BoxRenderable(renderer, { width: "100%" });
  row.add(new TextRenderable(renderer, { content: hints, fg: THEME.color.dim }));
  return row;
}

/** The active tab's field region. */
function fieldView(renderer: CliRenderer, state: ComposerRenderState): BoxRenderable {
  const draft = state.draft as RequestDraft;
  const box = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: state.editing === "body" ? THEME.color.accent : THEME.color.border,
    backgroundColor: THEME.color.bg,
    title: state.tab.toUpperCase(),
    titleColor: THEME.color.bright,
  });

  if (state.tab === "params") paramsView(renderer, box, draft);
  if (state.tab === "headers") headersView(renderer, box, draft);
  if (state.tab === "body") bodyView(renderer, box, state);
  if (state.tab === "auth") authView(renderer, box, draft);
  return box;
}

function paramsView(renderer: CliRenderer, box: BoxRenderable, draft: RequestDraft): void {
  let parsed: URL;
  try {
    parsed = new URL(draft.url);
  } catch {
    box.add(plainText(renderer, "(url does not parse)"));
    return;
  }
  const entries = [...parsed.searchParams.entries()];
  if (entries.length === 0) {
    box.add(plainText(renderer, "(no params)"));
    return;
  }
  for (const [name, value] of entries) {
    box.add(new TextRenderable(renderer, { content: `  ${name} = ${value}`, fg: THEME.color.text }));
  }
}

function headersView(renderer: CliRenderer, box: BoxRenderable, draft: RequestDraft): void {
  const names = Object.keys(draft.headers);
  if (names.length === 0) {
    box.add(plainText(renderer, "(no headers)"));
    return;
  }
  const entries = names.map(name => [name, draft.headers[name] ?? ""] as [string, string]);
  // Structural redaction, same function the pipeline's views use: a literal
  // credential in a hand-edited module still renders as the fixed marker.
  for (const [name, value] of redactHeaders(entries)) {
    box.add(new TextRenderable(renderer, { content: `  ${name}: ${value}`, fg: THEME.color.text }));
  }
}

function bodyView(renderer: CliRenderer, box: BoxRenderable, state: ComposerRenderState): void {
  const draft = state.draft as RequestDraft;
  if (draft.body === null) {
    box.add(plainText(renderer, "(no body)"));
    return;
  }
  if (typeof draft.body === "string") {
    const text = state.editing === "body" ? `${draft.body}▌` : draft.body;
    for (const row of numberedLines(renderer, text, THEME.color.text)) box.add(row);
    return;
  }
  for (const entry of draft.body) {
    const value = entry.file !== undefined ? `@${entry.file}` : (entry.value ?? "");
    box.add(new TextRenderable(renderer, { content: `  ${entry.name} = ${value}`, fg: THEME.color.text }));
  }
}

function authView(renderer: CliRenderer, box: BoxRenderable, draft: RequestDraft): void {
  const entries = Object.keys(draft.headers)
    .map(name => [name, draft.headers[name] ?? ""] as [string, string])
    .filter(([name]) => isCredentialHeader(name));
  if (entries.length === 0) {
    box.add(plainText(renderer, "(no credential headers — add one in the module)"));
    return;
  }
  for (const [name, value] of redactHeaders(entries)) {
    box.add(new TextRenderable(renderer, { content: `  ${name}: ${value}`, fg: THEME.color.text }));
  }
}

function plainText(renderer: CliRenderer, text: string): TextRenderable {
  return new TextRenderable(renderer, { content: `  ${text}`, fg: THEME.color.text });
}
