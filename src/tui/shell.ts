import { dirname, join } from "node:path";
import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core";
import type { CliRenderer, MouseEvent } from "@opentui/core";
import { COLLECTIONS_PANE_ID, startCollectionsPane } from "./collections.ts";
import type { CollectionsPane } from "./collections.ts";
import { COMPOSER_PANE_ID, startComposerPane } from "./composer.ts";
import type { ComposerPane } from "./composer.ts";
import { RESPONSE_PANE_ID, startResponsePane } from "./response-pane.ts";
import type { ResponsePane } from "./response-pane.ts";
import { FocusRegistry } from "./focus.ts";
import { globalAction } from "./keymap.ts";
import type { GlobalAction, ParsedKeyLike } from "./keymap.ts";
import { settleBorder, sweepBorder } from "./motion.ts";
import { halftoneBox } from "./render.ts";
import { startStatusBar } from "./status-bar.ts";
import type { SearchBarState, StatusBarMode } from "./status-bar.ts";
import { THEME } from "./theme.ts";

export { COLLECTIONS_PANE_ID, COMPOSER_PANE_ID, RESPONSE_PANE_ID };

export interface ShellOptions {
  /** Name shown centered in the header (the workspace the CLI runs in). */
  readonly workspaceName: string;
  /** Environment badge shown at the header's right edge. */
  readonly envBadge: string;
  /** The workspace's requests folder; the collections pane re-reads it on focus. */
  readonly requestsDir: string;
  /**
   * The workspace's generated-tests folder (TESTS tab). Defaults to the
   * `tests` folder beside the requests folder.
   */
  readonly testsDir?: string;
}

/** A started shell attached to a renderer. */
export interface Shell {
  /** App-level pane focus; the shell keeps its border state in sync. */
  readonly focus: FocusRegistry;
  /** The collections pane (request tree, navigation, search filter). */
  readonly collections: CollectionsPane;
  /** The composer (method, URL, tabs, body editor, send). */
  readonly composer: ComposerPane;
  /** The response pane (status line, BODY/HEADERS/TESTS, diagnostics). */
  readonly response: ResponsePane;
  /** True while the `/` search palette owns the keys. */
  readonly searching: boolean;
  /** Resolves once a quit key was pressed. */
  readonly onQuit: Promise<"quit">;
  /** Detach the shell's key listener (renderer.destroy() handles the rest). */
  dispose(): void;
}

/** Placeholder binding so the status bar can be rebound after full setup. */
const noop = (): void => {};

