import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { clearChildren, numberedLines } from "./render.ts";
import { THEME } from "./theme.ts";

/** Which text field of the import prompt has the keys. */
export type ImportField = "curl" | "name";

/** Everything the import prompt paints; the controller owns the state. */
export interface ImportView {
  readonly curl: string;
  readonly name: string;
  readonly field: ImportField;
  /** The inline error of the last failed save (the prompt stays open). */
  readonly error: string | null;
  /** True while the save is on disk-bound work; keys are held. */
  readonly busy: boolean;
  /** The name the save pipeline would derive from the curl, when it parses. */
  readonly derivedName: string | null;
}

/** The text cursor drawn at the end of the focused field. */
const CURSOR = "▌";

/**
 * The import prompt as a centered overlay over the body. A curl pasted from
 * docs or a browser's "copy as cURL" runs to several lines of `\`
 * continuations and long header values — far more than the one-row status
 * bar the search palette borrows — and a parse error has to sit next to the
 * text it is about, so the prompt gets its own frame.
 */
export function importOverlay(renderer: CliRenderer): BoxRenderable {
  return new BoxRenderable(renderer, {
    position: "absolute",
    top: "12%",
    left: "10%",
    width: "80%",
    height: "76%",
    zIndex: 100,
    visible: false,
    flexDirection: "column",
    gap: 1,
    paddingX: 1,
    border: true,
    borderColor: THEME.color.accent,
    title: "IMPORT CURL",
    titleColor: THEME.color.bright,
    backgroundColor: THEME.color.bg,
  });
}

/** Repaint the overlay's content for the current prompt state. */
export function renderImportPrompt(
  renderer: CliRenderer,
  pane: BoxRenderable,
  view: ImportView,
): void {
  clearChildren(pane);
  pane.add(nameRow(renderer, view));
  pane.add(curlBox(renderer, view));
  if (view.error !== null) {
    pane.add(
      new TextRenderable(renderer, {
        content: new StyledText([
          bold(fg(THEME.color.accent)("✗ ")),
          fg(THEME.color.accent)(view.error),
        ]),
        width: "100%",
      }),
    );
  }
  pane.add(
    new TextRenderable(renderer, {
      content: view.busy ? "saving…" : "⏎ save · tab name/curl · ^u clear · esc cancel",
      fg: THEME.color.dim,
    }),
  );
}

/** Field label: bright while it has the keys, dim otherwise. */
function label(text: string, focused: boolean): TextChunk {
  return focused ? bold(fg(THEME.color.bright)(text)) : fg(THEME.color.dim)(text);
}

/** `name  create-user▌` — empty shows the name the pipeline would derive. */
function nameRow(renderer: CliRenderer, view: ImportView): TextRenderable {
  const focused = view.field === "name";
  const chunks = [label("name  ", focused), fg(THEME.color.bright)(view.name)];
  if (focused) chunks.push(fg(THEME.color.accent)(CURSOR));
  if (view.name === "") {
    chunks.push(
      fg(THEME.color.dim)(
        view.derivedName === null ? " derived from the URL" : ` ${view.derivedName} (derived from the URL)`,
      ),
    );
  }
  return new TextRenderable(renderer, { content: new StyledText(chunks) });
}

/**
 * The curl text in the shared line-numbered block, bordered like the other
 * editors (accent while focused). Lines past the frame's height are held
 * back with the block's own honest count.
 */
function curlBox(renderer: CliRenderer, view: ImportView): BoxRenderable {
  const focused = view.field === "curl";
  const box = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: focused ? THEME.color.accent : THEME.color.border,
    title: "curl",
    titleColor: focused ? THEME.color.bright : THEME.color.dim,
  });
  if (view.curl === "" && !focused) {
    box.add(new TextRenderable(renderer, { content: "paste a curl command", fg: THEME.color.dim }));
    return box;
  }
  if (view.curl === "") {
    box.add(
      new TextRenderable(renderer, {
        content: new StyledText([
          fg(THEME.color.accent)(CURSOR),
          fg(THEME.color.dim)(" paste a curl command — \\ line continuations are fine"),
        ]),
      }),
    );
    return box;
  }
  const text = focused ? `${view.curl}${CURSOR}` : view.curl;
  // The overlay's rows (76% of the screen) minus the name row, gaps,
  // error, hint, and both frames' borders.
  const maxLines = Math.max(3, Math.floor(renderer.height * 0.76) - 11);
  for (const line of numberedLines(renderer, text, THEME.color.text, maxLines)) box.add(line);
  return box;
}
