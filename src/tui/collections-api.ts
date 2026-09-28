import type { BoxRenderable } from "@opentui/core";
import type { LoadedRequest } from "../gen/load.ts";
import type { RowsView } from "./collections-view.ts";
import type { ParsedKeyLike } from "./keymap.ts";
import type { WorkspaceReader } from "./workspace.ts";

/**
 * The collections pane's contract with the shell: what the pane is given
 * (CollectionsPaneOptions) and what it offers (CollectionsPane). The
 * controller lives in collections.ts, which re-exports both.
 */

/** What the shell hands the pane: the folder, and where opens, reloads and sends go. */
export interface CollectionsPaneOptions {
  /** The workspace's requests folder: watched, and rescanned on focus regain. */
  readonly requestsDir: string;
  /** The folder reader; defaults to workspaceReader(requestsDir). Tests pass their own. */
  readonly workspace?: WorkspaceReader;
  /** Opening a request hands it to the shell (the composer loads it). */
  readonly onOpen: (request: LoadedRequest) => void;
  /**
   * The open selection's module vanished from disk (refresh noticed); the
   * shell clears the composer — the module was its source of truth.
   */
  readonly onSelectionLost?: () => void;
  /**
   * The open selection's module changed on disk and was re-read; the shell
   * decides whether the composer reloads it (an edited draft wins — edits
   * are in-memory and must not be clobbered behind the user's back).
   */
  readonly onReload?: (request: LoadedRequest) => void;
  /**
   * Send the composer's current draft through the pipeline; returns whether
   * a send started. Enter in the tree calls it right after opening the
   * highlighted request — or alone when that request is already open, so an
   * edited draft is sent as edited, never reloaded.
   */
  readonly onSend?: () => boolean;
  /** The user clicked a request row; the shell focuses the pane. Called after the selection moved. */
  readonly onInteract?: () => void;
}

/** The collections pane controller the shell drives: keys, focus, opening, search filter. */
export interface CollectionsPane {
  readonly pane: BoxRenderable;
  /** Resolves once the initial workspace load has been rendered. */
  readonly ready: Promise<void>;
  /** Resolves when every refresh started so far has finished. */
  settled(): Promise<void>;
  /**
   * Rescan requests/ now. Only files whose stamp changed are re-imported;
   * changed rows develop in, and a scan that finds nothing changes nothing.
   */
  refresh(): Promise<void>;
  /**
   * Rescan, then highlight `name` (scrolled into view) with the reveal:
   * the row develops in and pulses. Resolves once it is on screen.
   */
  reveal(name: string): Promise<void>;
  /** Handle a keypress while the pane is focused; true = consumed. */
  handleKey(key: ParsedKeyLike): boolean;
  /**
   * Open the highlighted request in the composer WITHOUT sending it (the
   * search palette's "⏎ open"). A request that is already open is left
   * alone, so its draft keeps any edits.
   */
  openHighlighted(): Promise<void>;
  /** Highlight a specific request (mouse click-to-select), exactly where ↑/↓ would land. */
  selectRequest(name: string): void;
  /** Called by the shell after every focus change; rescans on regaining focus. */
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
  /** Navigation keys inside filter mode (up/down move, enter opens without sending); true = consumed. */
  filterKey(key: ParsedKeyLike): boolean;
  /** True while the search filter is active. */
  readonly filtering: boolean;
  /** Matches for the current query (null when not filtering). */
  readonly filteredCount: number | null;
  /** The body view (row pool); tests assert rows are reused and pulses land. */
  readonly view: RowsView;
}
