import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import {
  REQUEST_ROW_HEIGHT,
  headerRow,
  renderCollectionsEmptyState,
  renderError,
  renderNoMatches,
  requestRow,
} from "./collections-render.ts";
import { groupByCollection } from "./collection-groups.ts";
import { blendHex, sweepBorder } from "./motion.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import {
  flattenRows,
  steppedRequestRow,
} from "./collections-rows.ts";
import type { FlatRow } from "./collections-rows.ts";
import { visibleRowCount, windowForCursor } from "./collections-window.ts";
import { clearChildren, DECOR_SIZE, halftoneTail } from "./render.ts";
import { rankRequests } from "./search.ts";
import { THEME } from "./theme.ts";
import { readWorkspace } from "./workspace.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COLLECTIONS_PANE_ID = "collections";

export interface CollectionsPaneOptions {
  /** The workspace's requests folder; re-read on every focus regain. */
  readonly requestsDir: string;
  /** Enter on a request hands it to the shell (the composer loads it). */
  readonly onOpen: (request: LoadedRequest) => void;
  /**
   * The open selection's module vanished from disk (refresh noticed); the
   * shell clears the composer — the module was its source of truth.
   */
  readonly onSelectionLost?: () => void;
  /**
   * The open selection survived a refresh and was re-read from disk; the
   * shell decides whether the composer reloads it (an edited draft wins —
   * edits are in-memory and must not be clobbered behind the user's back).
   */
  readonly onReload?: (request: LoadedRequest) => void;
  /**
   * Send the composer's current draft through the pipeline; returns whether
   * a send started. Used by enter-on-an-already-open request (the status
   * bar's "⏎ send" holds from the tree too — no tab required).
   */
  readonly onSend?: () => boolean;
  /**
   * The user directly manipulated the pane with the mouse (clicked a
   * request row); the shell focuses it. Called after the selection moved —
   * the row re-render removes the clicked row from the tree, so the pane's
   * own mouse handler can not rely on the event bubbling to it.
   */
  readonly onInteract?: () => void;
}

/** The collections pane controller the shell drives: keys, focus, opening, search filter. */
export interface CollectionsPane {
  readonly pane: BoxRenderable;
  /** Resolves once the initial workspace load has been rendered. */
  readonly ready: Promise<void>;
  /** Resolves when every refresh started so far has finished. */
  settled(): Promise<void>;
  /** Handle a keypress while the pane is focused; true = consumed. */
  handleKey(key: ParsedKeyLike): boolean;
  /**
   * Highlight a specific request (mouse click-to-select): the cursor moves
   * to it in the current list's index space, exactly where j/k would land.
   */
  selectRequest(name: string): void;
  /** Called by the shell after every focus change; refreshes on regaining focus. */
  syncFocus(focusedPane: string | null): void;
  /**
   * Search-filter mode (the shell's `/` palette): the pane shows the query's
   * matches ranked best first, as a flat list. Purely in-memory over the
   * loaded workspace — no file reads, no store.
   */
  beginFilter(): void;
  /** Replace the filter query; the highlight returns to the top match. */
  setFilterQuery(query: string): void;
  /** Leave filter mode; the grouped list returns with the pre-search highlight. */
  endFilter(): void;
  /**
   * Navigation keys inside filter mode (up/down move the match highlight,
   * enter opens it through the pane's own enter path); true = consumed.
   */
  filterKey(key: ParsedKeyLike): boolean;
  /** True while the search filter is active. */
  readonly filtering: boolean;
  /** Matches for the current query (null when not filtering). */
  readonly filteredCount: number | null;
}

/**
 * The collections pane: every saved request grouped by collection, j/k
 * navigation with wrap-around, enter to open the request in the composer.
 * All data comes from readWorkspace() (the shared loader); a refresh on
 * every focus regain makes hand edits and deletions appear without a
 * restart, and a vanished selection clears honestly instead of jumping.
 */