/**
 * Build the application shell on a renderer: header bar, collections pane
 * (request tree), composer + response region, status bar. Runs on the real
 * renderer from createCliRenderer() and on the headless
 * createTestRenderer() alike.
 *
 * Pane focus is owned by the FocusRegistry: the shell paints the focused
 * pane's border in the accent color (the mockup's selected-bar treatment).
 * OpenTUI's native focusable/focusedBorderColor machinery stays unused so
 * there is exactly one source of focus truth. Keys the focused pane owns
 * (j/k in collections; editing, h/l, enter in the composer; +/- and h/l in
 * the response) are offered to the pane first; everything else falls through
 * to the global map.
 *
 * The `/` search is shell-level: it opens the palette (status bar becomes
 * the query input, collections shows ranked matches), consumes every key
 * while open — including "q" and "/" — and hands enter/arrow keys to the
 * collections pane's filter path. The status bar names the active mode:
 * browsing (key map), searching (query), sending (send in flight).
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
  const testsDir = options.testsDir ?? join(dirname(options.requestsDir), "tests");
  const response = startResponsePane(renderer, {
    testsDir,
    onWindowChange: (window) => composer.send(window),
  });
  // Send-state tracking for the status bar: the composer's diagnostics are
  // the one place a send starts and settles, so the shell watches them.
  let sendInFlight = false;
  let repaintStatusBar: () => void = noop; // rebound once the bar exists
  const composer = startComposerPane(renderer, {
    diagnostics: {
      showSending: () => {
        response.showSending();
        sendInFlight = true;
        repaintStatusBar();
      },
      showResult: (result, latencyMs, extraSecrets, forName) => {
        response.showResult(result, latencyMs, extraSecrets, forName);
        sendInFlight = false;
        repaintStatusBar();
      },
      showError: (error) => {
        response.showError(error);
        sendInFlight = false;
        repaintStatusBar();
      },
      showNote: (text) => response.showNote(text),
    },
  });
  const collections = startCollectionsPane(renderer, {
    requestsDir: options.requestsDir,
    onOpen: (request) => {
      composer.load(request);
      response.setRequestName(request.name);
    },
    onSelectionLost: () => {
      composer.clear();
      response.setRequestName(null);
    },
    onReload: (request) => {
      // The module is the source of truth — unless the user edited the draft
      // this session; in-memory edits are never clobbered by a refresh.
      if (!composer.edited) composer.load(request);
    },
    // Enter on the already-open request sends it (the composer stays the
    // only place a send actually runs; the tree just reaches it).
    onSend: () => composer.send(),
    // A row click is direct manipulation of collections: focus follows.
    onInteract: () => focusPane(COLLECTIONS_PANE_ID),
  });
  const mainRegion = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    backgroundColor: THEME.color.bg,
  });
  mainRegion.add(composer.pane);
  mainRegion.add(response.pane);
  body.add(collections.pane);
  body.add(mainRegion);
  root.add(body);

  const statusBar = startStatusBar(renderer);
  root.add(statusBar.pane);

  /** Search-palette state: open flag plus the query typed so far. */
  const search = { active: false, query: "" };

  let lastPaintedMode: StatusBarMode | null = null;
  repaintStatusBar = (): void => {
    let mode: StatusBarMode = "browsing";
    if (search.active) mode = "searching";
    else if (sendInFlight) mode = "sending";
    const searchBar: SearchBarState = { query: search.query, matchCount: collections.filteredCount };
    statusBar.paint(mode, searchBar);
    // Mode change feedback: a quick accent flash decaying back to the bar.
    if (lastPaintedMode !== null && mode !== lastPaintedMode) {
      sweepBorder(statusBar.pane, THEME.color.accent, THEME.color.border, 220);
    }
    lastPaintedMode = mode;
  };

  const beginSearch = (): void => {
    search.active = true;
    search.query = "";
    collections.beginFilter();
    repaintStatusBar();
  };

  const endSearch = (): void => {
    search.active = false;
    search.query = "";
    collections.endFilter();
    repaintStatusBar();
  };

  /** Append to the query, refresh the matches and the bar, in one place. */
  const typeIntoQuery = (text: string): void => {
    search.query += text;
    collections.setFilterQuery(search.query);
    repaintStatusBar();
  };

  /**
   * Keys while the palette is open: the query editor consumes everything
   * printable (a literal "q" or "/" must type, never quit or re-open),
   * escape goes back to browsing, enter/-arrows drive the match list
   * through the collections pane. Only ctrl combos fall through to the
   * global map (ctrl+c stays the quit).
   */
  const searchKey = (key: ParsedKeyLike): boolean => {
    if (key.ctrl) return false;
    if (key.name === "escape") {
      endSearch();
      return true;
    }
    if (key.name === "") {
      // A lone ESC byte parses unnamed (see composer's editor): escape too.
      endSearch();
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      collections.filterKey(key); // open the highlighted match, pane's own path
      endSearch();
      return true;
    }
    if (key.name === "down" || key.name === "up") {
      collections.filterKey(key);
      return true;
    }
    if (key.name === "backspace") {
      search.query = search.query.slice(0, -1);
      collections.setFilterQuery(search.query);
      repaintStatusBar();
      return true;
    }
    if (key.name === "tab") return true; // focus must not move mid-search
    if (key.name === "space") {
      typeIntoQuery(" ");
      return true;
    }
    // One code POINT (not UTF-16 unit): astral-plane characters type too.
    if ([...key.name].length === 1) {
      typeIntoQuery(key.name);
      return true;
    }
    return true; // other named keys (F1, home, …) are inert while typing
  };

  focus.register(COLLECTIONS_PANE_ID);
  focus.register(COMPOSER_PANE_ID);
  focus.register(RESPONSE_PANE_ID);
  const panes: Record<string, BoxRenderable> = {
    [COLLECTIONS_PANE_ID]: collections.pane,
    [COMPOSER_PANE_ID]: composer.pane,
    [RESPONSE_PANE_ID]: response.pane,
  };

  /** Move pane focus to `id` (tab and mouse-click share this exact path). */
  const focusPane = (id: string): void => {
    focus.focus(id);
    repaintFocus();
    collections.syncFocus(focus.focused);
  };

  /**
   * Mouse click-to-focus: a left click anywhere in a pane (its rows,
   * editor, content — events bubble to the pane box) focuses it, the same
   * move tab performs.
   */
  const focusOnPaneClick = (pane: BoxRenderable, id: string): void => {
    pane.onMouseDown = (event: MouseEvent): void => {
      if (event.type !== "down" || event.button !== 0) return;
      focusPane(id);
    };
  };
  focusOnPaneClick(collections.pane, COLLECTIONS_PANE_ID);
  focusOnPaneClick(composer.pane, COMPOSER_PANE_ID);
  focusOnPaneClick(response.pane, RESPONSE_PANE_ID);

  /**
   * Paint pane borders: the pane GAINING focus sweeps its border into the
   * accent color (motion confirms the move); panes losing it recede to the
   * muted border instantly. A repaint of the already-focused pane (initial
   * paint, refresh) re-asserts the color with no sweep.
   */
  let lastFocused: string | null = null;
  const repaintFocus = (): void => {
    const current = focus.focused;
    for (const [id, pane] of Object.entries(panes)) {
      if (id === current) {
        if (lastFocused !== null && id !== lastFocused) {
          sweepBorder(pane, THEME.color.border, THEME.color.accent);
        } else {
          pane.borderColor = THEME.color.accent;
        }
      } else {
        // Recede instantly, cancelling any sweep still running toward
        // accent — otherwise its completion would repaint the stale color.
        settleBorder(pane, THEME.color.border);
      }
    }
    lastFocused = current;
  };
  repaintFocus();

  let requestQuit: (() => void) | null = null;
  const onQuit = new Promise<"quit">((resolve) => {
    requestQuit = () => resolve("quit");
  });

  /**
   * App-level actions (quit, search, focus moves) after no pane consumed
   * the key. Split from the listener so each stays readable.
   */
  const applyGlobalAction = (action: GlobalAction): void => {
    if (action === "quit") requestQuit?.();
    else if (action === "search") beginSearch();
    else if (action === "focus-next") {
      const next = focus.cycle();
      if (next !== null) focusPane(next);
    } else if (action === "focus-previous") {
      const previous = focus.cycleBack();
      if (previous !== null) focusPane(previous);
    }
  };

  const keyListener = (key: ParsedKeyLike): void => {
    if (search.active && searchKey(key)) return;
    if (focus.focused === COLLECTIONS_PANE_ID && collections.handleKey(key)) return;
    if (focus.focused === COMPOSER_PANE_ID && composer.handleKey(key)) return;
    if (focus.focused === RESPONSE_PANE_ID && response.handleKey(key)) return;
    const action = globalAction(key);
    if (action !== null) applyGlobalAction(action);
  };
  renderer.keyInput.on("keypress", keyListener);
  repaintStatusBar();

  return {
    focus,
    collections,
    composer,
    response,
    get searching(): boolean {
      return search.active;
    },
    onQuit,
    dispose: () => {
      renderer.keyInput.off("keypress", keyListener);
    },
  };
}

/** Header bar: POSTUI wordmark + halftone left, workspace center, env badge right. */
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
      content: new StyledText([bold(fg(THEME.color.accent)("P O S T U I"))]),
    }),
  );
  // The mockup's halftone strip fading out beside the wordmark.
  left.add(halftoneBox(renderer, 16, 1, "top-left"));
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

