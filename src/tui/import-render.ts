import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { clearChildren, numberedLines } from "./render.ts";
import { SCRIM, THEME } from "./theme.ts";

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

/** The dialog's share of the screen height; it starts a quarter of the way down. */
const DIALOG_HEIGHT = 0.65;

/** The import overlay: a full-screen scrim, and the dialog on it that the prompt paints. */
export interface ImportOverlay {
  /** Shown and hidden as a whole; add this one to the shell's root. */
  readonly scrim: BoxRenderable;
  /** The rounded panel the prompt's content goes in. */
  readonly dialog: BoxRenderable;
}

/**
 * The import prompt as a dialog over the whole app. A curl pasted from docs
 * or a browser's "copy as cURL" runs to several lines of `\` continuations
 * and long header values — far more than the one-row status bar the search
 * palette borrows — and a parse error has to sit next to the text it is
 * about, so the prompt gets its own frame. As in opencode's ui/dialog.tsx,
 * a translucent black scrim dims everything behind it, and the rounded
 * panel sits a quarter of the way down the screen.
 */
export function importOverlay(renderer: CliRenderer): ImportOverlay {
  const scrim = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    visible: false,
    backgroundColor: SCRIM,
  });
  const dialog = new BoxRenderable(renderer, {
    position: "absolute",
    top: "25%",
    left: "10%",
    width: "80%",
    height: `${DIALOG_HEIGHT * 100}%`,
    flexDirection: "column",
    gap: 1,
    paddingX: 1,
    border: true,
    borderStyle: "rounded",
    // The dialog holds the keys while it is open: the focus color.
    borderColor: THEME.color.accent,
    title: "IMPORT CURL",
    titleColor: THEME.color.text,
    backgroundColor: THEME.color.panel,
  });
  scrim.add(dialog);
  return { scrim, dialog };
}

/** Repaint the dialog's content for the current prompt state. */
export function renderImportPrompt(
  renderer: CliRenderer,
  dialog: BoxRenderable,
  view: ImportView,
): void {
  clearChildren(dialog);
  dialog.add(nameRow(renderer, view));
  dialog.add(curlField(renderer, view));
  if (view.error !== null) {
    dialog.add(
      new TextRenderable(renderer, {
        content: new StyledText([bold(fg(THEME.color.love)("✗ ")), fg(THEME.color.love)(view.error)]),
        width: "100%",
      }),
    );
  }
  dialog.add(
    new TextRenderable(renderer, {
      content: view.busy ? "saving…" : "⏎ save · tab name/curl · ^u clear · esc cancel",
      fg: THEME.color.muted,
    }),
  );
}

/** Field label: bold body text while it has the keys, dim otherwise. */
function label(text: string, focused: boolean): TextChunk {
  return focused ? bold(fg(THEME.color.text)(text)) : fg(THEME.color.dim)(text);
}

/** `name  create-user▌` — empty shows the name the pipeline would derive. */
function nameRow(renderer: CliRenderer, view: ImportView): TextRenderable {
  const focused = view.field === "name";
  const chunks = [label("name  ", focused), fg(THEME.color.text)(view.name)];
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
 * The curl field: its label, then the text in the shared line-numbered
 * block on a filled element-toned area — no inner box. Lines past the
 * dialog's height are held back with the block's own honest count.
 */
function curlField(renderer: CliRenderer, view: ImportView): BoxRenderable {
  const focused = view.field === "curl";
  const field = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%" });
  field.add(new TextRenderable(renderer, { content: new StyledText([label("curl", focused)]) }));
  const area = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
    paddingX: 1,
    backgroundColor: THEME.color.element,
  });
  field.add(area);
  if (view.curl === "" && !focused) {
    area.add(new TextRenderable(renderer, { content: "paste a curl command", fg: THEME.color.dim }));
    return field;
  }
  if (view.curl === "") {
    area.add(
      new TextRenderable(renderer, {
        content: new StyledText([
          fg(THEME.color.accent)(CURSOR),
          fg(THEME.color.dim)(" paste a curl command — \\ line continuations are fine"),
        ]),
      }),
    );
    return field;
  }
  const text = focused ? `${view.curl}${CURSOR}` : view.curl;
  // The dialog's rows minus its frame, the name row, the curl label, the
  // gaps, the error, and the hint.
  const maxLines = Math.max(3, Math.floor(renderer.height * DIALOG_HEIGHT) - 9);
  for (const line of numberedLines(renderer, text, THEME.color.text, maxLines)) area.add(line);
  return field;
}
