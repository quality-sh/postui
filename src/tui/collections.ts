import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import type { CollectionsPane, CollectionsPaneOptions } from "./collections-api.ts";
import { renderCollectionsEmptyState, renderError, renderNoMatches, treeBranch } from "./collections-render.ts";
import { groupByCollection } from "./collection-groups.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { flattenRows, steppedRequestRow } from "./collections-rows.ts";
import type { FlatRow } from "./collections-rows.ts";
import type { SlotLook } from "./collections-slot.ts";
import { createRowsView } from "./collections-view.ts";
import type { DevelopPlan } from "./collections-view.ts";
import { watchFolder } from "./collections-watch.ts";
import { clampWindow, visibleRowCount, windowForCursor, windowSlots } from "./collections-window.ts";
import type { WindowSlot } from "./collections-window.ts";
import { DECOR_SIZE } from "./render.ts";
import { rankRequests } from "./search.ts";
import { THEME } from "./theme.ts";
import { workspaceReader } from "./workspace.ts";
import type { WorkspaceScan } from "./workspace.ts";

export type { CollectionsPane, CollectionsPaneOptions } from "./collections-api.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COLLECTIONS_PANE_ID = "collections";

/** Cursor keys: ↑/↓, with j/k as silent aliases. */
const CURSOR_KEYS: Readonly<Record<string, 1 | -1>> = { down: 1, j: 1, up: -1, k: -1 };

/** A scan's verdict for the render: what develops in, or "same" (nothing to paint). */
type Applied = DevelopPlan | "same";

/**
 * The collections pane: every saved request grouped by collection, ↑/↓
 * navigation with wrap-around (j/k as silent aliases), enter to open the
 * request in the composer and send it in one step — focus stays here, so
 * ↓ ⏎ ↓ ⏎ walks the list firing each request.
 *
 * Data comes from a WorkspaceReader (workspace.ts): the first scan imports
 * everything; later scans — on a folder change (fs.watch, debounced) or a
 * focus regain — stat the files and import only what changed. Opens and
 * sends use the in-memory list at once; they never wait on a scan. A
 * vanished selection clears honestly instead of jumping.
 */
