import { dirname, join } from "node:path";
import { BoxRenderable, decodePasteBytes, stripAnsiSequences } from "@opentui/core";
import type { CliRenderer, MouseEvent, PasteEvent } from "@opentui/core";
import { COLLECTIONS_PANE_ID, startCollectionsPane } from "./collections.ts";
import type { CollectionsPane } from "./collections.ts";
import { COMPOSER_PANE_ID, startComposerPane } from "./composer.ts";
import type { ComposerPane } from "./composer.ts";
import { sendDraft } from "./composer-send.ts";
import { RESPONSE_PANE_ID, startResponsePane } from "./response-pane.ts";
import type { ResponsePane } from "./response-pane.ts";
import { FocusRegistry } from "./focus.ts";
import { attachImportPrompt } from "./import.ts";
import { globalAction, hintsFor } from "./keymap.ts";
import type { GlobalAction, ParsedKeyLike } from "./keymap.ts";
import { bindToaster } from "./fx/notify.ts";
import { mountToasts } from "./fx/toast.ts";
import { buildHeader, HEADER_ROWS } from "./header.ts";
import { settleBorder, sweepBorder, sweepFill } from "./motion.ts";
import { startSendLifecycle } from "./send-lifecycle.ts";
import { startStatusBar } from "./status-bar.ts";
import type { SearchBarState, StatusBar, StatusBarMode } from "./status-bar.ts";
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
  /**
   * True while a text field has keyboard focus: "q" and "/" then type
   * instead of quitting or opening search. Defaults to the composer's
   * isEditingText() while the composer is focused (when it has one).
   */
  readonly isEditingText?: () => boolean;
}

/** How the shell ended: the user quit, or the terminal/a signal closed it. */
type ShellEnd = "quit" | "closed";

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
  /**
   * The one-row status bar. Its left side follows focus and search; its
   * right side is the live-status slot (setStatus / setIndicator) for
   * whatever runs on its own clock, such as a send in flight.
   */
  readonly statusBar: StatusBar;
  /** True while the `/` search palette owns the keys. */
  readonly searching: boolean;
  /** Resolves once a quit key was pressed, or the renderer was destroyed under the shell. */
  readonly onQuit: Promise<ShellEnd>;
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
 * (arrows and enter in collections; editing, arrows, enter in the composer;
 * arrows and +/- in the response) are offered to the pane first; everything
 * else falls through to the global map. The status bar shows the focused
 * pane's key hints (keymap's PANE_KEY_HINTS) and follows every focus move.
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
  // The status bar exists before the panes that feed its live slot.
  const statusBar = startStatusBar(renderer);
  // Send-state tracking: the composer's diagnostics are the one place a
  // send starts and settles; the lifecycle turns them into the busy view,
  // the held-back develop and the status bar's live slot.
  let repaintStatusBar: () => void = noop; // rebound once the bar is mounted
  const sends = startSendLifecycle({
    renderer,
    response,
    statusBar,
    onBusyChange: () => repaintStatusBar(),
  });
  const composer = startComposerPane(renderer, {
    // Before the pipeline's first await, this shell's busy view learns what
    // it is waiting on (GET /users) — scoped to this shell, not a global.
    sendDraft: (draft, name, bodyWindow) => {
      sends.described({ method: draft.method, url: draft.url });
      // A plain send uses the response pane's window (64 KiB to start); +/- pass their own.
      return sendDraft(draft, name, bodyWindow ?? response.bodyWindow);
    },
    diagnostics: {
      showSending: () => sends.started(),
      showResult: (result, latencyMs, extraSecrets, forName) => sends.result(result, latencyMs, extraSecrets, forName),
      showError: (error) => sends.error(error),
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
    // Enter in the tree opens-and-sends (or just sends the open request):
    // the composer stays the only place a send actually runs.
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

  root.add(statusBar.pane);

  /** Search-palette state: open flag plus the query typed so far. */
  const search = { active: false, query: "" };

  let lastPaintedMode: StatusBarMode | null = null;
  repaintStatusBar = (): void => {
    let mode: StatusBarMode = "browsing";
    if (search.active) mode = "searching";
    else if (sends.busy) mode = "sending";
    const searchBar: SearchBarState = { query: search.query, matchCount: collections.filteredCount };
    statusBar.paint(mode, hintsFor(focus.focused), searchBar);
    // Mode change feedback: the bar's fill flashes the accent's soft tone
    // and decays back to the background (the bar has no frame to sweep).
    if (lastPaintedMode !== null && mode !== lastPaintedMode) {
      sweepFill(statusBar.pane, THEME.color.accentSoft, THEME.color.bg, 220);
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
    composer.syncFocus(focus.focused);
    repaintStatusBar(); // the bar shows the focused pane's hints
  };

  /** True while a composer text field (URL, body, table cell) has the keys. */
  const composerEditing = (): boolean =>
    focus.focused === COMPOSER_PANE_ID && composer.isEditingText();
  const textFocused = options.isEditingText ?? composerEditing;

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
   * accent (motion confirms the move); panes losing it recede to the
   * resting border color instantly. A repaint of the already-focused pane
   * (initial paint, refresh) re-asserts the color with no sweep.
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
  const onQuit = new Promise<ShellEnd>((resolve) => {
    requestQuit = () => resolve("quit");
    // OpenTUI's signal handler (SIGHUP when the terminal closes, SIGTERM)
    // destroys the renderer and leaves exiting to the app.
    renderer.once("destroy", () => resolve("closed"));
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

  const importer = attachImportPrompt(renderer, root, { requestsDir: options.requestsDir, collections, composer, response, focusPane, endSearch });
  const keyListener = (key: ParsedKeyLike): void => {
    if (importer.handleKey(key)) return; // ctrl+n opens it; while open it owns the keys
    if (search.active && searchKey(key)) return;
    if (focus.focused === COLLECTIONS_PANE_ID && collections.handleKey(key)) return;
    if (focus.focused === COMPOSER_PANE_ID && composer.handleKey(key)) return;
    if (focus.focused === RESPONSE_PANE_ID && response.handleKey(key)) return;
    const action = globalAction(key, { textFocused: textFocused() });
    if (action !== null) applyGlobalAction(action);
  };
  // Pastes the import prompt did not take go to a focused composer text field.
  const pasteListener = (event: PasteEvent): void => {
    if (event.defaultPrevented || focus.focused !== COMPOSER_PANE_ID) return;
    if (composer.paste(stripAnsiSequences(decodePasteBytes(event.bytes)))) event.preventDefault();
  };
  renderer.keyInput.on("keypress", keyListener);
  renderer.keyInput.on("paste", pasteListener);
  repaintStatusBar();

  // Mounted last so the stack draws above every pane and the import overlay.
  // It hangs top-right just under the composer's SEND row, over the tab
  // content's empty right side: clear of SEND, and of the response pane's
  // bottom note line.
  const toasts = mountToasts(renderer, root, { top: HEADER_ROWS + 3 });
  bindToaster(toasts);

  return {
    focus,
    collections,
    composer,
    response,
    statusBar,
    get searching(): boolean {
      return search.active;
    },
    onQuit,
    dispose: () => {
      renderer.keyInput.off("keypress", keyListener);
      renderer.keyInput.off("paste", pasteListener);
      sends.dispose();
      bindToaster(null);
      toasts.destroy();
    },
  };
}
