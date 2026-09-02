import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, TextChunk } from "@opentui/core";
import { COLLECTIONS_PANE_ID, startCollectionsPane } from "./collections.ts";
import type { CollectionsPane } from "./collections.ts";
import { FocusRegistry } from "./focus.ts";
import { GLOBAL_KEYS, globalAction } from "./keymap.ts";
import type { KeyHint, ParsedKeyLike } from "./keymap.ts";
import { THEME } from "./theme.ts";

export { COLLECTIONS_PANE_ID };

export interface ShellOptions {
  /** Name shown centered in the header (the workspace the CLI runs in). */
  readonly workspaceName: string;
  /** Environment badge shown at the header's right edge. */
  readonly envBadge: string;
  /** The workspace's requests folder; the collections pane re-reads it on focus. */
  readonly requestsDir: string;
}

/** A started shell attached to a renderer. */
export interface Shell {
  /** App-level pane focus; the shell keeps its border state in sync. */
  readonly focus: FocusRegistry;
  /** The collections pane (request tree, navigation, preview). */
  readonly collections: CollectionsPane;
  /** Resolves once a quit key was pressed. */
  readonly onQuit: Promise<"quit">;
  /** Detach the shell's key listener (renderer.destroy() handles the rest). */
  dispose(): void;
}

/**
 * Build the application shell on a renderer: header bar, collections pane
 * (request tree with preview), status bar. Runs on the real renderer from
 * createCliRenderer() and on the headless createTestRenderer() alike.
 *
 * Pane focus is owned by the FocusRegistry: the shell paints the focused
 * pane's border in the accent color (the mockup's selected-bar treatment).
 * OpenTUI's native focusable/focusedBorderColor machinery stays unused so
 * there is exactly one source of focus truth. Keys the focused pane owns
 * (j/k, enter in collections) are offered to the pane first; everything
 * else falls through to the global map.
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
  const mainRegion = buildMainRegion(renderer);
  const collections = startCollectionsPane(renderer, {
    requestsDir: options.requestsDir,
    mainRegion,
  });
  body.add(collections.pane);
  body.add(mainRegion);
  root.add(body);

  root.add(buildStatusBar(renderer));

  focus.register(COLLECTIONS_PANE_ID);
  const panes: Record<string, BoxRenderable> = { [COLLECTIONS_PANE_ID]: collections.pane };
  const repaintFocus = (): void => applyFocus(focus, panes);
  repaintFocus();

  let requestQuit: (() => void) | null = null;
  const onQuit = new Promise<"quit">((resolve) => {
    requestQuit = () => resolve("quit");
  });

  const keyListener = (key: ParsedKeyLike): void => {
    if (focus.focused === COLLECTIONS_PANE_ID && collections.handleKey(key)) return;
    const action = globalAction(key);
    if (action === "quit") requestQuit?.();
    else if (action === "focus-next") {
      focus.cycle();
      repaintFocus();
      collections.syncFocus(focus.focused);
    } else if (action === "focus-previous") {
      focus.cycleBack();
      repaintFocus();
      collections.syncFocus(focus.focused);
    }
  };
  renderer.keyInput.on("keypress", keyListener);

  return {
    focus,
    collections,
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

function buildMainRegion(renderer: CliRenderer): BoxRenderable {
  // Hosts the selected request's preview (rendered by the collections
  // controller); later tickets add the composer and response panes.
  // Borderless when empty: a framed box would promise content that the
  // workspace does not have.
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