export function startCollectionsPane(
  renderer: CliRenderer,
  options: CollectionsPaneOptions,
): CollectionsPane {
  const pane = new BoxRenderable(renderer, {
    width: 30,
    height: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.color.border,
    title: "COLLECTIONS",
    titleColor: THEME.color.text,
    backgroundColor: THEME.color.panel,
  });
  const reader = options.workspace ?? workspaceReader(options.requestsDir);

  const state = {
    /** False until the first scan lands: the skeleton holds until then. */
    loaded: false,
    groups: [] as ReturnType<typeof groupByCollection>,
    items: [] as LoadedRequest[],
    /** Highlighted request (moves with ↑/↓), as an index into the shown list. */
    cursor: null as number | null,
    /** The request currently open in the composer, tracked by module name. */
    selectedName: null as string | null,
    loadError: null as unknown,
    focused: true, // the shell's first pane starts focused
    firstVisible: 0, // scroll window start, as a flattened row index
    previousCount: 0,
    /** Search-filter mode: non-null holds the query, and the pane shows its ranked matches. */
    filterQuery: null as string | null,
    /** Highlight to restore when the filter closes, tracked by module name. */
    savedCursorName: null as string | null,
    /** Match count of the last render (the status bar reads it). */
    matchCount: null as number | null,
  };

  let tail: Promise<void> = Promise.resolve();
  // Serialize scans: each applies to the state the previous one left. A
  // step must never await a step it enqueues (it would wait on itself).
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const done = tail.then(step, step);
    tail = done;
    return done;
  };

  /**
   * The list the pane currently shows: the full workspace, or the query's
   * ranked matches — in-memory only, memoized per (query, items) so one
   * render pass ranks once and a scan landing mid-search re-ranks fresh items.
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
    flattenRows(state.items, state.groups, state.filterQuery === null ? null : shown());

  const visibleRows = (): number => visibleRowCount(renderer.height);

  /** The request the highlight sits on, in whichever list is shown. */
  const highlighted = (): LoadedRequest | undefined =>
    state.cursor === null ? undefined : shown()[state.cursor];
  const cursorName = (): string | null => highlighted()?.name ?? null;

  const view = createRowsView(renderer, pane, name => selectRequest(name));

  const lookOf = (rows: readonly FlatRow[], slot: WindowSlot): SlotLook =>
    slot.row.kind === "header"
      ? { kind: "header", title: slot.row.title }
      : {
          kind: "request",
          request: slot.row.request,
          branch: treeBranch(rows, slot.rowIndex),
          selected: slot.row.index === state.cursor,
        };

  /** Paint the pane from state. Rows repaint in place; `develop` names what develops in. */
  const render = (develop: DevelopPlan = null): void => {
    if (!state.loaded) return; // the skeleton holds until the first scan lands
    const query = state.filterQuery;
    if (state.loadError !== null) view.message(box => renderError(renderer, box, state.loadError));
    else if (state.items.length === 0) view.message(box => renderCollectionsEmptyState(renderer, box));
    else if (query !== null && shown().length === 0) view.message(box => renderNoMatches(renderer, box, query));
    else {
      const rows = flatRows();
      const visible = visibleRows();
      state.firstVisible = clampWindow(rows, state.firstVisible, visible);
      const slots = windowSlots(rows, state.firstVisible, visible);
      // Room left under a short list gets the mockup's halftone dots — only when they fit.
      const tailFits = slots.length + DECOR_SIZE.height <= visible;
      view.rows(slots.map(slot => lookOf(rows, slot)), { develop, tail: tailFits });
    }
  };

  /** Keep the highlighted request's row inside the window. */
  const ensureVisible = (): void => {
    if (state.cursor === null) return;
    const rows = flatRows();
    const rowIndex = rows.findIndex(row => row.kind === "request" && row.index === state.cursor);
    if (rowIndex !== -1) state.firstVisible = windowForCursor(rows, rowIndex, visibleRows(), state.firstVisible);
  };

  /** Move the highlight to a shown-list index and pulse its row (the move's acknowledgement). */
  const placeCursor = (index: number): void => {
    state.cursor = index;
    ensureVisible();
    render();
    const name = cursorName();
    if (name !== null) view.flash(name, "move");
  };

  /** ↑/↓: the cursor walks the pane's DISPLAYED request order, with wrap-around. */
  const moveCursor = (delta: 1 | -1): void => {
    const row = steppedRequestRow(flatRows(), state.cursor, delta);
    if (row !== null) placeCursor(row.index);
  };

  /** Mouse click-to-select: the cursor lands on the clicked row, wherever ↑/↓ would have put it. */
  const selectRequest = (name: string): void => {
    const index = shown().findIndex(item => item.name === name);
    if (index === -1) return;
    if (index !== state.cursor) placeCursor(index);
    options.onInteract?.();
  };

  /** After a scan: a vanished open module clears honestly; a changed one is handed back fresh. */
  const reconcileSelection = (changed: ReadonlySet<string>): void => {
    if (state.selectedName === null) return;
    const fresh = state.items.find(item => item.name === state.selectedName);
    if (fresh === undefined) {
      state.selectedName = null;
      options.onSelectionLost?.();
    } else if (changed.has(fresh.name)) {
      options.onReload?.(fresh);
    }
  };

  const applyScan = (scan: WorkspaceScan): void => {
    // The cursor follows its module by NAME, so a rescan never makes the
    // highlight drift to a neighbor. A deleted highlight clears instead of
    // being silently re-pointed — except on the very first listing, which
    // places the highlight like the mockup.
    const previousName = cursorName();
    state.loadError = null;
    state.items = scan.requests;
    state.groups = groupByCollection(scan.requests);
    const kept = previousName === null ? -1 : shown().findIndex(item => item.name === previousName);
    state.cursor = kept >= 0 ? kept : null;
    if (state.cursor === null && state.items.length > 0 && state.previousCount === 0) state.cursor = 0;
    state.previousCount = state.items.length;
    reconcileSelection(new Set(scan.changed));
    ensureVisible();
  };

  const applyError = (error: unknown): void => {
    state.loadError = error;
    state.items = [];
    state.groups = [];
    state.cursor = null;
    state.previousCount = 0;
    state.selectedName = null;
    state.matchCount = null; // the count died with its list — never linger on the bar
    options.onSelectionLost?.();
  };

  const watch = watchFolder(options.requestsDir, () => void refresh());

  /** Scan and fold the result into state; says what to develop, or "same" when nothing moved. */
  const scanAndApply = async (): Promise<Applied> => {
    let scan: WorkspaceScan;
    try {
      scan = await reader.scan();
    } catch (error) {
      state.loaded = true;
      applyError(error);
      return null;
    } finally {
      watch.arm(); // the folder may exist now even if it did not at startup
    }
    const first = !state.loaded;
    const recovering = state.loadError !== null;
    state.loaded = true;
    if (!first && !recovering && scan.changed.length === 0 && scan.removed.length === 0) return "same";
    applyScan(scan);
    return first ? "all" : new Set(scan.changed);
  };

  const refresh = (): Promise<void> =>
    enqueue(async () => {
      const applied = await scanAndApply();
      if (applied !== "same") render(applied);
    });

  const reveal = (name: string): Promise<void> =>
    enqueue(async () => {
      const applied = await scanAndApply();
      const index = state.loadError === null ? shown().findIndex(item => item.name === name) : -1;
      if (index === -1) {
        if (applied !== "same") render(applied);
        return;
      }
      state.cursor = index;
      ensureVisible();
      render(applied === "all" ? "all" : new Set([...(applied instanceof Set ? applied : []), name]));
      view.flash(name, "reveal");
    });

  /**
   * Open the highlighted request and, with `send`, fire it — enter in the
   * tree does both in one step; the search palette only opens. A request
   * that is ALREADY open is never reloaded: enter sends the draft as the
   * user left it. Enter pulses the row whatever the send does, so the tree
   * itself confirms the key.
   */
  const activateHighlighted = (send: boolean): Promise<void> => {
    const request = highlighted();
    if (request === undefined) return Promise.resolve();
    if (send) view.flash(request.name, "press");
    if (state.selectedName !== request.name) {
      state.selectedName = request.name;
      options.onOpen(request);
    }
    if (send) options.onSend?.();
    return Promise.resolve();
  };

  const handleKey = (key: ParsedKeyLike): boolean => {
    if (!state.focused || key.ctrl) return false;
    const step = CURSOR_KEYS[key.name];
    if (step !== undefined) {
      moveCursor(step);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      void activateHighlighted(true);
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
      void activateHighlighted(false);
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
    render("moved");
  };

  /** Typing re-ranks: rows that land in a new slot develop in, so the reflow reads as motion. */
  const setFilterQuery = (query: string): void => {
    if (state.filterQuery === null) return; // not filtering: ignore stray input
    state.filterQuery = query;
    state.cursor = shown().length > 0 ? 0 : null; // typing restarts at the top match
    state.firstVisible = 0;
    render("moved");
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
    render("moved");
  };

  const syncFocus = (focusedPane: string | null): void => {
    const nowFocused = focusedPane === COLLECTIONS_PANE_ID;
    if (nowFocused === state.focused) return;
    state.focused = nowFocused;
    if (nowFocused) void refresh();
  };

  const onResize = (): void => render();
  renderer.on("resize", onResize);
  renderer.once("destroy", () => {
    watch.close();
    renderer.off("resize", onResize);
  });

  const initialLoad = refresh();

  return {
    pane,
    ready: initialLoad,
    settled: () => tail,
    refresh,
    reveal,
    handleKey,
    openHighlighted: () => activateHighlighted(false),
    selectRequest,
    syncFocus,
    beginFilter,
    setFilterQuery,
    endFilter,
    filterKey,
    view,
    get filtering(): boolean { return state.filterQuery !== null; },
    get filteredCount(): number | null { return state.matchCount; },
  };
}
