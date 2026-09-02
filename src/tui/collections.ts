import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { readFile } from "node:fs/promises";
import type { LoadedRequest } from "../gen/load.ts";
import { groupByCollection } from "./collection-groups.ts";
import type { CollectionGroup } from "./collection-groups.ts";
import {
  REQUEST_ROW_HEIGHT,
  clearChildren,
  headerRow,
  namedErrorText,
  previewBox,
  previewText,
  renderError,
  renderEmptyState,
  requestRow,
} from "./collections-render.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import { THEME } from "./theme.ts";
import { readWorkspace } from "./workspace.ts";

/** The pane id used in the shell's focus registry (tab order). */
export const COLLECTIONS_PANE_ID = "collections";

/** Terminal rows above and around the pane body: header (3) + status (3) + pane border (2). */
const CHROME_ROWS = 8;

export interface CollectionsPaneOptions {
  /** The workspace's requests folder; re-read on every focus regain. */
  readonly requestsDir: string;
  /** The region to the right where the selected request's preview renders. */
  readonly mainRegion: BoxRenderable;
}

/** The collections pane controller the shell drives: keys, focus, preview. */
export interface CollectionsPane {
  readonly pane: BoxRenderable;
  /** Resolves once the initial workspace load has been rendered. */
  readonly ready: Promise<void>;
  /** Resolves when every refresh/preview read started so far has finished. */
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
 * navigation with wrap-around, enter to open the saved module's preview.
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
    /** The request whose preview is open, tracked by module name. */
    selectedName: null as string | null,
    loadError: null as unknown,
    focused: true, // the shell's first pane starts focused
    firstVisible: 0, // scroll window start, in flattened terminal rows
    previousCount: 0,
  };

  let tail: Promise<void> = Promise.resolve();
  // Serialize workspace work (loads, preview reads). The chained promise is
  // returned so callers can await exactly the work they enqueued. A step may
  // enqueue a follow-up step (a refresh re-opening a preview) but must never
  // await it: the follow-up chains onto the tail this step is occupying.
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

  const openPreview = (name: string): Promise<void> =>
    enqueue(async () => {
      const request = state.items.find(item => item.name === name);
      if (request === undefined) return; // deleted while queued — refresh already handled it
      state.selectedName = name;
      clearChildren(options.mainRegion);
      const box = previewBox(renderer, request);
      options.mainRegion.add(box);
      let content: string;
      try {
        content = previewText(await readFile(request.path, "utf8"));
      } catch (cause) {
        box.add(
          new TextRenderable(renderer, {
            content: namedErrorText("ReadError", cause),
            fg: THEME.color.text,
            wrapMode: "word",
            width: "100%",
          }),
        );
        return;
      }
      box.add(
        new TextRenderable(renderer, {
          content,
          fg: THEME.color.text,
          wrapMode: "word",
          width: "100%",
        }),
      );
    });

  const closePreview = (): void => {
    state.selectedName = null;
    clearChildren(options.mainRegion);
  };

  const runRefresh = async (): Promise<void> => {
    try {
      const requests = await readWorkspace(options.requestsDir);
      state.loadError = null;
      // The cursor and the open preview follow their module by NAME, so a
      // refresh never makes the highlight drift to a neighbor. A deleted
      // selection clears instead of being silently re-pointed.
      const previousName =
        state.cursor === null ? null : (state.items[state.cursor]?.name ?? null);
      state.items = requests;
      state.groups = groupByCollection(requests);
      const kept =
        previousName === null ? -1 : state.items.findIndex(item => item.name === previousName);
      state.cursor = kept >= 0 ? kept : null;
      if (state.cursor === null && state.items.length > 0 && state.previousCount === 0) {
        state.cursor = 0; // first real listing: place the highlight like the mockup
      }
      state.previousCount = state.items.length;
      if (
        state.selectedName !== null &&
        !state.items.some(item => item.name === state.selectedName)
      ) {
        closePreview();
      } else if (state.selectedName !== null) {
        // The selection survived: re-read the file so a hand edit shows in
        // the preview too, not just in the tree. Not awaited — this runs
        // inside the tail step; enqueue appends the read after this refresh.
        void openPreview(state.selectedName);
      }
      state.firstVisible = 0;
      ensureVisible();
    } catch (error) {
      state.loadError = error;
      state.items = [];
      state.groups = [];
      state.cursor = null;
      state.previousCount = 0;
      closePreview();
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
        if (name !== undefined) openPreview(name);
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
