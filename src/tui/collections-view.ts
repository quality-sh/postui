import { BoxRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { RowSlot } from "./collections-slot.ts";
import type { PulseKind, SlotLook } from "./collections-slot.ts";
import { skeletonLines } from "./fx/skeleton.ts";
import { clearChildren, halftoneTail } from "./render.ts";

/**
 * The collections pane's body, as a view with three faces:
 *
 * - loading: skeleton rows shaped like the tree (a header line, then
 *   request lines indented past the bar and guide), shimmering in fog
 *   until the first workspace read lands. Never a false "no saved
 *   requests" — the pane does not know that yet.
 * - message: the empty state, no-matches, or a read error, built fresh.
 * - rows: a POOL of row slots (collections-slot.ts) for the visible
 *   window. Slots are created once and repainted in place; a slot whose
 *   row did not change is not touched, so ↑/↓ repaints two rows and a
 *   scroll reuses every slot. Unused slots leave the layout.
 *
 * Each rows() call can ask for rows to develop in (DevelopPlan): all of
 * them (first listing), the ones whose slot now shows a different row (a
 * search re-rank), or named requests (a refresh's changed modules, an
 * import). Develops stagger top-down: each one runs a little longer.
 */

/** Which rows develop in on this paint. */
export type DevelopPlan = "all" | "moved" | ReadonlySet<string> | null;

export interface RowsView {
  /** Show a message face (empty state, no matches, error), built by `build` into a fresh box. */
  message(build: (box: BoxRenderable) => void): void;
  /** Show these rows, top to bottom; `tail` adds the halftone decoration under them. */
  rows(looks: readonly SlotLook[], opts: { readonly develop: DevelopPlan; readonly tail: boolean }): void;
  /** Pulse the named request's row, when it is on screen. */
  flash(name: string, kind: PulseKind): void;
  /** The pool, in window order (tests assert rows are reused, not rebuilt). */
  readonly slots: readonly RowSlot[];
  /** True until the first rows or message replaced the skeleton. */
  readonly loading: boolean;
}

/** Skeleton line lengths: the header line, then request lines (fractions of their width). */
const SKELETON_HEADER = [0.45];
const SKELETON_REQUESTS = [0.82, 0.64, 0.9, 0.56];
/** Where a request row's badge starts: after the bar (1) and the guide (2). */
const REQUEST_INDENT = 3;

/** How long a develop runs, by what triggered it; `order` staggers it down the window. */
function developMs(plan: Exclude<DevelopPlan, null>, order: number): number {
  const step = Math.min(order, 10);
  if (plan === "all") return 240 + step * 24;
  if (plan === "moved") return 170 + step * 12;
  return 300 + step * 30;
}

function wantsDevelop(plan: DevelopPlan, slot: RowSlot, previousKey: string): boolean {
  if (plan === null) return false;
  if (plan === "all") return true;
  if (plan === "moved") return slot.key !== previousKey;
  return slot.name !== null && plan.has(slot.name);
}

export function createRowsView(
  renderer: CliRenderer,
  pane: BoxRenderable,
  onSelect: (name: string) => void,
): RowsView {
  const loadingBox = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0 });
  const skeletons = [
    skeletonLines(renderer, { lines: SKELETON_HEADER.length, width: "100%", widths: SKELETON_HEADER }),
    skeletonLines(renderer, { lines: SKELETON_REQUESTS.length, width: "100%", widths: SKELETON_REQUESTS }),
  ];
  const requestLines = new BoxRenderable(renderer, { width: "100%", paddingLeft: REQUEST_INDENT, flexShrink: 0 });
  const [headerSkeleton, requestSkeleton] = skeletons;
  if (headerSkeleton !== undefined) loadingBox.add(headerSkeleton);
  if (requestSkeleton !== undefined) requestLines.add(requestSkeleton);
  loadingBox.add(requestLines);

  const messageBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: "100%", visible: false });
  const list = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0, visible: false });
  const tail = halftoneTail(renderer);
  tail.visible = false;
  for (const child of [loadingBox, messageBox, list, tail]) pane.add(child);

  const pool: RowSlot[] = [];
  let loading = true;
  let seed = 0;

  /** The first real paint retires the skeleton for good. */
  const leaveLoading = (): void => {
    if (!loading) return;
    loading = false;
    for (const skeleton of skeletons) skeleton.stop();
    loadingBox.destroyRecursively();
  };

  const slotAt = (index: number): RowSlot => {
    let slot = pool[index];
    if (slot === undefined) {
      slot = new RowSlot(renderer, onSelect);
      pool.push(slot);
      list.add(slot.box);
    }
    return slot;
  };

  return {
    message(build) {
      leaveLoading();
      for (const slot of pool) slot.hide();
      list.visible = false;
      tail.visible = false;
      clearChildren(messageBox);
      build(messageBox);
      messageBox.visible = true;
    },
    rows(looks, opts) {
      leaveLoading();
      messageBox.visible = false;
      if (messageBox.getChildren().length > 0) clearChildren(messageBox);
      list.visible = true;
      let order = 0;
      for (const [index, look] of looks.entries()) {
        const slot = slotAt(index);
        const previousKey = slot.key;
        slot.show(look);
        if (opts.develop !== null && wantsDevelop(opts.develop, slot, previousKey)) {
          seed += 1;
          slot.develop(developMs(opts.develop, order), seed);
          order += 1;
        }
      }
      for (const slot of pool.slice(looks.length)) slot.hide();
      tail.visible = opts.tail;
    },
    flash(name, kind) {
      pool.find(slot => slot.name === name)?.flash(kind);
    },
    get slots(): readonly RowSlot[] {
      return pool;
    },
    get loading(): boolean {
      return loading;
    },
  };
}
