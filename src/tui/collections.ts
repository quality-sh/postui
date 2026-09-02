import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { groupByCollection } from "./collection-groups.ts";
import type { CollectionGroup } from "./collection-groups.ts";
import {
  REQUEST_ROW_HEIGHT,
  headerRow,
  renderCollectionsEmptyState,
  renderError,
  renderNoMatches,
  requestRow,
} from "./collections-render.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { clearChildren, DECOR_SIZE, halftoneTail } from "./render.ts";
import { rankRequests } from "./search.ts";
import { THEME } from "./theme.ts";
import { readWorkspace } from "./workspace.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COLLECTIONS_PANE_ID = "collections";

/** Terminal rows above and around the pane body: header (3) + status (3) + pane border (2). */
const CHROME_ROWS = 8;

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

/** One flattened, renderable row of the pane (a group header or a request). */
type FlatRow =
  | { readonly kind: "header"; readonly title: string }
  | { readonly kind: "request"; readonly request: LoadedRequest; readonly index: number };

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
    groups: [] as CollectionGroup[],
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

  const flatRows = (): FlatRow[] => {
    const rows: FlatRow[] = [];
    if (state.filterQuery !== null) {
      // Filtered: a flat ranked list — group headers would scramble the ranking.
      shown().forEach((request, index) => rows.push({ kind: "request", request, index }));
      return rows;
    }
    // The cursor (and every index the pane reasons about) points into
    // `items`, so rows carry each request's position THERE — not its
    // display position, which the group sort reorders.
    const itemsIndex = new Map(state.items.map((request, index) => [request, index]));
    for (const group of state.groups) {
      rows.push({ kind: "header", title: group.title });
      for (const request of group.requests) {
        rows.push({ kind: "request", request, index: itemsIndex.get(request) ?? 0 });
      }
    }
    return rows;
  };

  const visibleRows = (): number => Math.max(1, renderer.height - CHROME_ROWS);

  const render = (): void => {
    clearChildren(pane);
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
        else pane.add(requestRow(renderer, row.request, row.index === state.cursor));
      }
      top += height;
    }
    // Room left under a short list gets the mockup's halftone dots — but
    // only when the decoration itself fits, so nothing ever overflows.
    if (top + DECOR_SIZE.height <= visibleRows()) pane.add(halftoneTail(renderer));
  };

  /** Keep the highlighted request's selection box fully inside the window. */
  const ensureVisible = (): void => {
    if (state.cursor === null) return;
    const rows = flatRows();
    const visible = visibleRows();
    let top = 0;
    let entryIndex = 0;
    for (const row of rows) {
      if (row.kind === "request" && row.index === state.cursor) break;
      top += row.kind === "header" ? 1 : REQUEST_ROW_HEIGHT;
      entryIndex += 1;
    }
    if (entryIndex >= rows.length) return;
    if (top < state.firstVisible) state.firstVisible = top;
    else if (top + REQUEST_ROW_HEIGHT > state.firstVisible + visible) {
      state.firstVisible = top + REQUEST_ROW_HEIGHT - visible;
    }
    const totalHeight = rows.reduce(
      (sum, row) => sum + (row.kind === "header" ? 1 : REQUEST_ROW_HEIGHT),
      0,
    );
    state.firstVisible = Math.max(0, Math.min(state.firstVisible, Math.max(0, totalHeight - visible)));
  };

  const moveCursor = (delta: 1 | -1): void => {
    // j/k walk the pane's DISPLAYED request order (grouped in browse mode,
    // ranked while filtering); each row carries the index its mode reasons
    // in, so the cursor stays in that index space while never jumping
    // visually across groups.
    const requests = flatRows().filter(row => row.kind === "request");
    if (requests.length === 0) return;
    const at =
      state.cursor === null
        ? -1
        : requests.findIndex(row => row.kind === "request" && row.index === state.cursor);
    let next: number;
    if (at === -1) {
      // From no highlight (or a cursor its rows no longer carry), j picks
      // the first displayed request and k the last.
      next = delta === 1 ? 0 : requests.length - 1;
    } else {
      next = (at + delta + requests.length) % requests.length;
    }
    const row = requests[next];
    if (row?.kind === "request") state.cursor = row.index;
    ensureVisible();
    render();
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
   * cannot diverge. Used by handleKey and by the shell's search palette.
   */
  const openHighlighted = (): void => {
    if (state.cursor === null) return;
    const request = shown()[state.cursor];
    if (request !== undefined) void openSelected(request.name);
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
    syncFocus,
    beginFilter,
    setFilterQuery,
    endFilter,
    filterKey,
    get filtering(): boolean { return state.filterQuery !== null; },
    get filteredCount(): number | null { return state.matchCount; },
  };
}
