import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import { groupByCollection } from "./collection-groups.ts";
import type { CollectionGroup } from "./collection-groups.ts";
import {
  REQUEST_ROW_HEIGHT,
  headerRow,
  renderError,
  renderEmptyState,
  requestRow,
} from "./collections-render.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { clearChildren } from "./render.ts";
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

/** The collections pane controller the shell drives: keys, focus, opening. */
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
    /** Highlighted request (moves with j/k), as an index into `items`. */
    cursor: null as number | null,
    /** The request currently open in the composer, tracked by module name. */
    selectedName: null as string | null,
    loadError: null as unknown,
    focused: true, // the shell's first pane starts focused
    firstVisible: 0, // scroll window start, in flattened terminal rows
    previousCount: 0,
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

  const flatRows = (): FlatRow[] => {
    const rows: FlatRow[] = [];
    let index = 0;
    for (const group of state.groups) {
      rows.push({ kind: "header", title: group.title });
      for (const request of group.requests) {
        rows.push({ kind: "request", request, index });
        index += 1;
      }
    }
    return rows;
  };

  const visibleRows = (): number => {
    return Math.max(1, renderer.height - CHROME_ROWS);
  };

  const render = (): void => {
    clearChildren(pane);
    if (state.loadError !== null) {
      renderError(renderer, pane, state.loadError);
      return;
    }
    if (state.items.length === 0) {
      renderEmptyState(renderer, pane);
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
    if (state.items.length === 0) return;
    // From no highlight, j picks the first module and k the last.
    if (state.cursor === null) {
      state.cursor = delta === 1 ? 0 : state.items.length - 1;
    } else {
      state.cursor = (state.cursor + delta + state.items.length) % state.items.length;
    }
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
      // places the highlight like the mockup.
      const previousName =
        state.cursor === null ? null : (state.items[state.cursor]?.name ?? null);
      state.items = requests;
      state.groups = groupByCollection(requests);
      const kept =
        previousName === null ? -1 : state.items.findIndex(item => item.name === previousName);
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
      options.onSelectionLost?.();
    }
    render();
  };

  const refresh = (): Promise<void> => enqueue(runRefresh);

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
      if (state.cursor !== null) {
        const name = state.items[state.cursor]?.name;
        if (name !== undefined) void openSelected(name);
      }
      return true;
    }
    return false;
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
  };
}
