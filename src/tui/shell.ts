import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { FocusRegistry } from "./focus.ts";
import { GLOBAL_KEYS, globalAction } from "./keymap.ts";
import type { KeyHint, ParsedKeyLike } from "./keymap.ts";
import { THEME } from "./theme.ts";

/** The collections placeholder pane; the collections ticket fills it. */
export const COLLECTIONS_PANE_ID = "collections";

export interface ShellOptions {
  /** Name shown centered in the header (the workspace the CLI runs in). */
  readonly workspaceName: string;
  /** Environment badge shown at the header's right edge. */
  readonly envBadge: string;
}

/** A started shell attached to a renderer. */
export interface Shell {
  /** App-level pane focus; the shell keeps its border state in sync. */
  readonly focus: FocusRegistry;
  /** Resolves once a quit key was pressed. */
  readonly onQuit: Promise<"quit">;
  /** Detach the shell's key listener (renderer.destroy() handles the rest). */
  dispose(): void;
}

/**
 * Build the application shell on a renderer: header bar, collections
 * placeholder pane, status bar. Runs on the real renderer from
 * createCliRenderer() and on the headless createTestRenderer() alike.
 *
 * Pane focus is owned by the FocusRegistry: the shell paints the focused
 * pane's border in the accent color (the mockup's selected-bar treatment).
 * OpenTUI's native focusable/focusedBorderColor machinery stays unused so
 * there is exactly one source of focus truth; the collections ticket can
 * bridge registry focus to its input renderables if routing needs it.
 */
export function startShell(renderer: CliRenderer, options: ShellOptions): Shell {
  const focus = new FocusRegistry();

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    backgroundColor: THEME.color.bg,
    width: "100%",
    height: "100%",
  });
  renderer.root.add(root);

  root.add(buildHeader(renderer, options));

  const body = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 1,
    backgroundColor: THEME.color.bg,
  });
  const { pane } = buildCollectionsPane(renderer);
  body.add(pane);
  body.add(buildMainRegion(renderer));
  root.add(body);

  root.add(buildStatusBar(renderer));

  const panes: Record<string, BoxRenderable> = {};
  focus.register(COLLECTIONS_PANE_ID);
  panes[COLLECTIONS_PANE_ID] = pane;
  const repaintFocus = (): void => applyFocus(focus, panes);
  repaintFocus();

  let requestQuit: (() => void) | null = null;
  const onQuit = new Promise<"quit">((resolve) => {
    requestQuit = () => resolve("quit");
  });

  const keyListener = (key: ParsedKeyLike): void => {
    const action = globalAction(key);
    if (action === "quit") requestQuit?.();
    else if (action === "focus-next") {
      focus.cycle();
      repaintFocus();
    } else if (action === "focus-previous") {
      focus.cycleBack();
      repaintFocus();
    }
  };
  renderer.keyInput.on("keypress", keyListener);

  return {
    focus,
    onQuit,
    dispose: () => {
      renderer.keyInput.off("keypress", keyListener);
    },
  };
}

/** Paint pane borders: accent for the focused pane, muted for the rest. */
function applyFocus(
  focus: FocusRegistry,
  panes: Record<string, BoxRenderable>,
): void {
  for (const [id, pane] of Object.entries(panes)) {
    pane.borderColor = focus.focused === id ? THEME.color.accent : THEME.color.border;
  }
}

/** Header bar: POSTUI wordmark left, workspace center, env badge right. */
function buildHeader(renderer: CliRenderer, options: ShellOptions): BoxRenderable {
  const header = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    border: true,
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.bg,
    paddingX: 1,
    height: 3,
    width: "100%",
  });

  const left = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    width: "33%",
  });
  left.add(
    new TextRenderable(renderer, {
      content: new StyledText([
        bold(fg(THEME.color.accent)("P O S T U I")),
        fg(THEME.color.dim)("· ˙ · ˙ ·"),
      ]),
    }),
  );
  header.add(left);

  const center = new BoxRenderable(renderer, {
    alignItems: "center",
    justifyContent: "center",
    width: "34%",
  });
  center.add(
    new TextRenderable(renderer, { content: options.workspaceName, fg: THEME.color.text }),
  );
  header.add(center);

  const right = new BoxRenderable(renderer, {
    alignItems: "center",
    justifyContent: "flex-end",
    width: "33%",
  });
  right.add(
    new TextRenderable(renderer, {
      content: new StyledText([bold(fg(THEME.color.accent)(options.envBadge))]),
    }),
  );
  header.add(right);

  return header;
}

function buildCollectionsPane(renderer: CliRenderer): { pane: BoxRenderable } {
  const pane = new BoxRenderable(renderer, {
    width: 30,
    height: "100%",
    border: true,
    borderColor: THEME.color.border,
    title: "COLLECTIONS",
    titleColor: THEME.color.bright,
    backgroundColor: THEME.color.bg,
  });
  const empty = new BoxRenderable(renderer, {
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    width: "100%",
    height: "100%",
    gap: 1,
  });
  empty.add(
    new TextRenderable(renderer, { content: "no saved requests", fg: THEME.color.text }),
  );
  empty.add(
    new TextRenderable(renderer, { content: "save one with", fg: THEME.color.dim }),
  );
  empty.add(
    new TextRenderable(renderer, {
      content: "postui save '<curl>'",
      fg: THEME.color.dim,
    }),
  );
  pane.add(empty);
  return { pane };
}

function buildMainRegion(renderer: CliRenderer): BoxRenderable {
  // Quiet container for the panes later tickets add (preview, composer,
  // response). Intentionally borderless: an empty framed box would promise
  // content that does not exist yet.
  return new BoxRenderable(renderer, {
    flexGrow: 1,
    backgroundColor: THEME.color.bg,
  });
}

function buildStatusBar(renderer: CliRenderer): BoxRenderable {
  const bar = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    border: true,
    borderColor: THEME.color.border,
    backgroundColor: THEME.color.bg,
    height: 3,
    width: "100%",
  });
  bar.add(new TextRenderable(renderer, { content: statusText() }));
  return bar;
}

/** The key map as styled chunks: bright bold keys, muted labels, dim separators. */
function statusText(): StyledText {
  const chunks: TextChunk[] = [];
  for (const [i, hint] of GLOBAL_KEYS.entries()) {
    chunks.push(keySeparator(i - 1), ...keyHintChunks(hint));
  }
  return new StyledText(chunks);
}

function keySeparator(position: number): TextChunk {
  return fg(THEME.color.border)(position < GLOBAL_KEYS.length - 1 ? "  │  " : "");
}

function keyHintChunks(hint: KeyHint): TextChunk[] {
  const display = hint.glyph ?? hint.key;
  return [
    bold(fg(THEME.color.bright)(display)),
    fg(THEME.color.text)(` ${hint.label}`),
  ];
}