export function startCollectionsPane(
  renderer: CliRenderer,
  options: CollectionsPaneOptions,
): CollectionsPane {
  const pane = new BoxRenderable(renderer, {
    width: 30,
    height: "100%",
    border: true,
    borderColor: THEME.color.border,
    title: "COLLECTIONS",
    titleColor: THEME.color.bright,
    backgroundColor: THEME.color.bg,
  });

  const state = {
    groups: [] as ReturnType<typeof groupByCollection>,
    items: [] as LoadedRequest[],
    /** Highlighted request (moves with j/k), as an index into the shown list. */
    cursor: null as number | null,
    /** The request currently open in the composer, tracked by module name. */
    selectedName: null as string | null,
    loadError: null as unknown,
    focused: true, // the shell's first pane starts focused
    firstVisible: 0, // scroll window start, in flattened terminal rows
    previousCount: 0,
    /**
     * Search-filter mode: non-null holds the query, and the pane shows its
     * ranked matches (flat list) instead of the grouped tree.
     */
    filterQuery: null as string | null,
    /** Highlight to restore when the filter closes, tracked by module name. */
    savedCursorName: null as string | null,
    /** Match count of the last render (the status bar reads it). */
    matchCount: null as number | null,
  };

  let tail: Promise<void> = Promise.resolve();
  // Serialize workspace reads. The chained promise is returned so callers
  // can await exactly the work they enqueued. A step may enqueue a follow-up
  // step but must never await it: the follow-up chains onto the tail this
  // step is occupying.
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const done = tail.then(step, step);
    tail = done;
    return done;
  };

  /**
   * The list the pane currently shows: the full workspace, or the query's
   * ranked matches. Ranking is in-memory only (rule_docs_no_store spirit:
   * search never touches the filesystem), memoized per (query, items) so a
   * refresh landing mid-search re-filters against fresh items while every
   * other call in the same render pass reuses one ranking.
   */
  let ranked: { query: string; items: LoadedRequest[]; matches: LoadedRequest[] } | null = null;
  const shown = (): LoadedRequest[] => {
    if (state.filterQuery === null) return state.items;
    if (ranked?.query !== state.filterQuery || ranked.items !== state.items) {
      ranked = { query: state.filterQuery, items: state.items, matches: rankRequests(state.filterQuery, state.items) };
    }
    state.matchCount = ranked.matches.length;
    return ranked.matches;
  };

  /** The rows the pane currently shows: the grouped tree, or the flat match list. */
  const flatRows = (): FlatRow[] =>
    flattenRows(
      state.items,
      state.groups,
      state.filterQuery === null ? null : shown(),
    );

  const visibleRows = (): number => visibleRowCount(renderer.height);

  /** The rendered selection bar (this pass), for the move feedback sweep. */
  let highlightedRow: BoxRenderable | null = null;

  const render = (): void => {
    clearChildren(pane);
    highlightedRow = null;
    if (state.loadError !== null) {
      renderError(renderer, pane, state.loadError);
      return;
    }
    if (state.items.length === 0) {
      renderCollectionsEmptyState(renderer, pane);
      return;
    }
    if (state.filterQuery !== null && shown().length === 0) {
      renderNoMatches(renderer, pane, state.filterQuery);
      return;
    }
    const rows = flatRows();
    const windowEnd = state.firstVisible + visibleRows();
    let top = 0; // terminal row where the current entry starts
    for (const row of rows) {
      const height = row.kind === "header" ? 1 : REQUEST_ROW_HEIGHT;
      // Only fully visible entries render: the pane does not clip overflow.
      if (top >= state.firstVisible && top + height <= windowEnd) {
        if (row.kind === "header") pane.add(headerRow(renderer, row.title));
        else {
          const selected = row.index === state.cursor;
          const rowBox = requestRow(renderer, row.request, selected, request =>
            selectRequest(request.name),
          );
          if (selected) highlightedRow = rowBox;
          pane.add(rowBox);
        }
      }
      top += height;
    }
    // Room left under a short list gets the mockup's halftone dots — but
    // only when the decoration itself fits, so nothing ever overflows.
    if (top + DECOR_SIZE.height <= visibleRows()) pane.add(halftoneTail(renderer));
  };

  /**
   * The selection bar's arrival feedback: a short border sweep into the
   * accent color on the row the cursor just landed on (motion confirms the
   * move; the render itself already painted the end state, so without the
   * motion engine this is a no-op re-assert).
   */
  const pulseHighlighted = (): void => {
    if (highlightedRow === null) return;
    sweepBorder(
      highlightedRow,
      blendHex(THEME.color.accent, THEME.color.border, 0.55),
      THEME.color.accent,
    );
  };

  /** Keep the highlighted request's selection box fully inside the window. */
  const ensureVisible = (): void => {
    if (state.cursor === null) return;
    const rows = flatRows();
    const rowIndex = rows.findIndex(row => row.kind === "request" && row.index === state.cursor);
    if (rowIndex === -1) return;
    state.firstVisible = windowForCursor(rows, rowIndex, visibleRows(), state.firstVisible);
  };

  /** j/k: the cursor walks the pane's DISPLAYED request order, with wrap-around. */
  const moveCursor = (delta: 1 | -1): void => {
    const row = steppedRequestRow(flatRows(), state.cursor, delta);
    if (row !== null) state.cursor = row.index;
    ensureVisible();
    render();
    pulseHighlighted();
  };

  /** Mouse click-to-select: the cursor lands on the clicked row, wherever j/k would have put it. */
  const selectRequest = (name: string): void => {
    const index = shown().findIndex(item => item.name === name);
    if (index === -1) return;
    if (index !== state.cursor) {
      state.cursor = index;
      ensureVisible();
      render();
      pulseHighlighted();
    }
    options.onInteract?.();
  };

  const openSelected = (name: string): Promise<void> =>
    enqueue(async () => {
      const request = state.items.find(item => item.name === name);
      if (request === undefined) return; // deleted while queued — refresh already handled it
      state.selectedName = name;
      options.onOpen(request);
    });

  /**
   * Reconcile the open selection after a successful read: a vanished module
   * clears the selection honestly; a surviving one is handed back fresh so
   * the open view can follow hand edits.
   */
  const reconcileSelection = (): void => {
    if (state.selectedName === null) return;
    const fresh = state.items.find(item => item.name === state.selectedName);
    if (fresh === undefined) {
      state.selectedName = null;
      options.onSelectionLost?.();
      return;
    }
    options.onReload?.(fresh);
  };

  const runRefresh = async (): Promise<void> => {
    try {
      const requests = await readWorkspace(options.requestsDir);
      state.loadError = null;
      // The cursor follows its module by NAME, so a refresh never makes the
      // highlight drift to a neighbor. A deleted highlight clears instead of
      // being silently re-pointed — except on the very first listing, which
      // places the highlight like the mockup. The name is read from the list
      // the cursor currently indexes (ranked matches while filtering).
      const previousName =
        state.cursor === null ? null : (shown()[state.cursor]?.name ?? null);
      state.items = requests;
      state.groups = groupByCollection(requests);
      const kept =
        previousName === null ? -1 : shown().findIndex(item => item.name === previousName);
      state.cursor = kept >= 0 ? kept : null;
      if (state.cursor === null && state.items.length > 0 && state.previousCount === 0) {
        state.cursor = 0;
      }
      state.previousCount = state.items.length;
      reconcileSelection();
      state.firstVisible = 0;
      ensureVisible();
    } catch (error) {
      state.loadError = error;
      state.items = [];
      state.groups = [];
      state.cursor = null;
      state.previousCount = 0;
      state.selectedName = null;
      state.matchCount = null; // the count died with its list — never linger on the bar
      options.onSelectionLost?.();
    }
    render();
  };

  const refresh = (): Promise<void> => enqueue(runRefresh);

  /** The module name the highlight sits on, in whichever list is shown. */
  const cursorName = (): string | null =>
    state.cursor === null ? null : (shown()[state.cursor]?.name ?? null);

  /**
   * Open whatever the highlight sits on, through the pane's own path — the
   * same onOpen handoff browse mode uses, so search-enter and tree-enter
   * cannot diverge. When the highlight is ALREADY the open request, enter
   * sends it through the shell's onSend hook instead (the status bar's
   * "⏎ send" holds from the tree; the module stays loaded, the draft stays
   * as the user left it). A refused send (one already in flight — the
   * composer said so) leaves everything untouched.
   * Used by handleKey and by the shell's search palette.
   */
  const openHighlighted = (): void => {
    if (state.cursor === null) return;
    const request = shown()[state.cursor];
    if (request === undefined) return;
    if (state.selectedName === request.name && options.onSend?.() === true) return;
    void openSelected(request.name);
  };

  const handleKey = (key: ParsedKeyLike): boolean => {
    if (!state.focused || key.ctrl) return false;
    if (key.name === "j" || key.name === "down") {
      moveCursor(1);
      return true;
    }
    if (key.name === "k" || key.name === "up") {
      moveCursor(-1);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      openHighlighted();
      return true;
    }
    return false;
  };

  /** Navigation keys inside filter mode; the shell's search palette calls this. */
  const filterKey = (key: ParsedKeyLike): boolean => {
    if (key.ctrl) return false;
    if (key.name === "down" || key.name === "up") {
      moveCursor(key.name === "down" ? 1 : -1);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      openHighlighted();
      return true;
    }
    return false;
  };

  const beginFilter = (): void => {
    state.filterQuery = "";
    state.savedCursorName = cursorName();
    state.matchCount = 0;
    state.cursor = state.items.length > 0 ? 0 : null;
    state.firstVisible = 0;
    render();
  };

  const setFilterQuery = (query: string): void => {
    if (state.filterQuery === null) return; // not filtering: ignore stray input
    state.filterQuery = query;
    state.cursor = shown().length > 0 ? 0 : null; // typing restarts at the top match
    state.firstVisible = 0;
    render();
  };

  const endFilter = (): void => {
    if (state.filterQuery === null) return;
    // The highlight follows whatever was on screen (or the pre-search
    // highlight when nothing matched) back into the full list, by name —
    // read before the filter lifts, while `shown()` is still the match list.
    const keep = cursorName() ?? state.savedCursorName;
    state.filterQuery = null;
    state.cursor = keep === null ? null : state.items.findIndex(item => item.name === keep);
    if (state.cursor === -1) state.cursor = null;
    state.savedCursorName = null;
    state.matchCount = null;
    state.firstVisible = 0;
    ensureVisible();
    render();
  };

  const syncFocus = (focusedPane: string | null): void => {
    const nowFocused = focusedPane === COLLECTIONS_PANE_ID;
    if (nowFocused === state.focused) return;
    state.focused = nowFocused;
    if (nowFocused) refresh();
  };

  const initialLoad = refresh();
  render();

  return {
    pane,
    ready: initialLoad,
    settled: () => tail,
    handleKey,
    selectRequest,
    syncFocus,
    beginFilter,
    setFilterQuery,
    endFilter,
    filterKey,
    get filtering(): boolean { return state.filterQuery !== null; },
    get filteredCount(): number | null { return state.matchCount; },
  };
}
